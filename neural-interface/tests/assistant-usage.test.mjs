process.env.SYNABUN_TYPESAFE = 'off';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  TOKEN_KEYS, addTokens, baseModel, claudeModelUsageTokens, claudeUsageTokens, cleanTokens, codexUsageTokens,
  createClaudeMeter, createCodexMeter, createOpenCodeMeter, createUsageLedger, maxTokens, openCodeTokens,
  readUsageLedgerFile, rowToTokens, subTokens, tokensToRow, totalTokens, usageLedgerPath, withTotal, zeroTokens,
} from '../lib/assistant-usage.js';

// Synthetic fixtures only: ids and numbers, never message text.

function tempDir(t, name) {
  const dir = mkdtempSync(resolve(tmpdir(), `synabun-usage-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const T = (input = 0, cacheWrite = 0, cacheRead = 0, output = 0, reasoning = 0) => ({ input, cacheWrite, cacheRead, output, reasoning });
const sum = (rows) => rows.reduce((total, row) => addTokens(total, row.tokens), zeroTokens());

// ── Tokens and normalizers ───────────────────────────────────────────────────

test('token helpers: five additive classes, clamped subtraction, totals', () => {
  assert.deepEqual(TOKEN_KEYS, ['input', 'cacheWrite', 'cacheRead', 'output', 'reasoning']);
  assert.deepEqual(zeroTokens(), T());
  assert.deepEqual(addTokens(T(1, 2, 3, 4, 5), T(10, 20, 30, 40, 50)), T(11, 22, 33, 44, 55));
  assert.deepEqual(subTokens(T(5, 5, 5, 5, 5), T(1, 9, 5, 0, 6)), T(4, 0, 0, 5, 0));
  assert.deepEqual(maxTokens(T(5, 1, 0, 9, 0), T(2, 7, 0, 3, 4)), T(5, 7, 0, 9, 4));
  assert.equal(totalTokens(T(1, 2, 3, 4, 5)), 15);
  // The two sides people read: input (uncached + cache write + cache read) and output (visible + reasoning).
  assert.deepEqual(withTotal(T(1, 2, 3, 4, 5)), { ...T(1, 2, 3, 4, 5), total: 15, inputTotal: 6, outputTotal: 9 });
  assert.deepEqual(cleanTokens({ input: -4, cacheRead: 2.9, output: 'x', reasoning: null }), T(0, 0, 2, 0, 0));
  assert.deepEqual(rowToTokens(tokensToRow(T(1, 2, 3, 4, 5))), T(1, 2, 3, 4, 5));
  assert.deepEqual(addTokens(null, undefined), T());
  assert.equal(baseModel('claude-opus-5-5[1m]'), 'claude-opus-5-5');
});

test('claudeUsageTokens splits thinking out of output and ignores every other key', () => {
  const usage = {
    input_tokens: 26, cache_creation_input_tokens: 105082, cache_read_input_tokens: 994155, output_tokens: 42082,
    output_tokens_details: { thinking_tokens: 28496 },
    server_tool_use: { web_search_requests: 3 }, iterations: [{ input_tokens: 999 }],
    cache_creation: { ephemeral_1h_input_tokens: 105082, ephemeral_5m_input_tokens: 0 }, fallback_credit: 77,
  };
  assert.deepEqual(claudeUsageTokens(usage), T(26, 105082, 994155, 13586, 28496));
  assert.equal(totalTokens(claudeUsageTokens(usage)), 26 + 105082 + 994155 + 42082);
  assert.deepEqual(claudeUsageTokens({ output_tokens: 10, output_tokens_details: { thinking_tokens: 50 } }), T(0, 0, 0, 0, 10), 'thinking is capped at output');
  assert.deepEqual(claudeUsageTokens(null), T());
});

test('claudeModelUsageTokens maps one SDK ModelUsage entry', () => {
  const entry = { inputTokens: 78, outputTokens: 56859, thinkingTokens: 34646, cacheReadInputTokens: 1938740, cacheCreationInputTokens: 311948, costUSD: 3.4, webSearchRequests: 2, contextWindow: 1000000 };
  assert.deepEqual(claudeModelUsageTokens(entry), T(78, 311948, 1938740, 22213, 34646));
  assert.deepEqual(claudeModelUsageTokens({ inputTokens: 5, outputTokens: 9 }), T(5, 0, 0, 9, 0), 'no thinkingTokens on old CLIs');
});

test('codexUsageTokens: input includes cached, output includes reasoning, both spellings', () => {
  const snake = { input_tokens: 23765, cached_input_tokens: 13952, cache_write_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 9, total_tokens: 23815 };
  assert.deepEqual(codexUsageTokens(snake), { tokens: T(9713, 100, 13952, 41, 9), mismatch: false });
  const camel = { inputTokens: 23765, cachedInputTokens: 13952, cacheWriteInputTokens: 100, outputTokens: 50, reasoningOutputTokens: 9, totalTokens: 23815 };
  assert.deepEqual(codexUsageTokens(camel), codexUsageTokens(snake));
  assert.equal(codexUsageTokens({ input_tokens: 10, output_tokens: 5 }).mismatch, false, 'no provider total, nothing to compare');
  assert.equal(codexUsageTokens({ ...snake, total_tokens: 24000 }).mismatch, true);
  assert.deepEqual(codexUsageTokens({ input_tokens: 5, cached_input_tokens: 9, output_tokens: 2, reasoning_output_tokens: 6 }).tokens, T(0, 0, 9, 0, 6), 'clamped at 0');
});

test('openCodeTokens maps the five classes directly', () => {
  assert.deepEqual(openCodeTokens({ input: 10, output: 20, reasoning: 3, cache: { read: 400, write: 50 } }), T(10, 50, 400, 20, 3));
  assert.deepEqual(openCodeTokens({ input: 1 }), T(1));
});

// ── Claude meter ─────────────────────────────────────────────────────────────

const OPUS = 'claude-opus-5-5[1m]';
const HAIKU = 'claude-haiku-4-5';
const mu = (inputTokens, outputTokens, thinkingTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD) => ({ inputTokens, outputTokens, thinkingTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD, webSearchRequests: 0, contextWindow: 1000000 });
const usageOf = (input, out, thinking, cacheRead, cacheWrite) => ({ input_tokens: input, output_tokens: out, output_tokens_details: { thinking_tokens: thinking }, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });
const result = (uuid, usage, modelUsage, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, uuid, session_id: 'sess-1', usage, modelUsage, ...extra });
const assistantMsg = (id, usage, { parent = null, model = 'claude-opus-5-5' } = {}) => ({ type: 'assistant', session_id: 'sess-1', parent_tool_use_id: parent, message: { id, model, usage } });

test('Claude meter: two results without sub-agents settle exactly result.usage', () => {
  const meter = createClaudeMeter();
  const first = meter.onEvent(result('r1', usageOf(10, 100, 40, 5000, 300), { [OPUS]: mu(10, 100, 40, 5000, 300, 0.5) })).settled;
  assert.deepEqual(first.tokens, T(10, 300, 5000, 60, 40));
  assert.deepEqual(first.main, first.tokens);
  assert.deepEqual(first.subagents, T());
  assert.equal(first.fidelity, 'exact');
  assert.equal(first.reason, null);
  assert.equal(first.source, 'claude-model-usage');
  assert.equal(first.resultUuid, 'r1');
  assert.equal(first.sessionId, 'sess-1');
  assert.equal(first.costUsd, 0.5);
  assert.deepEqual(first.byModel, [{ model: OPUS, tokens: T(10, 300, 5000, 60, 40), costUsd: 0.5 }]);
  assert.deepEqual(first.rows, [{ model: OPUS, part: 'main', tokens: T(10, 300, 5000, 60, 40), costUsd: 0.5 }]);

  // modelUsage is cumulative: the second turn is the difference.
  const second = meter.onEvent(result('r2', usageOf(4, 50, 10, 9000, 20), { [OPUS]: mu(14, 150, 50, 14000, 320, 0.8) })).settled;
  assert.deepEqual(second.tokens, T(4, 20, 9000, 40, 10));
  assert.deepEqual(second.main, second.tokens);
  assert.equal(second.costUsd, 0.3);
  assert.equal(totalTokens(second.subagents), 0);
});

test('Claude meter: sub-agents and helper models are the delta minus the main loop', () => {
  const meter = createClaudeMeter();
  meter.onEvent(assistantMsg('m1', usageOf(5, 1, 0, 1000, 100)));
  meter.onEvent(assistantMsg('s1', usageOf(20, 1, 0, 40000, 2000), { parent: 'toolu_1' }));
  const { settled } = meter.onEvent(result('r1', usageOf(5, 60, 20, 1000, 100), {
    [OPUS]: mu(25, 260, 70, 41000, 2100, 2),
    [HAIKU]: mu(900, 14, 0, 0, 0, 0.001),
  }));
  assert.deepEqual(settled.main, T(5, 100, 1000, 40, 20));
  assert.deepEqual(settled.tokens, T(925, 2100, 41000, 204, 70));
  assert.deepEqual(settled.subagents, subTokens(settled.tokens, settled.main));
  assert.equal(settled.costUsd, 2.001);
  assert.equal(settled.fidelity, 'exact');
  assert.deepEqual(settled.rows, [
    { model: OPUS, part: 'main', tokens: T(5, 100, 1000, 40, 20), costUsd: 2 },
    { model: OPUS, part: 'subagents', tokens: T(20, 2000, 40000, 150, 50), costUsd: null },
    { model: HAIKU, part: 'aux', tokens: T(900, 0, 0, 14, 0), costUsd: 0.001 },
  ]);
  assert.deepEqual(sum(settled.rows), settled.tokens, 'rows sum exactly to the turn');
});

test('Claude meter: a sub-agent on another model is booked as subagents, not aux', () => {
  const meter = createClaudeMeter();
  meter.onEvent(assistantMsg('m1', usageOf(5, 1, 0, 0, 0)));
  meter.onEvent(assistantMsg('s1', usageOf(7, 1, 0, 0, 0), { parent: 'toolu_1', model: HAIKU }));
  const { settled } = meter.onEvent(result('r1', usageOf(5, 10, 0, 0, 0), { [OPUS]: mu(5, 10, 0, 0, 0, 1), [HAIKU]: mu(7, 3, 0, 0, 0, 0.1) }));
  assert.deepEqual(settled.rows.map((row) => [row.model, row.part]), [[OPUS, 'main'], [HAIKU, 'subagents']]);
});

test('Claude meter: a counter that restarted counts in full', () => {
  const meter = createClaudeMeter();
  meter.onEvent(result('r1', usageOf(100, 500, 0, 90000, 4000), { [OPUS]: mu(100, 500, 0, 90000, 4000, 3), [HAIKU]: mu(50, 5, 0, 0, 0, 0.01) }));
  // /clear or a resumed process without saved totals: every counter is lower than its snapshot.
  const { settled } = meter.onEvent(result('r2', usageOf(7, 30, 0, 800, 60), { [OPUS]: mu(7, 30, 0, 800, 60, 0.2) }));
  assert.deepEqual(settled.tokens, T(7, 60, 800, 30, 0));
  assert.equal(settled.costUsd, 0.2);
  assert.equal(settled.fidelity, 'exact');
  // The snapshot is the new counter, and the model that did not come back is forgotten.
  assert.deepEqual(Object.keys(meter.state().snapshot), [OPUS]);
  const next = meter.onEvent(result('r3', usageOf(1, 5, 0, 100, 0), { [OPUS]: mu(8, 35, 0, 900, 60, 0.25), [HAIKU]: mu(20, 2, 0, 0, 0, 0.004) })).settled;
  assert.deepEqual(next.tokens, T(21, 0, 100, 7, 0));
});

test('Claude meter: a zeroed error result settles nothing and keeps the snapshot', () => {
  const meter = createClaudeMeter();
  meter.onEvent(result('r1', usageOf(10, 100, 0, 5000, 300), { [OPUS]: mu(10, 100, 0, 5000, 300, 0.5) }));
  const before = meter.state().snapshot;
  const zeroed = { [OPUS]: mu(0, 0, 0, 0, 0, 0) };
  assert.equal(meter.onEvent(result('e1', usageOf(0, 0, 0, 0, 0), zeroed, { subtype: 'error_during_execution', is_error: true })).settled, null);
  assert.equal(meter.onEvent({ type: 'result', subtype: 'error_during_execution', is_error: true, uuid: 'e2', usage: {} }).settled, null);
  assert.deepEqual(meter.state().snapshot, before);
  // The resumed session continues from the saved totals: only the new turn is settled.
  const next = meter.onEvent(result('r2', usageOf(2, 20, 0, 700, 0), { [OPUS]: mu(12, 120, 0, 5700, 300, 0.6) })).settled;
  assert.deepEqual(next.tokens, T(2, 0, 700, 20, 0));
  // An error result that did spend tokens settles like any other.
  const failed = meter.onEvent(result('e3', usageOf(1, 4, 0, 50, 0), { [OPUS]: mu(13, 124, 0, 5750, 300, 0.61) }, { subtype: 'error_during_execution', is_error: true })).settled;
  assert.deepEqual(failed.tokens, T(1, 0, 50, 4, 0));
});

test('Claude meter: a duplicate result uuid is settled once', () => {
  const meter = createClaudeMeter();
  const message = result('r1', usageOf(10, 100, 0, 5000, 300), { [OPUS]: mu(10, 100, 0, 5000, 300, 0.5) });
  assert.ok(meter.onEvent(message).settled);
  assert.deepEqual(meter.onEvent(message), { settled: null, pendingChanged: false });
  assert.deepEqual(meter.state().results, ['r1']);
  for (let i = 0; i < 30; i += 1) meter.onEvent(result(`n${i}`, usageOf(1, 1, 0, 0, 0), { [OPUS]: mu(11 + i, 101 + i, 0, 5000, 300, 0.5) }));
  assert.equal(meter.state().results.length, 20, 'only the last 20 uuids are kept');
});

test('Claude meter: history without a baseline settles the main loop only, as partial', () => {
  for (const meter of [createClaudeMeter({ state: { history: true } }), (() => { const m = createClaudeMeter(); m.expectHistory(); return m; })()]) {
    const first = meter.onEvent(result('r1', usageOf(10, 100, 40, 5000, 300), { [OPUS]: mu(900, 9000, 400, 900000, 30000, 40), [HAIKU]: mu(50, 5, 0, 0, 0, 0.01) })).settled;
    assert.deepEqual(first.tokens, T(10, 300, 5000, 60, 40));
    assert.deepEqual(first.tokens, first.main);
    assert.equal(first.fidelity, 'partial');
    assert.equal(first.reason, 'no-baseline');
    assert.equal(first.costUsd, null);
    assert.deepEqual(first.byModel, [{ model: OPUS, tokens: first.main, costUsd: null }]);
    assert.deepEqual(first.rows, [{ model: OPUS, part: 'main', tokens: first.main, costUsd: null }]);
    // The snapshot was taken: the next turn is exact again.
    const second = meter.onEvent(result('r2', usageOf(4, 50, 10, 9000, 20), { [OPUS]: mu(904, 9050, 410, 909000, 30020, 40.3), [HAIKU]: mu(50, 5, 0, 0, 0, 0.01) })).settled;
    assert.equal(second.fidelity, 'exact');
    assert.deepEqual(second.tokens, T(4, 20, 9000, 40, 10));
  }
  const noModelUsage = createClaudeMeter().onEvent({ type: 'result', subtype: 'success', uuid: 'r9', usage: usageOf(3, 9, 0, 0, 0) }).settled;
  assert.equal(noModelUsage.reason, 'no-model-usage');
  assert.deepEqual(noModelUsage.tokens, T(3, 0, 0, 9, 0));
  assert.equal(noModelUsage.byModel[0].model, 'unknown');
});

test('Claude meter: a restart hidden above the snapshot is raised to the main loop and flagged', () => {
  const meter = createClaudeMeter();
  meter.onEvent(result('r1', usageOf(10, 100, 0, 5000, 300), { [OPUS]: mu(10, 100, 0, 5000, 300, 0.5) }));
  // The counter began again at zero and already passed the snapshot: the delta alone would lose part of this turn.
  const { settled } = meter.onEvent(result('r2', usageOf(30, 400, 0, 20000, 900), { [OPUS]: mu(30, 400, 0, 20000, 900, 1.5) }));
  assert.deepEqual(settled.tokens, T(30, 900, 20000, 400, 0));
  assert.equal(settled.fidelity, 'partial');
  assert.equal(settled.reason, 'counter-mismatch');
  assert.deepEqual(sum(settled.rows), settled.tokens);
});

test('Claude meter: pending grows from assistant and stream events and clears on the result', () => {
  const meter = createClaudeMeter();
  assert.deepEqual(meter.pending(), { tokens: T(), byModel: [] });
  // The assistant message carries exact input-side fields and a stale early output value.
  assert.equal(meter.onEvent(assistantMsg('m1', usageOf(5, 2, 0, 1000, 100))).pendingChanged, true);
  assert.equal(meter.onEvent(assistantMsg('m1', usageOf(5, 2, 0, 1000, 100))).pendingChanged, false, 'one message, several content blocks');
  assert.deepEqual(meter.pending().tokens, T(5, 100, 1000, 2, 0));
  // message_delta carries the cumulative output of the message open under that parent.
  meter.onEvent({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm2', model: 'claude-opus-5-5', usage: { input_tokens: 3, cache_read_input_tokens: 1100, output_tokens: 1 } } } });
  assert.equal(meter.onEvent({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', usage: { output_tokens: 250 } } }).pendingChanged, true);
  assert.equal(meter.onEvent({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', usage: { output_tokens: 250 } } }).pendingChanged, false);
  // A sub-agent call streams under its own parent and does not disturb the main message.
  meter.onEvent({ type: 'stream_event', parent_tool_use_id: 'toolu_1', event: { type: 'message_start', message: { id: 's1', model: HAIKU, usage: { input_tokens: 40, output_tokens: 1 } } } });
  meter.onEvent({ type: 'stream_event', parent_tool_use_id: 'toolu_1', event: { type: 'message_delta', usage: { output_tokens: 30 } } });
  meter.onEvent({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', usage: { output_tokens: 300 } } });
  const pending = meter.pending();
  assert.deepEqual(pending.tokens, T(48, 100, 2100, 332, 0));
  assert.deepEqual(pending.byModel, [{ model: 'claude-opus-5-5', tokens: T(8, 100, 2100, 302, 0) }, { model: HAIKU, tokens: T(40, 0, 0, 30, 0) }]);

  const done = meter.onEvent(result('r1', usageOf(8, 302, 0, 2100, 100), { [OPUS]: mu(8, 302, 0, 2100, 100, 0.2), [HAIKU]: mu(40, 30, 0, 0, 0, 0.01) }));
  assert.equal(done.pendingChanged, true);
  assert.deepEqual(meter.pending(), { tokens: T(), byModel: [] });
  assert.equal(meter.state().pending, undefined, 'the estimate is not part of the persisted state');
});

test('Claude meter: state round trip and reset', () => {
  const meter = createClaudeMeter();
  meter.onEvent(result('r1', usageOf(10, 100, 0, 5000, 300), { [OPUS]: mu(10, 100, 0, 5000, 300, 0.5) }));
  const state = JSON.parse(JSON.stringify(meter.state()));
  assert.deepEqual(Object.keys(state).sort(), ['history', 'results', 'sessionId', 'snapshot', 'unbaselined']);
  assert.equal(state.sessionId, 'sess-1');

  const resumed = createClaudeMeter({ state });
  assert.equal(resumed.onEvent(result('r1', usageOf(10, 100, 0, 5000, 300), { [OPUS]: mu(10, 100, 0, 5000, 300, 0.5) })).settled, null, 'the uuid memory survives');
  assert.deepEqual(resumed.onEvent(result('r2', usageOf(1, 9, 0, 40, 0), { [OPUS]: mu(11, 109, 0, 5040, 300, 0.55) })).settled.tokens, T(1, 0, 40, 9, 0));

  // A fresh, non-resumed process counts from zero: after reset() its first result is taken whole.
  resumed.reset();
  assert.equal(resumed.state().snapshot, null);
  assert.deepEqual(resumed.onEvent(result('r3', usageOf(50, 900, 0, 70000, 0), { [OPUS]: mu(50, 900, 0, 70000, 0, 1) })).settled.tokens, T(50, 0, 70000, 900, 0));
});

// ── Codex meter ──────────────────────────────────────────────────────────────

const ROOT = '01a00000-0000-7000-8000-000000000001';
const CHILD = '01a00000-0000-7000-8000-000000000002';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');

function dayDir(home, ms = NOW) {
  const d = new Date(ms);
  const dir = join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  return dir;
}
const iso = (offsetMs = 0) => new Date(NOW - 3_600_000 + offsetMs).toISOString();
const codexUsage = (input, cached, output, reasoning) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });
const line = (entry) => `${JSON.stringify(entry)}\n`;
const meta = (id, sessionId = id, at = 0) => line({ timestamp: iso(at), type: 'session_meta', payload: { session_id: sessionId, id, thread_source: id === sessionId ? 'user' : 'subagent', cli_version: '0.156.1' } });
const turnContext = (turnId, model = 'gpt-6-sol', at = 0) => line({ timestamp: iso(at), type: 'turn_context', payload: { turn_id: turnId, model } });
const record = (threadId, turnId, responseId, usage, at = 0) => line({ timestamp: iso(at), type: 'token_usage_record', payload: { thread_id: threadId, session_id: ROOT, turn_id: turnId, root_turn_id: turnId, response_id: responseId, usage } });
const tokenCount = (total, last, at = 0) => line({ timestamp: iso(at), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } });
const rolloutPath = (dir, threadId, stamp = '2026-10-01T08-00-00') => join(dir, `rollout-${stamp}-${threadId}.jsonl`);

test('Codex meter: two turns of one rollout across two polls, never counted twice', (t) => {
  const home = tempDir(t, 'codex-turns');
  const path = rolloutPath(dayDir(home), ROOT);
  const meter = createCodexMeter({ codexHome: home, threadId: ROOT, now: () => NOW });
  assert.deepEqual(meter.poll(), [], 'a missing rollout is not an error');

  writeFileSync(path, meta(ROOT) + turnContext('turn-1')
    + record(ROOT, 'turn-1', 'resp-1', codexUsage(1000, 0, 100, 30), 1000)
    + tokenCount(codexUsage(1000, 0, 100, 30), codexUsage(1000, 0, 100, 30), 1001)
    + record(ROOT, 'turn-1', 'resp-2', codexUsage(2000, 900, 50, 10), 2000)
    + JSON.stringify({ timestamp: iso(3000), type: 'token_usage_record' }).slice(0, 40)); // a line still being written
  const first = meter.poll();
  assert.deepEqual(first, [{
    threadId: ROOT, part: 'main', turnId: 'turn-1', model: 'gpt-6-sol',
    tokens: T(2100, 0, 900, 110, 40),
    usage: { input_tokens: 3000, cached_input_tokens: 900, cache_write_input_tokens: 0, output_tokens: 150, reasoning_output_tokens: 40, total_tokens: 3150 },
    responses: 2, mismatches: 0, fidelity: 'exact', reason: null, source: 'codex-records',
  }]);
  assert.deepEqual(meter.poll(), [], 'nothing new, nothing returned');

  // The follow-up turn of the same thread appends to the same file.
  const head = readFileSync(path, 'utf8');
  writeFileSync(path, head.slice(0, head.lastIndexOf('\n') + 1) + turnContext('turn-2', 'gpt-6-sol', 4000)
    + record(ROOT, 'turn-2', 'resp-3', codexUsage(5000, 4000, 20, 0), 5000)
    + record(ROOT, 'turn-2', 'resp-2', codexUsage(2000, 900, 50, 10), 5001)); // a repeated response id
  const second = meter.poll();
  assert.equal(second.length, 1);
  assert.equal(second[0].turnId, 'turn-2');
  assert.equal(second[0].responses, 1);
  assert.deepEqual(second[0].tokens, T(1000, 0, 4000, 20, 0));
  assert.deepEqual(meter.rollouts(), [{ path, threadId: ROOT, part: 'main' }]);
});

test('Codex meter: the compaction call is counted although token_count omits it', (t) => {
  const home = tempDir(t, 'codex-compact');
  writeFileSync(rolloutPath(dayDir(home), ROOT), meta(ROOT) + turnContext('turn-1')
    + record(ROOT, 'turn-1', 'resp-1', codexUsage(1000, 0, 100, 0), 1000)
    + tokenCount(codexUsage(1000, 0, 100, 0), codexUsage(1000, 0, 100, 0), 1001)
    + record(ROOT, 'turn-1', 'resp-compact', codexUsage(240000, 0, 3000, 0), 2000) // no token_count follows it
    + record(ROOT, 'turn-1', 'resp-2', codexUsage(4000, 0, 40, 0), 3000)
    + tokenCount(codexUsage(5000, 0, 140, 0), codexUsage(4000, 0, 40, 0), 3001));
  const rows = createCodexMeter({ codexHome: home, threadId: ROOT, now: () => NOW }).poll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].responses, 3);
  assert.equal(rows[0].usage.input_tokens, 245000, 'more than the 5000 the token_count total reports');
  assert.equal(rows[0].source, 'codex-records');
});

test('Codex meter: a child rollout is booked as subagents and a replayed parent record is skipped', (t) => {
  const home = tempDir(t, 'codex-child');
  const dir = dayDir(home);
  writeFileSync(rolloutPath(dir, ROOT), meta(ROOT) + turnContext('turn-1') + record(ROOT, 'turn-1', 'resp-1', codexUsage(1000, 0, 100, 0), 1000));
  // An old CLI replays the parent's history inside the forked child: the same record again, under the parent's thread id.
  writeFileSync(rolloutPath(dir, CHILD, '2026-10-01T08-00-30'), meta(CHILD, ROOT, 1500) + meta(ROOT, ROOT, 1500)
    + record(ROOT, 'turn-1', 'resp-parent-replayed', codexUsage(1000, 0, 100, 0), 1500)
    + turnContext('child-turn-1', 'gpt-6-mini', 1600)
    + record(CHILD, 'child-turn-1', 'resp-c1', codexUsage(700, 200, 70, 20), 2000));
  // Another thread's rollout in the same folder is not ours.
  const other = '01a00000-0000-7000-8000-00000000ffff';
  writeFileSync(rolloutPath(dir, other, '2026-10-01T08-01-00'), meta(other) + record(other, 'x', 'resp-x', codexUsage(9, 0, 9, 0), 2000));

  const meter = createCodexMeter({ codexHome: home, threadId: ROOT, now: () => NOW });
  const rows = meter.poll();
  assert.deepEqual(rows.map((row) => [row.threadId, row.part, row.turnId, row.model, row.responses]), [
    [ROOT, 'main', 'turn-1', 'gpt-6-sol', 1],
    [CHILD, 'subagents', 'child-turn-1', 'gpt-6-mini', 1],
  ]);
  assert.deepEqual(rows[1].tokens, T(500, 0, 200, 50, 20));
  assert.deepEqual(meter.rollouts().map((file) => file.part), ['main', 'subagents']);
  assert.deepEqual(meter.poll(), []);
});

test('Codex meter: the token_count fallback for a rollout without records, repeats skipped', (t) => {
  const home = tempDir(t, 'codex-fallback');
  const one = codexUsage(1000, 0, 100, 30);
  const two = codexUsage(2000, 900, 50, 10);
  writeFileSync(rolloutPath(dayDir(home), ROOT), meta(ROOT) + turnContext('turn-1')
    + line({ timestamp: iso(500), type: 'event_msg', payload: { type: 'token_count', info: null } })
    + tokenCount(one, one, 1000)
    + tokenCount(one, one, 1001) // Codex repeats the event; the running total did not move
    + tokenCount(codexUsage(3000, 900, 150, 40), two, 2000));
  const rows = createCodexMeter({ codexHome: home, threadId: ROOT, now: () => NOW }).poll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fidelity, 'partial');
  assert.equal(rows[0].reason, 'codex-no-records');
  assert.equal(rows[0].source, 'codex-token-count');
  assert.equal(rows[0].responses, 2);
  assert.deepEqual(rows[0].tokens, T(2100, 0, 900, 110, 40));
  assert.equal(rows[0].turnId, 'turn-1');
});

test('Codex meter: state round trip and sinceMs', (t) => {
  const home = tempDir(t, 'codex-state');
  const path = rolloutPath(dayDir(home), ROOT);
  writeFileSync(path, meta(ROOT) + turnContext('turn-1') + record(ROOT, 'turn-1', 'resp-1', codexUsage(1000, 0, 100, 0), 1000));
  const first = createCodexMeter({ codexHome: home, threadId: ROOT, now: () => NOW });
  assert.equal(first.poll().length, 1);
  const state = JSON.parse(JSON.stringify(first.state()));
  assert.deepEqual(Object.keys(state), ['files', 'seen']);
  assert.equal(state.files[path].threadId, ROOT);
  assert.equal(state.files[path].offset, readFileSync(path).length);
  assert.deepEqual(state.seen, ['resp-1']);

  appendFileSync(path, record(ROOT, 'turn-1', 'resp-2', codexUsage(500, 0, 5, 0), 2000));
  const resumed = createCodexMeter({ codexHome: home, threadId: ROOT, now: () => NOW, state });
  const rows = resumed.poll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].responses, 1, 'only what came after the saved offset');
  assert.equal(rows[0].model, 'gpt-6-sol', 'the model survives in the state');
  // Without the state the whole file is read again, and without the offset the seen ids still stop a double count.
  const replayed = createCodexMeter({ codexHome: home, threadId: ROOT, now: () => NOW, state: { files: {}, seen: state.seen } });
  assert.equal(replayed.poll()[0].responses, 1);

  // sinceMs: usage older than the run's start belongs to someone else.
  const late = createCodexMeter({ codexHome: home, threadId: ROOT, now: () => NOW, sinceMs: NOW - 3_600_000 + 1500 });
  const lateRows = late.poll();
  assert.equal(lateRows.length, 1);
  assert.deepEqual(lateRows[0].tokens, T(500, 0, 0, 5, 0));
});

test('Codex meter: a thread that began long before sinceMs is still found by name', (t) => {
  const home = tempDir(t, 'codex-old-root');
  // The rollout stays in the folder of the day the thread began, ten days before this run.
  const path = rolloutPath(dayDir(home, NOW - 10 * 86_400_000), ROOT, '2026-09-21T08-00-00');
  writeFileSync(path, meta(ROOT) + turnContext('turn-old')
    + line({ timestamp: new Date(NOW - 10 * 86_400_000).toISOString(), type: 'token_usage_record', payload: { thread_id: ROOT, turn_id: 'turn-old', response_id: 'resp-old', usage: codexUsage(900, 0, 90, 0) } })
    + turnContext('turn-new', 'gpt-6-sol', 1000)
    + record(ROOT, 'turn-new', 'resp-new', codexUsage(40, 0, 4, 0), 2000));
  const rows = createCodexMeter({ codexHome: home, threadId: ROOT, now: () => NOW, sinceMs: NOW - 3_600_000 }).poll();
  assert.deepEqual(rows.map((row) => [row.turnId, row.responses, totalTokens(row.tokens)]), [['turn-new', 1, 44]]);
});

// ── OpenCode meter ───────────────────────────────────────────────────────────

const ocInfo = (sessionID, id, tokens, extra = {}) => ({ id, sessionID, role: 'assistant', modelID: 'big-pickle', providerID: 'opencode', cost: 0, tokens: { input: tokens[0], output: tokens[3], reasoning: tokens[4], cache: { write: tokens[1], read: tokens[2] } }, ...extra });

test('OpenCode meter: a growing snapshot keeps the per-class maximum, both event spellings', () => {
  const meter = createOpenCodeMeter();
  meter.setRoot('ses_root');
  assert.equal(meter.onEvent('message.updated', { info: ocInfo('ses_root', 'msg_1', [100, 0, 0, 0, 0]) }), true);
  assert.equal(meter.onEvent('message:updated', { message: { info: ocInfo('ses_root', 'msg_1', [100, 20, 900, 40, 5], { cost: 0.01 }) } }), true);
  assert.equal(meter.onEvent('message.updated', { properties: { info: ocInfo('ses_root', 'msg_1', [100, 20, 900, 40, 5], { cost: 0.01 }) } }), false, 'the same snapshot again');
  // A reverted message reports less; it was still paid for.
  assert.equal(meter.onEvent('message.updated', { info: ocInfo('ses_root', 'msg_1', [0, 0, 0, 0, 0]) }), false);
  assert.equal(meter.onEvent('message.updated', { info: { ...ocInfo('ses_root', 'msg_u', [999, 0, 0, 0, 0]), role: 'user' } }), false, 'assistant messages only');
  assert.equal(meter.onEvent('message.part.updated', { info: ocInfo('ses_root', 'msg_2', [7, 0, 0, 0, 0]) }), false);
  assert.deepEqual(meter.total(), {
    tokens: T(100, 20, 900, 40, 5), costUsd: 0.01, main: T(100, 20, 900, 40, 5), subagents: T(),
    byModel: [{ provider: 'opencode', model: 'big-pickle', tokens: T(100, 20, 900, 40, 5) }],
  });
});

test('OpenCode meter: a child session is subagents, markTurn returns deltas', () => {
  const meter = createOpenCodeMeter();
  meter.setRoot('ses_root');
  meter.onEvent('message.updated', { info: ocInfo('ses_root', 'msg_1', [100, 0, 0, 40, 0], { cost: 0.5 }) });
  meter.onEvent('session.created', { info: { id: 'ses_child', parentID: 'ses_root' } });
  meter.onEvent('message.updated', { info: ocInfo('ses_child', 'msg_c1', [30, 0, 500, 9, 1], { modelID: 'small', cost: 0.25 }) });
  assert.deepEqual(meter.live().tokens, T(130, 0, 500, 49, 1), 'the turn in progress');
  const first = meter.markTurn();
  assert.deepEqual(first.main, T(100, 0, 0, 40, 0));
  assert.deepEqual(first.subagents, T(30, 0, 500, 9, 1));
  assert.deepEqual(first.tokens, T(130, 0, 500, 49, 1));
  assert.equal(first.costUsd, 0.75);
  assert.deepEqual(first.byModel.map((row) => [row.model, totalTokens(row.tokens)]), [['small', 540], ['big-pickle', 140]]);
  assert.equal(totalTokens(meter.markTurn().tokens), 0, 'nothing since the mark');

  meter.onEvent('message.updated', { info: ocInfo('ses_root', 'msg_2', [10, 0, 100, 5, 0], { cost: 0.1 }) });
  meter.onEvent('message.updated', { info: ocInfo('ses_child', 'msg_c1', [30, 0, 500, 19, 1], { modelID: 'small', cost: 0.3 }) });
  const second = meter.markTurn();
  assert.deepEqual(second.main, T(10, 0, 100, 5, 0));
  assert.deepEqual(second.subagents, T(0, 0, 0, 10, 0));
  assert.equal(second.costUsd, 0.15);
  assert.deepEqual(meter.total().tokens, T(140, 0, 600, 64, 1), 'total() is not moved by the mark');
});

test('OpenCode meter: reconcile merges a missed message of a descendant', async () => {
  const meter = createOpenCodeMeter();
  meter.setRoot('ses_root');
  meter.onEvent('message.updated', { info: ocInfo('ses_root', 'msg_1', [100, 0, 0, 10, 0]) });
  const asked = [];
  const fetchers = {
    children: async (sessionId) => { asked.push(sessionId); return sessionId === 'ses_root' ? [{ id: 'ses_child' }] : sessionId === 'ses_child' ? ['ses_grandchild'] : []; },
    messages: async (sessionId) => ({
      ses_root: [{ info: ocInfo('ses_root', 'msg_1', [100, 0, 0, 40, 0]) }, { info: { id: 'msg_u', sessionID: 'ses_root', role: 'user' } }],
      ses_child: [ocInfo('ses_child', 'msg_c1', [30, 0, 0, 3, 0])],
      ses_grandchild: [{ info: { ...ocInfo('', 'msg_g1', [7, 0, 0, 1, 0]), sessionID: undefined } }],
    }[sessionId] || []),
  };
  assert.equal(await meter.reconcile(fetchers), true);
  assert.deepEqual(asked, ['ses_root', 'ses_child', 'ses_grandchild']);
  assert.deepEqual(meter.total().main, T(100, 0, 0, 40, 0), 'the final snapshot raised the output');
  assert.deepEqual(meter.total().subagents, T(37, 0, 0, 4, 0));
  assert.equal(await meter.reconcile(fetchers), false, 'nothing new the second time');
  assert.equal(await meter.reconcile({ children: async () => { throw new Error('down'); }, messages: async () => { throw new Error('down'); } }), false);
});

test('OpenCode meter: state round trip stays small and never double counts an old message', () => {
  const meter = createOpenCodeMeter();
  meter.setRoot('ses_root');
  for (let i = 0; i < 2100; i += 1) meter.onEvent('message.updated', { info: ocInfo('ses_root', `msg_${String(i).padStart(6, '0')}`, [1, 0, 0, 1, 0], { cost: 0.001 }) });
  meter.onEvent('message.updated', { info: ocInfo('ses_child', 'msg_c1', [5, 0, 0, 5, 0]) });
  meter.markTurn();
  const state = JSON.parse(JSON.stringify(meter.state()));
  assert.equal(state.entries, undefined);
  assert.equal(state.sessions.ses_root.upTo, 'msg_002099');
  assert.ok(JSON.stringify(state).length < 2000);
  const resumed = createOpenCodeMeter({ state });
  assert.deepEqual(resumed.total(), meter.total());
  assert.equal(totalTokens(resumed.total().tokens), 4210);
  assert.equal(resumed.total().costUsd, 2.1);
  assert.equal(totalTokens(resumed.markTurn().tokens), 0, 'the mark survives');
  assert.equal(resumed.onEvent('message.updated', { info: ocInfo('ses_root', 'msg_000050', [1, 0, 0, 1, 0]) }), false, 'an old message is not added again');
  assert.equal(resumed.onEvent('message.updated', { info: ocInfo('ses_root', 'msg_002100', [1, 0, 0, 4, 0]) }), true, 'a new message is counted');
});

// ── Ledger ───────────────────────────────────────────────────────────────────

function ledgerHarness(t, options = {}) {
  const dataDir = tempDir(t, 'ledger');
  const clock = { now: 1_000 };
  const logs = [];
  const make = (extra = {}) => createUsageLedger({ dataDir, now: () => clock.now, log: (event, detail) => logs.push([event, detail]), ...options, ...extra });
  return { dataDir, clock, logs, make, ledger: make() };
}
const S = 'assistant-s1';

test('ledger: tasks are numbered from 1, ensureTask creates task-0 only when there is none', (t) => {
  const { ledger, clock, dataDir } = ledgerHarness(t);
  assert.equal(ledger.currentTask(S), null);
  assert.deepEqual(ledger.taskView(S), { sessionId: S, task: null, session: { tokens: withTotal(T()), pending: withTotal(T()), costUsd: 0, costBasis: null, live: false, fidelity: 'exact', tasks: 0, unsynced: 0, models: [] }, recent: [] });
  assert.equal(existsSync(usageLedgerPath(dataDir, S)), false, 'reading creates nothing');
  assert.deepEqual(ledger.ensureTask(S), { id: 'task-0', n: 0, title: null, startedAt: 1000 });
  clock.now = 2000;
  assert.deepEqual(ledger.beginTask(S, { title: '  first prompt  ' }), { id: 'task-1', n: 1 });
  assert.deepEqual(ledger.currentTask(S), { id: 'task-1', n: 1, title: 'first prompt', startedAt: 2000 });
  assert.deepEqual(ledger.ensureTask(S), ledger.currentTask(S));
  assert.deepEqual(ledger.beginTask(S, { title: 'second', at: 5000 }), { id: 'task-2', n: 2 });
  assert.equal(ledger.currentTask(S).startedAt, 5000);
  assert.equal(ledger.beginTask('../x', {}).id, 'task-1', 'a hostile id is flattened into a file name');
  assert.equal(ledger.beginTask('', {}), null);
  assert.throws(() => createUsageLedger({}), /dataDir/);
});

test('ledger: settle, pending and the task view', (t) => {
  const { ledger, dataDir } = ledgerHarness(t);
  const seen = [];
  const unsubscribe = ledger.subscribe((sessionId) => seen.push(sessionId));
  const task = ledger.beginTask(S, { title: 'build it' });
  assert.equal(seen.length, 1);

  assert.equal(ledger.settle({ sessionId: S, scope: 'brain', provider: 'claude-code', model: 'opus', part: 'main', tokens: T() }), null, 'zero tokens and no cost: dropped');
  const row = ledger.settle({ sessionId: S, taskId: task.id, scope: 'brain', turn: 1, provider: 'claude-code', model: 'opus', part: 'main', tokens: T(10, 100, 1000, 50, 20), costUsd: 0.5, costBasis: 'reported', fidelity: 'exact', source: 'claude-model-usage' });
  assert.deepEqual(row, { t: 'use', at: 1000, task: 'task-1', scope: 'brain', run: null, turn: 1, provider: 'claude-code', model: 'opus', part: 'main', tokens: [10, 100, 1000, 50, 20], cost: 0.5, basis: 'reported', fid: 'exact', why: null, src: 'claude-model-usage' });
  ledger.settle({ sessionId: S, scope: 'brain', provider: 'claude-code', model: 'haiku', part: 'aux', tokens: T(900, 0, 0, 14, 0), costUsd: 0.001 });
  // A run on Codex, with a sub-agent thread, settled against the task it was dispatched in.
  ledger.settle({ sessionId: S, taskId: task.id, scope: 'run', runId: 'run-a', turn: 1, provider: 'codex', model: 'gpt-6-sol', part: 'main', tokens: T(2000, 0, 900, 100, 40), costUsd: 0.02, costBasis: 'estimated', source: 'codex-records' });
  ledger.settle({ sessionId: S, taskId: task.id, scope: 'run', runId: 'run-a', provider: 'codex', model: 'gpt-6-mini', part: 'subagents', tokens: [500, 0, 200, 50, 20], source: 'codex-records' });
  assert.equal(seen.length, 5);

  // Provisional tokens of turns still running.
  assert.equal(ledger.setPending(S, 'brain', { provider: 'claude-code', model: 'opus', tokens: T(5, 0, 300, 7, 0) }), true);
  assert.equal(ledger.setPending(S, 'brain', { provider: 'claude-code', model: 'opus', tokens: T(5, 0, 300, 7, 0) }), false, 'unchanged: no notification');
  assert.equal(ledger.setPending(S, 'run-b', { runId: 'run-b', provider: 'opencode', model: 'big-pickle', tokens: T(40, 0, 0, 2, 0) }), true);
  assert.equal(seen.length, 7);

  const view = ledger.taskView(S);
  assert.deepEqual(Object.keys(view), ['sessionId', 'task', 'session', 'recent']);
  assert.deepEqual(Object.keys(view.task), ['id', 'n', 'title', 'startedAt', 'live', 'fidelity', 'tokens', 'pending', 'costUsd', 'costBasis', 'agents', 'models']);
  assert.deepEqual(Object.keys(view.session), ['tokens', 'pending', 'costUsd', 'costBasis', 'live', 'fidelity', 'tasks', 'unsynced', 'models']);
  assert.equal(view.task.id, 'task-1');
  assert.equal(view.task.title, 'build it');
  assert.equal(view.task.live, true);
  assert.equal(view.task.fidelity, 'live');
  assert.deepEqual(view.task.pending, withTotal(T(45, 0, 300, 9, 0)));
  assert.deepEqual(view.task.tokens, withTotal(T(3455, 100, 2400, 223, 80)), 'settled + pending');
  assert.equal(view.task.costUsd, 0.521);
  assert.deepEqual(view.task.agents.map((agent) => agent.key), ['brain', 'run-a', 'run-b'], 'brain first, then runs in first-seen order');
  assert.deepEqual(view.task.agents[0], {
    key: 'brain', scope: 'brain', runId: null, provider: 'claude-code', model: 'opus',
    tokens: withTotal(T(915, 100, 1300, 71, 20)), pending: withTotal(T(5, 0, 300, 7, 0)), subagents: { total: 0 }, fidelity: 'live', partialReason: null,
  });
  assert.deepEqual(view.task.agents[1], {
    key: 'run-a', scope: 'run', runId: 'run-a', provider: 'codex', model: 'gpt-6-sol',
    tokens: withTotal(T(2500, 0, 1100, 150, 60)), pending: withTotal(T()), subagents: { total: 770 }, fidelity: 'exact', partialReason: null,
  });
  assert.equal(view.task.agents[2].fidelity, 'live');
  assert.equal(view.task.agents[2].model, 'big-pickle');
  assert.deepEqual(view.task.models.map((model) => [model.provider, model.model, model.tokens.total]), [
    ['codex', 'gpt-6-sol', 3040], ['claude-code', 'opus', 1492], ['claude-code', 'haiku', 914], ['codex', 'gpt-6-mini', 770], ['opencode', 'big-pickle', 42],
  ]);
  // One task so far: the session headline is that task, per class, per model and in dollars.
  assert.deepEqual(view.session, {
    tokens: view.task.tokens, pending: view.task.pending, costUsd: 0.521, costBasis: view.task.costBasis, live: view.task.live, fidelity: view.task.fidelity,
    tasks: 1, unsynced: 0, models: view.task.models,
  });
  assert.deepEqual(view.recent, []);

  // Settling books the provisional tokens: that agent's pending is cleared, another agent's is not.
  ledger.settle({ sessionId: S, scope: 'brain', provider: 'claude-code', model: 'opus', part: 'main', tokens: T(5, 0, 300, 9, 0) });
  const after = ledger.taskView(S);
  assert.deepEqual(after.task.agents[0].pending, withTotal(T()));
  assert.deepEqual(after.task.pending, withTotal(T(40, 0, 0, 2, 0)));
  // An aux row does not touch a running turn's estimate.
  ledger.settle({ sessionId: S, scope: 'run', runId: 'run-b', provider: 'opencode', model: 'helper', part: 'aux', tokens: T(1, 0, 0, 1, 0) });
  assert.equal(ledger.taskView(S).task.live, true);
  assert.equal(ledger.clearPending(S, 'run-b'), true);
  assert.equal(ledger.clearPending(S, 'run-b'), false);
  const settled = ledger.taskView(S);
  assert.equal(settled.task.live, false);
  assert.equal(settled.task.fidelity, 'exact');
  assert.deepEqual(settled.task.pending, withTotal(T()));

  unsubscribe();
  const count = seen.length;
  ledger.settle({ sessionId: S, scope: 'brain', provider: 'claude-code', model: 'opus', part: 'main', tokens: T(1) });
  assert.equal(seen.length, count, 'unsubscribed');

  // Pending never reaches the file.
  const file = readUsageLedgerFile(usageLedgerPath(dataDir, S));
  assert.equal(file.tasks.length, 1);
  assert.equal(file.rows.length, 7);
  assert.equal(file.corrupt, 0);
});

test('ledger: fidelity is live, then partial, then exact; views across tasks and runs', (t) => {
  const { ledger, clock } = ledgerHarness(t);
  const first = ledger.beginTask(S, { title: 'one' });
  ledger.settle({ sessionId: S, scope: 'brain', provider: 'claude-code', model: 'opus', part: 'main', tokens: T(10, 0, 0, 5, 0), costUsd: 0.1 });
  ledger.settle({ sessionId: S, scope: 'run', runId: 'run-a', provider: 'codex', model: 'gpt-6-sol', part: 'main', tokens: T(100, 0, 0, 5, 0), fidelity: 'partial', reason: 'codex-no-records', source: 'codex-token-count' });
  clock.now = 9000;
  const second = ledger.beginTask(S, { title: 'two' });
  ledger.settle({ sessionId: S, scope: 'brain', provider: 'claude-code', model: 'opus', part: 'main', tokens: T(20, 0, 0, 5, 0), costUsd: 0.2 });
  // The run dispatched in the first task keeps settling there, and works on in the second.
  ledger.settle({ sessionId: S, taskId: first.id, scope: 'run', runId: 'run-a', provider: 'codex', model: 'gpt-6-sol', part: 'subagents', tokens: T(50, 0, 0, 5, 0) });
  ledger.settle({ sessionId: S, taskId: second.id, scope: 'run', runId: 'run-a', provider: 'codex', model: 'gpt-6-sol', part: 'main', tokens: T(7, 0, 0, 1, 0) });
  ledger.settle({ sessionId: S, taskId: 'task-404', scope: 'run', runId: 'run-c', provider: 'codex', model: 'gpt-6-sol', part: 'main', tokens: T(1) });

  const old = ledger.taskView(S, first.id);
  assert.equal(old.task.fidelity, 'partial');
  assert.equal(old.task.agents[1].fidelity, 'partial');
  assert.equal(old.task.agents[1].partialReason, 'codex-no-records');
  assert.equal(old.task.agents[0].fidelity, 'exact');
  assert.equal(old.task.tokens.total, 175);
  assert.deepEqual(old.recent, [{ id: 'task-2', n: 2, title: 'two', total: 34, inputTotal: 28, outputTotal: 6, costUsd: 0.2, fidelity: 'exact', live: false }]);

  const current = ledger.taskView(S);
  assert.equal(current.task.id, 'task-2');
  assert.equal(current.task.fidelity, 'exact');
  assert.deepEqual(current.task.agents.map((agent) => agent.key), ['brain', 'run-a', 'run-c'], 'an unknown task id falls back to the current task');
  assert.deepEqual(current.recent.map((task) => [task.id, task.fidelity]), [['task-1', 'partial']]);
  assert.equal(current.session.tokens.total, 209);
  assert.equal(current.session.tasks, 2);
  assert.equal(ledger.taskView(S, 'task-9').task, null);

  ledger.setPending(S, 'run-a', { taskId: first.id, runId: 'run-a', provider: 'codex', model: 'gpt-6-sol', tokens: T(3) });
  assert.equal(ledger.taskView(S, first.id).task.fidelity, 'live', 'live wins over partial');
  assert.equal(ledger.taskView(S).task.fidelity, 'exact', 'the other task is not live');

  assert.deepEqual(ledger.runView(S, 'run-a'), {
    tokens: withTotal(T(160, 0, 0, 11, 0)), pending: withTotal(T(3)), subagents: { total: 55 }, fidelity: 'live', taskIds: ['task-1', 'task-2'],
  });
  ledger.clearPending(S, 'run-a');
  assert.equal(ledger.runView(S, 'run-a').fidelity, 'partial');
  assert.equal(ledger.runView(S, 'run-zzz'), null);

  assert.deepEqual(ledger.sessionView(S), {
    sessionId: S, tokens: withTotal(T(188, 0, 0, 21, 0)), pending: withTotal(T()), costUsd: 0.3, costBasis: null, live: false, fidelity: 'partial', unsynced: 0,
    // Per model over the whole session, most tokens first; a row that named no basis leaves it null.
    models: [
      { provider: 'codex', model: 'gpt-6-sol', tokens: withTotal(T(158, 0, 0, 11, 0)), costUsd: 0, costBasis: null },
      { provider: 'claude-code', model: 'opus', tokens: withTotal(T(30, 0, 0, 10, 0)), costUsd: 0.3, costBasis: null },
    ],
    tasks: [
      { id: 'task-1', n: 1, title: 'one', total: 175, inputTotal: 160, outputTotal: 15, costUsd: 0.1, fidelity: 'partial', live: false, startedAt: 1000 },
      { id: 'task-2', n: 2, title: 'two', total: 34, inputTotal: 28, outputTotal: 6, costUsd: 0.2, fidelity: 'exact', live: false, startedAt: 9000 },
    ],
  });
  for (let i = 3; i <= 9; i += 1) ledger.beginTask(S, { title: `t${i}` });
  assert.deepEqual(ledger.taskView(S).recent.map((task) => task.n), [8, 7, 6, 5, 4], 'up to 5 other tasks, newest first');
});

test('ledger: reload from disk, a corrupt line and a torn tail', (t) => {
  const { ledger, make, dataDir, logs } = ledgerHarness(t);
  const task = ledger.beginTask(S, { title: 'persist' });
  ledger.settle({ sessionId: S, scope: 'brain', provider: 'claude-code', model: 'opus', part: 'main', tokens: T(10, 100, 1000, 50, 20), costUsd: 0.5 });
  ledger.settle({ sessionId: S, taskId: task.id, scope: 'run', runId: 'run-a', provider: 'codex', model: 'gpt-6-sol', part: 'subagents', tokens: T(5, 0, 0, 1, 0), fidelity: 'partial', reason: 'codex-no-records' });
  ledger.setPending(S, 'brain', { provider: 'claude-code', model: 'opus', tokens: T(99) });
  const path = usageLedgerPath(dataDir, S);
  assert.equal(path, join(dataDir, 'assistant-usage', `${S}.jsonl`));
  // Damage: a corrupt line in the middle, a row of a task whose line is gone, and a torn last line.
  appendFileSync(path, '{"t":"use","at":1,"task":\n');
  appendFileSync(path, `${JSON.stringify({ t: 'use', at: 7, task: 'task-7', scope: 'brain', run: null, turn: null, provider: 'claude-code', model: 'opus', part: 'main', tokens: [1, 0, 0, 0, 0], cost: null, basis: null, fid: 'exact', why: null, src: null })}\n`);
  appendFileSync(path, '{"t":"use","at":2,"ta');

  const reloaded = make();
  const view = reloaded.taskView(S, task.id);
  assert.equal(view.task.tokens.total, 1186);
  assert.equal(view.task.live, false, 'pending is not persisted');
  assert.equal(view.task.fidelity, 'partial');
  assert.equal(view.task.costUsd, 0.5);
  assert.equal(view.task.agents[1].subagents.total, 6);
  assert.deepEqual(reloaded.currentTask(S), { id: 'task-1', n: 1, title: 'persist', startedAt: 1000 });
  assert.equal(reloaded.sessionView(S).tasks.length, 2, 'the orphan row keeps its tokens under a placeholder task');
  assert.equal(reloaded.sessionView(S).tokens.total, 1187);
  assert.ok(logs.some(([event, detail]) => event === 'assistant-usage:corrupt-lines' && detail.includes('2 skipped')));

  // The next append starts on its own line, and task numbers continue after the highest seen.
  assert.deepEqual(reloaded.beginTask(S, { title: 'next' }), { id: 'task-8', n: 8 });
  reloaded.settle({ sessionId: S, scope: 'brain', provider: 'claude-code', model: 'opus', part: 'main', tokens: T(2) });
  const again = make();
  assert.equal(again.taskView(S).task.id, 'task-8');
  assert.equal(again.taskView(S).task.tokens.total, 2);
  assert.equal(again.sessionView(S).tokens.total, 1189);

  assert.equal(again.dropSession(S), true);
  assert.equal(existsSync(path), false);
  assert.equal(again.taskView(S).task, null);
});

test('ledger: the judgments row is counted in the task and session totals and cached 5 s', (t) => {
  const calls = [];
  let answer = { input: 4000, output: 12, calls: 3 };
  const { ledger, clock } = ledgerHarness(t, { judgments: (query) => { calls.push(query); return query.taskId === 'task-1' ? answer : null; } });
  ledger.beginTask(S, { title: 'one' });
  ledger.settle({ sessionId: S, scope: 'brain', provider: 'claude-code', model: 'opus', part: 'main', tokens: T(10, 0, 0, 5, 0) });
  ledger.settle({ sessionId: S, scope: 'run', runId: 'run-a', provider: 'codex', model: 'gpt-6-sol', part: 'main', tokens: T(100, 0, 0, 5, 0) });

  const view = ledger.taskView(S);
  assert.deepEqual(calls, [{ sessionId: S, taskId: 'task-1', sinceMs: 1000, untilMs: null, runIds: ['run-a'] }]);
  assert.deepEqual(view.task.agents.at(-1), {
    key: 'judgments', scope: 'judgments', runId: null, provider: 'jev', model: 'jev',
    tokens: withTotal(T(4000, 0, 0, 12, 0)), pending: withTotal(T()), subagents: { total: 0 }, fidelity: 'exact', partialReason: null, calls: 3,
  });
  assert.equal(view.task.tokens.total, 120 + 4012);
  assert.equal(view.session.tokens.total, 120 + 4012);
  assert.ok(view.task.models.some((model) => model.provider === 'jev' && model.tokens.total === 4012));

  answer = { input: 9000, output: 20, calls: 5 };
  clock.now += 4000;
  assert.equal(ledger.taskView(S).task.tokens.total, 120 + 4012, 'cached for 5 s');
  assert.equal(calls.length, 1);
  clock.now += 1500;
  assert.equal(ledger.taskView(S).task.tokens.total, 120 + 9020);

  // The next task closes the first one's window; a task without judgments has no such agent.
  clock.now = 60_000;
  ledger.beginTask(S, { title: 'two' });
  const second = ledger.taskView(S);
  assert.equal(second.task.agents.length, 0);
  assert.equal(second.recent[0].total, 120 + 9020);
  assert.equal(calls.find((query) => query.taskId === 'task-1' && query.untilMs)?.untilMs, 60_000);

  // A reader that throws is the same as no answer.
  const broken = ledgerHarness(t, { judgments: () => { throw new Error('db locked'); } });
  broken.ledger.beginTask(S, {});
  broken.ledger.settle({ sessionId: S, scope: 'brain', provider: 'claude-code', model: 'opus', part: 'main', tokens: T(1) });
  assert.equal(broken.ledger.taskView(S).task.tokens.total, 1);
  assert.equal(broken.logs[0][0], 'assistant-usage:judgments-error');
});

test('a Claude turn flows from the meter into the ledger without losing a token', (t) => {
  const { ledger } = ledgerHarness(t);
  const task = ledger.beginTask(S, { title: 'end to end' });
  const meter = createClaudeMeter();
  const ids = { sessionId: S, taskId: task.id, scope: 'brain', provider: 'claude-code' };
  const feed = (message) => {
    const { settled, pendingChanged } = meter.onEvent(message);
    if (settled) for (const row of settled.rows) ledger.settle({ ...ids, ...row, fidelity: settled.fidelity, reason: settled.reason, source: settled.source });
    if (pendingChanged) ledger.setPending(S, 'brain', { ...ids, model: 'claude-opus-5-5', tokens: meter.pending().tokens });
  };
  feed(assistantMsg('m1', usageOf(5, 1, 0, 1000, 100)));
  feed(assistantMsg('s1', usageOf(20, 1, 0, 40000, 2000), { parent: 'toolu_1' }));
  assert.equal(ledger.taskView(S).task.fidelity, 'live');
  assert.equal(ledger.taskView(S).task.tokens.total, 43127);
  feed(result('r1', usageOf(5, 60, 20, 1000, 100), { [OPUS]: mu(25, 260, 70, 41000, 2100, 2), [HAIKU]: mu(900, 14, 0, 0, 0, 0.001) }));
  const view = ledger.taskView(S);
  assert.equal(view.task.fidelity, 'exact');
  assert.equal(view.task.pending.total, 0);
  assert.deepEqual(view.task.tokens, withTotal(T(925, 2100, 41000, 204, 70)));
  assert.equal(view.task.agents[0].subagents.total, 42220);
  assert.equal(view.task.agents[0].model, OPUS);
  assert.equal(view.task.costUsd, 2.001);
});

test('finding 1: Claude subtracts a no-model-usage turn from the next cumulative snapshot', () => {
  const meter = createClaudeMeter();
  const first = meter.onEvent(result('r1', usageOf(10, 10, 2, 10, 10), undefined)).settled;
  assert.equal(first.reason, 'no-model-usage');
  const resumed = createClaudeMeter({ state: JSON.parse(JSON.stringify(meter.state())) });
  const second = resumed.onEvent(result('r2', usageOf(10, 10, 2, 10, 10), { [OPUS]: mu(20, 20, 4, 20, 20, 0) })).settled;
  assert.deepEqual(second.tokens, T(10, 10, 10, 8, 2));
  assert.deepEqual(addTokens(first.tokens, second.tokens), T(20, 20, 20, 16, 4));
});

test('finding 3: Claude process restart drops baselines of absent models too', () => {
  const meter = createClaudeMeter();
  meter.onEvent(result('r1', usageOf(100, 0, 0, 0, 0), { [OPUS]: mu(100, 0, 0, 0, 0, 0), [HAIKU]: mu(100, 0, 0, 0, 0, 0) }));
  meter.onEvent(result('r2', usageOf(5, 0, 0, 0, 0), { [OPUS]: mu(5, 0, 0, 0, 0, 0) }));
  const third = meter.onEvent(result('r3', usageOf(0, 0, 0, 0, 0), { [HAIKU]: mu(150, 0, 0, 0, 0, 0) })).settled;
  assert.equal(third.tokens.input, 150, 'the returning model is counted in full even above its old counter');
});

test('finding 4: Claude uses turn thinking when the cumulative thinking counter falls', () => {
  const meter = createClaudeMeter();
  meter.onEvent(result('r1', usageOf(0, 100, 80, 0, 0), { [OPUS]: mu(0, 100, 80, 0, 0, 0) }));
  const turn = meter.onEvent(result('r2', usageOf(0, 30, 5, 0, 0), { [OPUS]: mu(0, 130, 5, 0, 0, 0) })).settled;
  assert.deepEqual(turn.tokens, T(0, 0, 0, 25, 5));
  assert.equal(totalTokens(turn.tokens), 30);
});

test('finding 13: Claude stops routing deltas after message_stop under a reused parent', () => {
  const meter = createClaudeMeter();
  const stream = (type, id, output) => ({ type: 'stream_event', parent_tool_use_id: 'tool-1', event: {
    type, ...(type === 'message_start' ? { message: { id, model: OPUS, usage: usageOf(0, output, 0, 0, 0) } } : { usage: { output_tokens: output } }),
  } });
  meter.onEvent(stream('message_start', 'm1', 1));
  meter.onEvent(stream('message_start', 'm2', 2)); // same parent before m1 stops
  meter.onEvent(stream('message_delta', null, 4));
  meter.onEvent(stream('message_stop', null, 0));
  meter.onEvent(stream('message_delta', null, 3));
  meter.onEvent(stream('message_stop', null, 0));
  assert.equal(meter.onEvent(stream('message_delta', null, 99)).pendingChanged, false);
  assert.equal(meter.pending().tokens.output, 7);
});

test('finding 5: Codex reads a same-size rollout replacement with a new inode', (t) => {
  const home = tempDir(t, 'codex-replace');
  const path = rolloutPath(dayDir(home), ROOT);
  const first = meta(ROOT) + record(ROOT, 'turn-1', 'resp-1', codexUsage(10, 0, 1, 0), 1000);
  const next = meta(ROOT) + record(ROOT, 'turn-1', 'resp-2', codexUsage(20, 0, 2, 0), 2000);
  assert.equal(Buffer.byteLength(first), Buffer.byteLength(next));
  writeFileSync(path, first);
  const meter = createCodexMeter({ codexHome: home, threadId: ROOT, now: () => NOW });
  assert.equal(meter.poll()[0].responses, 1);
  writeFileSync(path + '.new', next);
  renameSync(path + '.new', path);
  assert.equal(meter.poll()[0].usage.input_tokens, 20);
});

test('finding 6: Codex rescan skips old responses after the seen set evicts them', (t) => {
  const home = tempDir(t, 'codex-highwater');
  const path = rolloutPath(dayDir(home), ROOT);
  let body = meta(ROOT);
  for (let i = 0; i < 2001; i += 1) body += record(ROOT, 'turn-1', 'resp-' + String(i).padStart(4, '0'), codexUsage(1, 0, 0, 0), i + 1);
  writeFileSync(path, body);
  const meter = createCodexMeter({ codexHome: home, threadId: ROOT, now: () => NOW });
  assert.equal(meter.poll()[0].responses, 2001);
  writeFileSync(path, meta(ROOT) + record(ROOT, 'turn-1', 'resp-0000', codexUsage(1, 0, 0, 0), 1));
  assert.deepEqual(meter.poll(), []);
});

test('finding 7: parent replay does not disable a child token_count fallback', (t) => {
  const home = tempDir(t, 'codex-child-fallback');
  const dir = dayDir(home);
  writeFileSync(rolloutPath(dir, ROOT), meta(ROOT));
  writeFileSync(rolloutPath(dir, CHILD), meta(CHILD, ROOT)
    + record(ROOT, 'parent', 'replayed', codexUsage(50, 0, 5, 0), 1000)
    + turnContext('child') + tokenCount(codexUsage(7, 0, 2, 0), codexUsage(7, 0, 2, 0), 2000));
  const rows = createCodexMeter({ codexHome: home, threadId: ROOT, now: () => NOW }).poll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].threadId, CHILD);
  assert.equal(rows[0].source, 'codex-token-count');
  assert.deepEqual(rows[0].tokens, T(7, 0, 0, 2));
});

test('finding 8: OpenCode accepts a late older id in memory and reconciles it after restore', async () => {
  const meter = createOpenCodeMeter();
  meter.setRoot('ses_root');
  for (let i = 1; i <= 2001; i += 1) meter.onEvent('message.updated', { info: ocInfo('ses_root', 'msg_' + String(i).padStart(6, '0'), [1, 0, 0, 0, 0]) });
  assert.equal(meter.onEvent('message.updated', { info: ocInfo('ses_root', 'msg_000000', [5, 0, 0, 0, 0]) }), true);
  assert.equal(meter.total().tokens.input, 2006);
  const resumed = createOpenCodeMeter({ state: JSON.parse(JSON.stringify(meter.state())) });
  assert.equal(resumed.onEvent('message.updated', { info: ocInfo('ses_root', 'msg_000000', [5, 0, 0, 0, 0]) }), false);
  const stored = [ocInfo('ses_root', 'msg_000000', [9, 0, 0, 0, 0])];
  for (let i = 1; i <= 2001; i += 1) stored.push(ocInfo('ses_root', 'msg_' + String(i).padStart(6, '0'), [1, 0, 0, 0, 0]));
  assert.equal(await resumed.reconcile({ messages: async () => stored }), true);
  assert.equal(resumed.total().tokens.input, 2010);
});

test('OpenCode restores an unmarked turn from the earlier state format', () => {
  const old = {
    root: 'ses_root', base: {},
    entries: [['ses_root', 'msg_1', 'opencode\nbig-pickle', [10, 0, 0, 0, 0], 0], ['ses_root', 'msg_2', 'opencode\nbig-pickle', [5, 0, 0, 0, 0], 0]],
    mark: { main: [10, 0, 0, 0, 0], subagents: [0, 0, 0, 0, 0], models: { 'opencode\nbig-pickle': [10, 0, 0, 0, 0] }, cost: 0 },
  };
  const meter = createOpenCodeMeter({ state: old });
  assert.equal(meter.markTurn().main.input, 5);
  assert.equal(meter.markTurn().tokens.input, 0);
});

test('finding 9: OpenCode classifies only future child deltas after a late setRoot', () => {
  const meter = createOpenCodeMeter();
  meter.onEvent('message.updated', { info: ocInfo('ses_child', 'msg_1', [10, 0, 0, 0, 0]) });
  assert.equal(meter.markTurn().main.input, 10);
  meter.setRoot('ses_root');
  meter.onEvent('message.updated', { info: ocInfo('ses_child', 'msg_1', [15, 0, 0, 0, 0]) });
  assert.deepEqual(meter.markTurn().main, T());
  assert.equal(meter.total().subagents.input, 15);
  assert.equal(totalTokens(meter.live().tokens), 0);
});

test('finding 12: Codex discovers at most every 15 seconds but tails each poll', (t) => {
  const home = tempDir(t, 'codex-discovery');
  const path = rolloutPath(dayDir(home), ROOT);
  writeFileSync(path, meta(ROOT) + record(ROOT, 'turn-1', 'resp-1', codexUsage(1, 0, 0, 0), 1000));
  let time = NOW;
  let listings = 0;
  const fs = { ...nodeFs, readdirSync(dir) { listings += 1; return nodeFs.readdirSync(dir); } };
  const meter = createCodexMeter({ codexHome: home, threadId: ROOT, now: () => time, fs });
  assert.equal(meter.poll()[0].responses, 1);
  const first = listings;
  appendFileSync(path, record(ROOT, 'turn-1', 'resp-2', codexUsage(2, 0, 0, 0), 2000));
  time += 2000;
  assert.equal(meter.poll()[0].usage.input_tokens, 2);
  assert.equal(listings, first);
  time += 15000;
  meter.poll();
  assert.ok(listings > first);
  const missing = createCodexMeter({ codexHome: home, threadId: CHILD, now: () => time, fs });
  missing.poll();
  const beforeMissing = listings;
  missing.poll();
  assert.ok(listings > beforeMissing, 'a missing root is searched on every poll');
});

test('Codex poll can force discovery of a child inside the 15-second interval', (t) => {
  const home = tempDir(t, 'codex-force-discovery');
  const dir = dayDir(home);
  const rootPath = rolloutPath(dir, ROOT);
  writeFileSync(rootPath, meta(ROOT) + record(ROOT, 'root-turn', 'root-1', codexUsage(1, 0, 0, 0), 1000));
  let time = NOW;
  const meter = createCodexMeter({ codexHome: home, threadId: ROOT, now: () => time });
  assert.deepEqual(meter.poll().map((row) => row.threadId), [ROOT]);

  time += 1000;
  writeFileSync(rolloutPath(dir, CHILD, '2026-10-01T08-00-30'), meta(CHILD, ROOT)
    + record(CHILD, 'child-turn', 'child-1', codexUsage(7, 0, 2, 0), 2000));
  appendFileSync(rootPath, record(ROOT, 'root-turn', 'root-2', codexUsage(2, 0, 0, 0), 2000));
  const plain = meter.poll();
  assert.deepEqual(plain.map((row) => row.threadId), [ROOT], 'plain poll tails the root but waits to discover the child');
  assert.equal(plain[0].usage.input_tokens, 2);

  time += 1000;
  appendFileSync(rootPath, record(ROOT, 'root-turn', 'root-3', codexUsage(3, 0, 0, 0), 3000));
  const forced = meter.poll({ discover: true });
  assert.deepEqual(forced.map((row) => row.threadId), [ROOT, CHILD]);
  assert.equal(forced[0].usage.input_tokens, 3, 'forced discovery still tails a tracked file');
  assert.equal(forced[1].usage.input_tokens, 7);
});

test('finding 2: ledger retries failed appends in order and reports unsynced lines', (t) => {
  const dataDir = tempDir(t, 'ledger-retry');
  let failing = false;
  const fs = { ...nodeFs, appendFileSync(path, data) { if (failing) throw new Error('disk unavailable'); nodeFs.appendFileSync(path, data); } };
  const ledger = createUsageLedger({ dataDir, fs, now: () => 1000, log: () => { throw new Error('logger unavailable'); } });
  ledger.beginTask(S);
  failing = true;
  ledger.settle({ sessionId: S, scope: 'brain', tokens: T(1) });
  ledger.settle({ sessionId: S, scope: 'brain', tokens: T(2) });
  assert.equal(ledger.taskView(S).session.unsynced, 2);
  assert.equal(ledger.sessionView(S).unsynced, 2);
  assert.equal(readUsageLedgerFile(usageLedgerPath(dataDir, S)).rows.length, 0);
  failing = false;
  ledger.settle({ sessionId: S, scope: 'brain', tokens: T(3) });
  assert.deepEqual(readUsageLedgerFile(usageLedgerPath(dataDir, S)).rows.map((row) => row.tokens.input), [1, 2, 3], 'old lines precede the new append');
  failing = true;
  ledger.settle({ sessionId: S, scope: 'brain', tokens: T(4) });
  assert.equal(ledger.sessionView(S).unsynced, 1);
  failing = false;
  assert.equal(ledger.flush(S), 0);
  assert.equal(ledger.sessionView(S).unsynced, 0);
  assert.deepEqual(readUsageLedgerFile(usageLedgerPath(dataDir, S)).rows.map((row) => row.tokens.input), [1, 2, 3, 4]);
});

test('ledger ignores late writes after dropSession until beginTask reopens it', (t) => {
  const { ledger, dataDir } = ledgerHarness(t);
  const path = usageLedgerPath(dataDir, S);
  ledger.beginTask(S);
  ledger.settle({ sessionId: S, scope: 'brain', tokens: T(1) });
  assert.equal(ledger.dropSession(S), true);
  assert.equal(existsSync(path), false);

  assert.equal(ledger.settle({ sessionId: S, scope: 'run', runId: 'late', tokens: T(99) }), null);
  assert.equal(ledger.setPending(S, 'late', { taskId: 'task-1', tokens: T(99) }), false);
  assert.equal(ledger.clearPending(S, 'late'), false);
  assert.equal(ledger.ensureTask(S), null);
  assert.equal(ledger.currentTask(S), null);
  assert.equal(ledger.taskView(S).task, null);
  assert.equal(existsSync(path), false, 'late activity cannot recreate the deleted file');

  assert.deepEqual(ledger.beginTask(S), { id: 'task-1', n: 1 });
  ledger.settle({ sessionId: S, scope: 'brain', tokens: T(2) });
  assert.deepEqual(readUsageLedgerFile(path).rows.map((row) => row.tokens.input), [2]);
});

test('ledger freezes judgments for closed tasks without pending and clears their cache on drop', (t) => {
  const reads = [];
  const { ledger, clock } = ledgerHarness(t, { judgments: ({ taskId }) => { reads.push(taskId); return { input: 1, output: 0, calls: 1 }; } });
  const countReads = (taskId) => reads.filter((id) => id === taskId).length;

  for (let i = 1; i <= 20; i += 1) {
    clock.now = 1000 + i * 1000;
    ledger.beginTask(S);
    ledger.sessionView(S);
  }
  assert.equal(countReads('task-1'), 2, 'the first task is read once while current and once when its window closes');
  const before = reads.length;
  clock.now += 100_000;
  ledger.sessionView(S);
  assert.equal(reads.length, before + 1, 'only the current task refreshes after five seconds');
  assert.equal(countReads('task-1'), 2);

  ledger.setPending(S, 'late-run', { taskId: 'task-1', runId: 'late-run', tokens: T(1) });
  ledger.sessionView(S);
  assert.equal(countReads('task-1'), 3, 'pending work unfreezes the old task');
  clock.now += 4000;
  ledger.sessionView(S);
  assert.equal(countReads('task-1'), 3, 'the live task still uses the five-second cache');
  clock.now += 2000;
  ledger.sessionView(S);
  assert.equal(countReads('task-1'), 4);
  ledger.clearPending(S, 'late-run');
  ledger.sessionView(S);
  assert.equal(countReads('task-1'), 5, 'the final answer is read when pending ends');
  clock.now += 100_000;
  ledger.sessionView(S);
  assert.equal(countReads('task-1'), 5, 'the final answer stays cached');

  ledger.dropSession(S);
  ledger.beginTask(S);
  ledger.sessionView(S);
  assert.equal(countReads('task-1'), 6, 'the dropped session kept no judgment cache');
});

// ── The session headline: interrupted calls, long prompts, dollars per model, Jev on disk ──

test('Claude meter: a call cut off by an interrupt is booked from the stream, once, in either order', () => {
  const start = (id, parent = null, model = 'claude-opus-5-5') => ({ type: 'stream_event', session_id: 'sess-1', parent_tool_use_id: parent, event: { type: 'message_start', message: { id, model, usage: { input_tokens: 6, cache_creation_input_tokens: 1000, cache_read_input_tokens: 400_000, output_tokens: 1 } } } });
  const failed = (uuid, modelUsage) => result(uuid, usageOf(0, 0, 0, 0, 0), modelUsage, { subtype: 'error_during_execution', is_error: true });
  const first = { 'claude-opus-5-5[1m]': mu(100, 500, 0, 10_000, 0, 0.05) };

  // The result arrives first: its totals did not move, the main-loop call the stream showed is the difference.
  const meter = createClaudeMeter();
  meter.onEvent(result('r1', usageOf(100, 500, 0, 10_000, 0), first));
  meter.onEvent(start('m2'));
  meter.onEvent(start('sub-1', 'toolu-1')); // a sub-agent's call in flight: a later result may still count it
  const { settled } = meter.onEvent(failed('r2', first));
  assert.deepEqual(settled.tokens, T(), 'the result itself counted nothing');
  assert.deepEqual(settled.rows, [{ model: 'claude-opus-5-5[1m]', part: 'main', tokens: T(6, 1000, 400_000, 1, 0), costUsd: null, fidelity: 'partial', reason: 'interrupted', source: 'claude-stream-estimate' }]);
  assert.deepEqual(settled.estimated, T(6, 1000, 400_000, 1, 0));
  assert.deepEqual(meter.pending().tokens, T(), 'a result ends the estimate');
  assert.deepEqual(meter.settlePending(), [], 'the abort notice that follows finds nothing left to book');
  // The next turn is whole: nothing is taken off it for the estimate.
  const next = meter.onEvent(result('r3', usageOf(50, 250, 0, 5000, 0), { 'claude-opus-5-5[1m]': mu(150, 750, 0, 15_000, 0, 0.08) })).settled;
  assert.deepEqual([next.tokens, next.fidelity, next.estimated], [T(50, 0, 5000, 250, 0), 'exact', T()]);

  // The abort notice arrives first: everything pending is booked, and the result that follows adds nothing.
  const other = createClaudeMeter();
  other.onEvent(result('r1', usageOf(100, 500, 0, 10_000, 0), first));
  other.onEvent(start('m2'));
  assert.deepEqual(other.settlePending({ reason: 'interrupted' }).map((row) => [row.model, row.part, row.tokens, row.reason, row.source]), [['claude-opus-5-5[1m]', 'main', T(6, 1000, 400_000, 1, 0), 'interrupted', 'claude-stream-estimate']]);
  assert.deepEqual(other.onEvent(failed('r2', first)).settled.rows, []);
  assert.deepEqual(other.onEvent(result('r3', usageOf(50, 250, 0, 5000, 0), { 'claude-opus-5-5[1m]': mu(150, 750, 0, 15_000, 0, 0.08) })).settled.tokens, T(50, 0, 5000, 250, 0), 'the mark left by the estimate ended with that result');

  // A successful result never guesses: a call it does not count stays with the next result.
  const fine = createClaudeMeter();
  fine.onEvent(start('m1'));
  assert.deepEqual(fine.onEvent(result('r1', usageOf(100, 500, 0, 10_000, 0), first)).settled.rows.map((row) => row.source), [undefined]);
});

test('Claude meter: an estimate booked when no result came is taken off a result that arrives after all', () => {
  // A run stopped mid-turn: its one completed call was seen in the stream and booked at the end...
  const meter = createClaudeMeter();
  meter.onEvent(assistantMsg('m1', usageOf(2, 150, 0, 13_241, 33_458), { model: 'claude-sonnet-5-5' }));
  const rows = meter.settlePending();
  assert.deepEqual(rows.map((row) => [row.model, row.part, row.tokens, row.fidelity, row.reason]), [['claude-sonnet-5-5', 'main', T(2, 33_458, 13_241, 150, 0), 'partial', 'no-result']]);
  // ...and the CLI's result comes late, counting the same call (its output now complete): only the rest is new.
  const restored = createClaudeMeter({ state: meter.state() });
  const late = restored.onEvent(result('r1', usageOf(2, 196, 0, 13_241, 33_458), { 'claude-sonnet-5-5': mu(2, 196, 0, 13_241, 33_458, 0.14) })).settled;
  assert.deepEqual(late.tokens, T(0, 0, 0, 46, 0), 'never booked twice');
  assert.equal(totalTokens(sum(rows)) + totalTokens(late.tokens), 46_897, 'together: exactly what the CLI counted');
});

test('Codex meter: with a long-prompt size, responses over it are rows of their own', (t) => {
  const home = tempDir(t, 'codex-long');
  const dir = dayDir(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(rolloutPath(dir, ROOT), meta(ROOT) + turnContext('turn-1', 'gpt-6-sol')
    + record(ROOT, 'turn-1', 'resp-1', codexUsage(100_000, 40_000, 1000, 0), 1000)
    + record(ROOT, 'turn-1', 'resp-2', codexUsage(300_000, 250_000, 2000, 500), 2000)
    + record(ROOT, 'turn-1', 'resp-3', codexUsage(272_000, 0, 10, 0), 3000));
  const split = createCodexMeter({ codexHome: home, threadId: ROOT, now: () => NOW, longPromptTokens: (model) => (model === 'gpt-6-sol' ? 272_000 : 0) }).poll();
  assert.deepEqual(split.map((row) => [row.long, row.responses, row.usage.input_tokens, row.tokens]), [
    [false, 2, 372_000, T(332_000, 0, 40_000, 1010, 0)],
    [true, 1, 300_000, T(50_000, 0, 250_000, 1500, 500)],
  ], 'exactly 272,000 is not over it');
  // Without a size (or for a model that has none) rows are as before: one per thread and turn, no `long`.
  const plain = createCodexMeter({ codexHome: home, threadId: ROOT, now: () => NOW }).poll();
  assert.deepEqual([plain.length, 'long' in plain[0], plain[0].responses], [1, false, 3]);
  assert.equal('long' in createCodexMeter({ codexHome: home, threadId: ROOT, now: () => NOW, longPromptTokens: () => 0 }).poll()[0], false);
});

test('ledger: dollars per model with how they are known, for a task and for the session', (t) => {
  const { ledger } = ledgerHarness(t);
  ledger.beginTask(S, { title: 'one' });
  ledger.settle({ sessionId: S, scope: 'brain', provider: 'claude-code', model: 'claude-opus-5-5[1m]', part: 'main', tokens: T(10, 100, 1000, 50, 0), costUsd: 0.5, costBasis: 'reported' });
  ledger.settle({ sessionId: S, scope: 'brain', provider: 'claude-code', model: 'claude-opus-5-5[1m]', part: 'subagents', tokens: T(5, 0, 500, 20, 0), costUsd: null, costBasis: 'reported' });
  ledger.settle({ sessionId: S, scope: 'run', runId: 'run-a', provider: 'codex', model: 'gpt-6-sol', part: 'main', tokens: T(2000, 0, 900, 100, 40), costUsd: 0.02, costBasis: 'estimated' });
  ledger.settle({ sessionId: S, scope: 'run', runId: 'run-b', provider: 'opencode', model: 'free/model', part: 'main', tokens: T(300, 0, 0, 30, 0), costUsd: null, costBasis: 'free' });
  ledger.beginTask(S, { title: 'two' });
  ledger.settle({ sessionId: S, scope: 'brain', provider: 'claude-code', model: 'claude-opus-5-5[1m]', part: 'main', tokens: T(1, 0, 100, 5, 0), costUsd: 0.1, costBasis: 'reported' });
  ledger.settle({ sessionId: S, scope: 'run', runId: 'run-c', provider: 'codex', model: 'gpt-0-unlisted', part: 'main', tokens: T(7, 0, 0, 1, 0), costUsd: null, costBasis: 'unpriced' });
  const view = ledger.taskView(S, 'task-1');
  assert.deepEqual(view.task.models.map((row) => [row.provider, row.model, row.tokens.inputTotal, row.tokens.outputTotal, row.costUsd, row.costBasis]), [
    ['codex', 'gpt-6-sol', 2900, 140, 0.02, 'estimated'],
    ['claude-code', 'claude-opus-5-5[1m]', 1615, 70, 0.5, 'reported'],
    ['opencode', 'free/model', 300, 30, 0, 'free'],
  ]);
  assert.deepEqual([view.task.costUsd, view.task.costBasis], [0.52, 'estimated'], 'a sum is only as good as its weakest part');
  assert.deepEqual(view.session.models.map((row) => [row.model, row.tokens.total, row.costUsd, row.costBasis]), [
    ['gpt-6-sol', 3040, 0.02, 'estimated'], ['claude-opus-5-5[1m]', 1791, 0.6, 'reported'], ['free/model', 330, 0, 'free'], ['gpt-0-unlisted', 8, 0, 'unpriced'],
  ]);
  assert.deepEqual([view.session.tokens.total, view.session.tokens.inputTotal, view.session.tokens.outputTotal, view.session.costUsd, view.session.costBasis, view.session.tasks], [5169, 4923, 246, 0.62, 'unpriced', 2]);
  assert.equal(view.session.tokens.total, view.session.models.reduce((total, row) => total + row.tokens.total, 0));
  assert.deepEqual(ledger.sessionView(S).models, view.session.models);
});

test('ledger: a task\'s Jev count is written down and never shrinks, whatever the judgment log holds later', (t) => {
  const dir = tempDir(t, 'jev');
  let log = { input: 700, output: 7, calls: 3, costUsd: 0.0000294 };
  const judgments = () => log;
  const clock = { now: 1000 };
  const ledger = createUsageLedger({ dataDir: dir, now: () => clock.now, judgments });
  ledger.beginTask(S, { title: 'one' });
  ledger.settle({ sessionId: S, scope: 'brain', provider: 'claude-code', model: 'opus', tokens: T(10, 0, 0, 5, 0), costUsd: 0.1, costBasis: 'reported' });
  assert.equal(ledger.sessionView(S).tokens.total, 15 + 707);
  log = { input: 1600, output: 16, calls: 5, costUsd: 0.0000672 };
  clock.now += 6000; // past the 5 s answer
  assert.deepEqual([ledger.sessionView(S).tokens.total, ledger.taskView(S).task.agents.at(-1).calls], [15 + 1616, 5]);
  const file = readUsageLedgerFile(usageLedgerPath(dir, S));
  assert.deepEqual(file.judged.map((line) => [line.task, line.input, line.output, line.calls, line.costUsd]), [['task-1', 700, 7, 3, 0.0000294], ['task-1', 1600, 16, 5, 0.0000672]]);
  assert.equal(file.corrupt, 0, 'a jev line is part of the format');
  // The judgment log is pruned (it holds less than before), and the server restarts.
  log = { input: 100, output: 1, calls: 1, costUsd: 0.0000042 };
  const pruned = createUsageLedger({ dataDir: dir, now: () => clock.now + 60_000, judgments });
  const view = pruned.taskView(S);
  assert.deepEqual([view.session.tokens.total, view.task.agents.at(-1).tokens.total, view.task.agents.at(-1).calls], [15 + 1616, 1616, 5], 'what was shown is what is shown');
  assert.deepEqual(view.session.models.find((row) => row.provider === 'jev'), { provider: 'jev', model: 'jev', tokens: withTotal(T(1600, 0, 0, 16, 0)), costUsd: 0.0000672, costBasis: 'estimated' });
  // No reader at all (the log cannot be opened): the file's count stands.
  assert.equal(createUsageLedger({ dataDir: dir }).sessionView(S).tokens.total, 15 + 1616);
  assert.equal(readUsageLedgerFile(usageLedgerPath(dir, S)).judged.length, 2, 'a smaller count writes nothing');
});

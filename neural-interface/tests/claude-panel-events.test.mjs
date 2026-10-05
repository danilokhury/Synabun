import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  readEngineHello,
  hasCapability,
  describeResult,
  describeEvent,
  eventLabel,
  fmtTokens,
  fmtDuration,
  fmtResetTime,
  stripAnsi,
  turnModelUsage,
  describeTurnFooter,
  localCommandOutput,
  describeCompactBoundary,
  describeRateLimit,
  classifyLimitText,
  describeAssistantState,
  splitAssistantBlocks,
  previewPartialToolInput,
  normalizeSlashCommands,
  matchSlashCommands,
  readInit,
  statusRows,
} from '../public/shared/cp/cp-events.js';

// The Claude sidepanel's reading of SDK events: what a turn's result means, what
// the engine hello allows, and what happens to an event nobody renders. The
// module is DOM-free; the panel's own wiring is pinned as source contracts below.

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const panel = (await read('../public/shared/ui-claude-panel.js')).replace(/\r\n/g, '\n');

function fnBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = src.slice(start + signature.length);
  const next = rest.search(/\n(?:async )?function /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

// ── Engine hello ──

test('the engine hello carries the capability list, and an old server carries none', () => {
  const hello = readEngineHello({ type: 'engine', engine: 'sdk', sdkVersion: '0.3.288', capabilities: ['capabilities', 7, 'x'] });
  assert.equal(hello.sdk, true);
  assert.equal(hello.unavailable, false);
  assert.deepEqual(hello.capabilities, ['capabilities', 'x']);
  assert.deepEqual(readEngineHello({ type: 'engine', engine: 'sdk' }).capabilities, []);

  const tab = { capabilities: new Set(hello.capabilities) };
  assert.equal(hasCapability(tab, 'x'), true);
  assert.equal(hasCapability(tab, 'y'), false);
  assert.equal(hasCapability({}, 'x'), false, 'a tab that never got a hello has no capabilities');
});

test('an unavailable engine is read with its reason', () => {
  const hello = readEngineHello({ type: 'engine', engine: 'unavailable', error: 'the bridge failed to load' });
  assert.equal(hello.unavailable, true);
  assert.equal(hello.sdk, false);
  assert.equal(hello.error, 'the bridge failed to load');
  // The SDK bridge is the only engine. A server that was not restarted and still
  // has the retired per-turn engine selected is a tab without an engine, and says so.
  const retired = readEngineHello({ engine: 'legacy' });
  assert.equal(retired.sdk, false);
  assert.equal(retired.unavailable, true);
  assert.match(retired.error, /retired "legacy" engine\. Restart the SynaBun server/);
  assert.equal(readEngineHello({}).unavailable, true, 'a hello that names no engine attaches none');
  const sdk = readEngineHello({ engine: 'sdk', capabilities: ['capabilities'] });
  assert.deepEqual([sdk.sdk, sdk.unavailable, sdk.error], [true, false, '']);
});

// ── Results ──

test('a successful turn is not an error', () => {
  const out = describeResult({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
  assert.deepEqual([out.isError, out.text, out.notify], [false, '', 'done']);
});

test('max turns, spend limit and structured-output failures explain themselves', () => {
  const turns = describeResult({ type: 'result', subtype: 'error_max_turns', num_turns: 40, errors: [] });
  assert.equal(turns.isError, true);
  assert.equal(turns.notify, 'error');
  assert.match(turns.text, /turn limit was reached \(40 turns\)/);

  const budget = describeResult({ type: 'result', subtype: 'error_max_budget_usd', total_cost_usd: 5.004, errors: [] });
  assert.match(budget.text, /spend limit was reached \(\$5\.00 so far\)/);

  const structured = describeResult({ type: 'result', subtype: 'error_max_structured_output_retries', errors: [] });
  assert.match(structured.text, /structured output/);
});

test('an execution error shows the errors the CLI reported', () => {
  const out = describeResult({
    type: 'result', subtype: 'error_during_execution', terminal_reason: 'model_error',
    errors: ['API Error: 500 internal', 'second', 'third', 'fourth'],
  });
  assert.equal(out.isError, true);
  const lines = out.text.split('\n');
  assert.match(lines[0], /the model returned an error/);
  assert.equal(lines[1], 'API Error: 500 internal');
  assert.equal(lines.at(-1), '(+1 more)');

  const bare = describeResult({ type: 'result', subtype: 'error_during_execution', errors: [] });
  assert.equal(bare.text, 'The turn ended with an error.');
});

test('a startup failure names the fix', () => {
  const out = describeResult({
    type: 'result', subtype: 'error_during_execution', startup_failure_reason: 'cwd_unavailable',
    errors: ['ENOENT: /gone'],
  });
  assert.match(out.text, /did not start: The working directory was deleted/);
  assert.match(out.text, /ENOENT: \/gone/);
  const unknown = describeResult({ type: 'result', subtype: 'error_during_execution', startup_failure_reason: 'brand_new_reason', errors: [] });
  assert.match(unknown.text, /brand_new_reason/);
});

test("the result an interrupt produces is not reported as a failure", () => {
  const byReason = describeResult({ type: 'result', subtype: 'error_during_execution', terminal_reason: 'aborted_tools', errors: [] });
  assert.deepEqual([byReason.isError, byReason.aborted, byReason.text, byReason.notify], [false, true, '', 'none']);

  const byTiming = describeResult({ type: 'result', subtype: 'error_during_execution', errors: [] }, { recentlyAborted: true });
  assert.equal(byTiming.aborted, true);

  // A real failure right after an abort still shows.
  const real = describeResult({ type: 'result', subtype: 'error_during_execution', errors: ['boom'] }, { recentlyAborted: true });
  assert.equal(real.isError, true);
  assert.match(real.text, /boom/);
});

test('a turn that ended on an API error is an error, printed once', () => {
  const ev = { type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 overloaded' };
  const first = describeResult(ev);
  assert.equal(first.isError, true);
  assert.equal(first.text, 'API Error: 529 overloaded');
  const already = describeResult(ev, { assistantErrorShown: true });
  assert.equal(already.isError, true);
  assert.equal(already.text, '', 'the synthetic assistant message already carries the text');
});

test('the fields older engines put on an error result still show', () => {
  const legacy = describeResult({ type: 'result', subtype: 'error', error: 'legacy failure' });
  assert.equal(legacy.text, 'legacy failure');
});

// ── Unhandled events ──

test('an event with no renderer is described as unknown; liveness frames are ignored', () => {
  assert.equal(eventLabel({ type: 'system', subtype: 'brand_new' }), 'system/brand_new');
  assert.equal(eventLabel({ type: 'brand_new' }), 'brand_new');
  assert.deepEqual(describeEvent({ type: 'future_event' }), { kind: 'unknown', label: 'future_event' });
  assert.equal(describeEvent({ type: 'keep_alive' }).kind, 'ignore');
});

// ── Formatting ──

test('token, duration and reset-time formatting', () => {
  assert.equal(fmtTokens(950), '950');
  assert.equal(fmtTokens(12_340), '12.3k');
  assert.equal(fmtTokens(180_000), '180k');
  assert.equal(fmtTokens(1_250_000), '1.3M');
  assert.equal(fmtDuration(850), '850ms');
  assert.equal(fmtDuration(4200), '4.2s');
  assert.equal(fmtDuration(42_000), '42s');
  assert.equal(fmtDuration(185_000), '3m 05s');
  assert.equal(fmtDuration(-1), '');
  const now = new Date(2026, 9, 3, 10, 0).getTime();
  const later = new Date(2026, 9, 3, 14, 30).getTime();
  assert.equal(fmtResetTime(later, now), '14:30');
  assert.equal(fmtResetTime(Math.floor(later / 1000), now), '14:30', 'seconds are accepted');
  assert.match(fmtResetTime(new Date(2026, 9, 5, 9, 5).getTime(), now), /^Mon 09:05$/);
  assert.equal(fmtResetTime(0, now), '');
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m text'), 'red text');
});

// ── Turn footer ──

const usage = (o = {}) => ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 200000, maxOutputTokens: 32000, ...o });

test("a turn's usage is the difference from the previous cumulative result", () => {
  const first = turnModelUsage({ 'claude-opus-5-5': usage({ inputTokens: 100, cacheReadInputTokens: 900, outputTokens: 50, costUSD: 0.02 }) });
  assert.equal(first.models.length, 1);
  assert.deepEqual([first.models[0].input, first.models[0].output, first.models[0].cost], [1000, 50, 0.02]);

  const second = turnModelUsage({
    'claude-opus-5-5': usage({ inputTokens: 150, cacheReadInputTokens: 1900, outputTokens: 80, costUSD: 0.05 }),
    'claude-haiku-4-5-20251001': usage({ inputTokens: 10, outputTokens: 5, costUSD: 0.001 }),
  }, first.next);
  const opus = second.models.find(m => m.model === 'claude-opus-5-5');
  assert.deepEqual([opus.input, opus.output], [1050, 30]);
  assert.ok(Math.abs(opus.cost - 0.03) < 1e-9);
  assert.equal(second.models.length, 2);

  // A model that did nothing this turn is left out.
  const third = turnModelUsage({
    'claude-opus-5-5': usage({ inputTokens: 150, cacheReadInputTokens: 1900, outputTokens: 80, costUSD: 0.05 }),
    'claude-haiku-4-5-20251001': usage({ inputTokens: 30, outputTokens: 9, costUSD: 0.002 }),
  }, second.next);
  assert.deepEqual(third.models.map(m => m.model), ['claude-haiku-4-5-20251001']);
});

test('a counter that went down means a new process: its value is the turn', () => {
  const prev = { 'claude-opus-5-5': { inputTokens: 5000, outputTokens: 900, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0, webSearchRequests: 0, costUSD: 1.5 } };
  const { models } = turnModelUsage({ 'claude-opus-5-5': usage({ inputTokens: 200, outputTokens: 40, costUSD: 0.01 }) }, prev);
  assert.deepEqual([models[0].input, models[0].output, models[0].cost], [200, 40, 0.01]);
});

test('the turn footer reads duration, steps, tokens, cost and a cut-off', () => {
  const footer = describeTurnFooter({
    type: 'result', subtype: 'success', duration_ms: 12_400, num_turns: 3, stop_reason: 'max_tokens', fast_mode_state: 'on',
    modelUsage: { 'claude-opus-5-5': usage({ inputTokens: 300, cacheReadInputTokens: 12_000, outputTokens: 2100, thinkingTokens: 800, costUSD: 0.0421 }) },
  });
  assert.equal(footer.text, '12s · 3 steps · opus-5-5 12.3k in · 2.1k out · $0.04 · fast mode · cut off at the output limit');
  assert.match(footer.title, /claude-opus-5-5: 300 input, 12,000 cache read, 2,100 output, 800 of it thinking, \$0\.0421/);
  assert.ok(footer.next['claude-opus-5-5']);

  const two = describeTurnFooter({ duration_ms: 1000, num_turns: 1, modelUsage: {
    a: usage({ inputTokens: 1000, outputTokens: 10, costUSD: 0.004 }), b: usage({ inputTokens: 500, outputTokens: 5, costUSD: 0.001 }),
  } });
  assert.equal(two.text, '1.0s · 2 models 1.5k in · 15 out · $0.0050');
  assert.equal(describeTurnFooter({}).text, '', 'nothing to say for an empty result');

  // A resumed session's first result carries its whole history: no baseline, no token claim.
  const resumed = describeTurnFooter({ duration_ms: 3000, num_turns: 2, modelUsage: { m: usage({ inputTokens: 900_000, outputTokens: 50_000, costUSD: 40 }) } }, null, { noBaseline: true });
  assert.equal(resumed.text, '3.0s · 2 steps');
  assert.ok(resumed.next.m, 'but the snapshot is kept, so the next turn can be differenced');
  assert.equal(describeTurnFooter({ duration_ms: 500 }, {}, { stopReason: 'max_tokens' }).text, '500ms · cut off at the output limit');
});

test('a pass-through command that answered only through the result text', () => {
  assert.equal(localCommandOutput({ subtype: 'success', local_command: 'cost', result: '\u001b[1mTotal\u001b[0m: $1' }), 'Total: $1');
  assert.equal(localCommandOutput({ subtype: 'success', result: 'a normal answer' }), '', 'not a local command');
  assert.equal(localCommandOutput({ subtype: 'success', is_error: true, local_command: 'x', result: 'boom' }), '');
});

// ── Compaction, status ──

test('compact_boundary says what the compaction did', () => {
  assert.equal(
    describeCompactBoundary({ compact_metadata: { trigger: 'auto', pre_tokens: 180_000, post_tokens: 40_000, duration_ms: 12_000 } }),
    'Context compacted automatically: 180k → 40k tokens in 12s',
  );
  assert.equal(describeCompactBoundary({ compact_metadata: { trigger: 'manual', pre_tokens: 9000 } }), 'Context compacted: was 9k tokens');
  assert.equal(describeCompactBoundary({}), 'Context compacted');
});

test('system/status carries compaction state and the permission mode', () => {
  const s = describeEvent({ type: 'system', subtype: 'status', status: 'compacting', permissionMode: 'plan' });
  assert.deepEqual([s.kind, s.status, s.permissionMode], ['status', 'compacting', 'plan']);
  const failed = describeEvent({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'prompt too long' });
  assert.deepEqual([failed.status, failed.compactResult, failed.compactError], [null, 'failed', 'prompt too long']);
});

// ── Rate limits ──

test('rate limit states: warning, reached, extra usage, clear', () => {
  const now = new Date(2026, 9, 3, 10, 0).getTime();
  const resetsAt = Math.floor(new Date(2026, 9, 3, 14, 30).getTime() / 1000);
  const warn = describeRateLimit({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.87, resetsAt }, now);
  assert.deepEqual([warn.level, warn.pill], ['warn', '5h 87%']);
  assert.equal(warn.text, 'Approaching your 5-hour limit: 87% used. Resets 14:30.');
  assert.equal(describeRateLimit({ status: 'allowed_warning', rateLimitType: 'seven_day_opus', utilization: 91 }, now).pill, '7d Opus 91%');

  const hit = describeRateLimit({ status: 'rejected', rateLimitType: 'five_hour', resetsAt, overageStatus: 'rejected' }, now);
  assert.equal(hit.level, 'blocked');
  assert.equal(hit.pill, '5h limit · 14:30');
  assert.equal(hit.text, "You've hit your 5-hour limit. Resets 14:30. Extra usage is not available.");

  const extra = describeRateLimit({ status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: true }, now);
  assert.deepEqual([extra.level, extra.pill], ['warn', 'extra usage']);
  const clear = describeRateLimit({ status: 'allowed', rateLimitType: 'five_hour' }, now);
  assert.deepEqual([clear.level, clear.pill, clear.text], ['ok', '', '']);
  assert.notEqual(warn.key, hit.key, 'a state change has a new key, so it is announced once');
  assert.equal(describeEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }).kind, 'rate_limit');
});

test("the CLI's limit sentences are recognised by their prefixes", () => {
  assert.equal(classifyLimitText("You've hit your session limit · resets 3pm"), 'blocked');
  assert.equal(classifyLimitText('This service is disabled for your org'), 'blocked');
  assert.equal(classifyLimitText("You've used 90% of your weekly limit"), 'warn');
  assert.equal(classifyLimitText("You're now using extra usage"), 'notice');
  assert.equal(classifyLimitText('Here is the refactor you asked for'), '');
});

// ── Assistant messages ──

test('assistant wrapper state: typed error, interrupted, cut off, limit sentence', () => {
  const auth = describeAssistantState({ type: 'assistant', uuid: 'u1', error: 'authentication_failed', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Invalid API key' }] } });
  assert.equal(auth.error.kind, 'authentication_failed');
  assert.match(auth.error.hint, /\/login/);
  assert.equal(auth.uuid, 'u1');

  const cut = describeAssistantState({ type: 'assistant', error: 'max_output_tokens', message: { content: [] } });
  assert.equal(cut.truncated, true);
  const stop = describeAssistantState({ type: 'assistant', message: { stop_reason: 'max_tokens', content: [] } });
  assert.deepEqual([stop.truncated, stop.error], [true, null]);

  const aborted = describeAssistantState({ type: 'assistant', aborted: true, timestamp: '2026-10-03T12:00:00Z', supersedes: ['a', 'b', 3], message: { content: [] } });
  assert.deepEqual([aborted.aborted, aborted.timestamp, aborted.supersedes], [true, '2026-10-03T12:00:00Z', ['a', 'b']]);

  const limit = describeAssistantState({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your 5-hour limit" }] } });
  assert.equal(limit.limit, 'blocked');
  const real = describeAssistantState({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: "You've hit your stride with this design" }] } });
  assert.equal(real.limit, '', 'a real reply that happens to start the same way is not styled');
  const novel = describeAssistantState({ type: 'assistant', error: 'brand_new_error', message: { content: [] } });
  assert.equal(novel.error.title, 'brand new error');
});

test('server tool blocks, their results, citations and redacted thinking are split out', () => {
  const extras = splitAssistantBlocks([
    { type: 'text', text: 'Intro' },
    { type: 'redacted_thinking', data: 'xxx' },
    { type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'node test runner' } },
    { type: 'web_search_tool_result', tool_use_id: 'srv1', content: [
      { type: 'web_search_result', title: 'Node docs', url: 'https://nodejs.org/api/test.html' },
      { type: 'web_search_result', title: 'Bad', url: 'javascript:alert(1)' },
    ] },
    { type: 'mcp_tool_use', id: 'm1', name: 'lookup', server_name: 'docs', input: {} },
    { type: 'mcp_tool_result', tool_use_id: 'm1', is_error: false, content: [{ type: 'text', text: 'found it' }] },
    { type: 'web_search_tool_result', tool_use_id: 'srv2', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    { type: 'text', text: 'Answer', citations: [
      { type: 'web_search_result_location', url: 'https://nodejs.org/api/test.html', title: 'Node docs', cited_text: '…' },
      { type: 'web_search_result_location', url: 'https://nodejs.org/api/test.html', title: 'Node docs' },
      { type: 'char_location', document_title: 'spec.pdf' },
    ] },
    { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
  ]);
  assert.equal(extras.any, true);
  assert.equal(extras.redacted, 1);
  assert.deepEqual(extras.serverTools.map(t => [t.id, t.name]), [['srv1', 'web_search'], ['m1', 'docs: lookup']]);
  assert.deepEqual(extras.serverResults[0].links, [{ title: 'Node docs', url: 'https://nodejs.org/api/test.html' }], 'only http(s) links survive');
  assert.equal(extras.serverResults[1].text, 'found it');
  assert.deepEqual([extras.serverResults[2].isError, extras.serverResults[2].text], [true, 'Error: max_uses_exceeded']);
  assert.deepEqual(extras.citations, [{ title: 'Node docs', url: 'https://nodejs.org/api/test.html' }, { title: 'spec.pdf', url: '' }]);
  assert.equal(splitAssistantBlocks([{ type: 'text', text: 'plain' }, { type: 'tool_use', id: 't', name: 'Read', input: {} }]).any, false);
});

test('a tool call is previewed from the JSON typed so far', () => {
  assert.deepEqual(previewPartialToolInput('{"command": "npm run te'), { key: 'command', value: 'npm run te' });
  assert.deepEqual(previewPartialToolInput('{"file_path":"/Users/x/app/src/index.ts","old_string":"a'), { key: 'file_path', value: 'index.ts' });
  assert.deepEqual(previewPartialToolInput('{"description":"Say \\"hi\\"\\nsecond line","prompt":"…'), { key: 'description', value: 'Say "hi"' });
  assert.equal(previewPartialToolInput('{"todos":[{"content":"x"'), null);
  assert.equal(previewPartialToolInput(''), null);
  assert.equal(previewPartialToolInput('{"command":"' + 'x'.repeat(200)).value.length, 60);
});

// ── Slash commands ──

test('the CLI command list: aliases, the builtin row, terminal-only commands', () => {
  const list = normalizeSlashCommands([
    { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost', 'stats'], builtin: true },
    { name: 'deploy', description: 'Project deploy skill', argumentHint: '<env>' },
    { name: 'deploy', description: "Claude Code's own deploy", argumentHint: '', builtin: true },
    { name: '/exit', description: 'Leave' },
    'statusline',
    'review',
  ], { terminalOnly: ['exit', 'statusline'] });
  assert.deepEqual(list.map(c => c.name), ['usage', 'deploy', 'review']);
  assert.equal(list[1].description, "Claude Code's own deploy", 'the builtin row is the one /name runs');
  assert.equal(list[2].description, 'CLI command');

  assert.deepEqual(matchSlashCommands(list, 'us').map(c => [c.name, c.via]), [['usage', '']]);
  assert.deepEqual(matchSlashCommands(list, 'co').map(c => [c.name, c.via]), [['usage', 'cost']], 'an alias finds its command');
  assert.deepEqual(matchSlashCommands(list, ''), []);
  assert.deepEqual(matchSlashCommands(list, 'zz'), []);
  assert.equal(describeEvent({ type: 'system', subtype: 'commands_changed', commands: [{ name: 'a' }] }).kind, 'commands');
});

// ── Session info ──

const INIT = {
  type: 'system', subtype: 'init', model: 'claude-opus-5-5', claude_code_version: '2.1.288', cwd: '/repo',
  apiKeySource: 'none', output_style: 'default', permissionMode: 'default', effort: 'high', fast_mode_state: 'off',
  tools: ['Read', 'Edit', 'Bash'], skills: ['synabun'], agents: ['Explore', 'Plan'],
  plugins: [{ name: 'typesafe', path: '/p', version: '1.2.0' }],
  plugin_errors: [{ plugin: 'stripe@stripe', type: 'mcp', message: 'server failed to start' }],
  mcp_servers: [{ name: 'SynaBun', status: 'connected' }, { name: 'stripe', status: 'needs-auth' }],
  terminal_slash_commands: ['exit'], slash_commands: ['help'],
};

test('the status card is built from what the session reported at init', () => {
  const init = readInit(INIT);
  assert.equal(init.tools, 3);
  assert.deepEqual(init.terminalSlashCommands, ['exit']);
  const rows = statusRows({ init, account: { email: 'me@example.com', subscriptionType: 'max' }, tab: { sessionId: 's1', label: 'Fix tests', sdkVersion: '0.3.288', turns: 4, sessionCost: 1.25 } });
  const row = (k) => rows.find(r => r[0] === k);
  assert.equal(row('Model')[1], 'claude-opus-5-5');
  assert.equal(row('Claude Code')[1], '2.1.288 · SDK 0.3.288');
  assert.equal(row('Account')[1], 'me@example.com · max');
  assert.equal(row('Credential')[1], 'claude.ai sign-in');
  assert.deepEqual(row('MCP servers').slice(1), ['SynaBun (connected), stripe (needs-auth)', 'warn']);
  assert.deepEqual(row('Plugin error').slice(1), ['stripe@stripe: server failed to start', 'warn']);
  assert.equal(row('Plugins')[1], 'typesafe 1.2.0');
  assert.equal(row('Cost')[1], '$1.2500');
  assert.equal(row('Output style'), undefined, 'the default style is not worth a row');
  assert.equal(row('Fast mode'), undefined);

  const before = statusRows({ init: null, tab: {} });
  assert.equal(before[0][1], '(new)');
  assert.match(before[1][1], /Send a message to start the session/);
});

// ── The remaining events ──

test('informational and notification messages map to rows by level', () => {
  const warn = describeEvent({ type: 'system', subtype: 'informational', level: 'warning', content: 'Hook blocked the edit' });
  assert.deepEqual([warn.kind, warn.level, warn.text], ['row', 'warn', 'Hook blocked the edit']);
  assert.equal(describeEvent({ type: 'system', subtype: 'informational', level: 'info', content: 'x' }).level, 'transcript');
  assert.equal(describeEvent({ type: 'system', subtype: 'informational', level: 'notice', content: 'x' }).level, 'status');
  assert.equal(describeEvent({ type: 'system', subtype: 'informational', level: 'suggestion', content: 'x' }).level, 'notice');
  assert.equal(describeEvent({ type: 'system', subtype: 'informational', level: 'notice', content: 'Stop hook', prevent_continuation: true }).level, 'warn');
  assert.equal(describeEvent({ type: 'system', subtype: 'informational', level: 'notice', content: 'p', tool_use_id: 't1' }).key, 'info:t1');
  assert.equal(describeEvent({ type: 'system', subtype: 'informational', level: 'notice', content: '  ' }).kind, 'ignore');

  const note = describeEvent({ type: 'system', subtype: 'notification', key: 'update', text: 'Update available', priority: 'high' });
  assert.deepEqual([note.kind, note.level, note.key], ['row', 'warn', 'notif:update']);
  assert.equal(describeEvent({ type: 'system', subtype: 'notification', key: 'k', text: 't', priority: 'low' }).level, 'status');
});

test('api_retry, tool_progress and thinking_tokens are progress, not rows of their own', () => {
  const retry = describeEvent({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: 'overloaded' });
  assert.equal(retry.kind, 'retry');
  assert.equal(retry.verb, 'Retrying 2/10 · overloaded');
  assert.equal(retry.text, 'API request failed (overloaded, 529). Retry 2/10 in 4.0s.');
  assert.equal(retry.key, 'api_retry');
  assert.match(describeEvent({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 1, retry_delay_ms: 0, error_status: null, error: 'unknown', no_response: { waited_ms: 1, retry_wait_ms: 1 } }).text, /no response/);

  const progress = describeEvent({ type: 'tool_progress', tool_use_id: 't1', tool_name: 'Bash', elapsed_time_seconds: 75, subagent_retry: { attempt: 2, max_retries: 5, error_category: 'rate_limit' } });
  assert.deepEqual([progress.kind, progress.toolUseId, progress.elapsed, progress.retry], ['tool_progress', 't1', 75, 'retrying 2/5 (rate limit)']);
  assert.deepEqual(describeEvent({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 1200, estimated_tokens_delta: 40 }).tokens, 1200);
});

test('denials, refusals, summaries, recalls, resets and the minor events', () => {
  const denied = describeEvent({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't9', decision_reason_type: 'rule', decision_reason: 'Bash(rm:*) is denied', message: 'Permission denied' });
  assert.deepEqual([denied.kind, denied.toolUseId, denied.reasonType, denied.reason], ['denied', 't9', 'rule', 'Bash(rm:*) is denied']);

  const fallback = describeEvent({
    type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry', scope: 'session',
    original_model: 'claude-fable-5-1', fallback_model: 'claude-opus-5-5', content: 'The request was declined.',
    api_refusal_category: 'cyber', api_refusal_explanation: 'Looks like exploit development.',
    retracted_message_uuids: ['m1', 'm2'], refused_user_message_uuid: 'u7',
  });
  assert.equal(fallback.kind, 'refusal');
  assert.deepEqual(fallback.retracted, ['m1', 'm2']);
  assert.equal(fallback.refusedUserUuid, 'u7');
  assert.equal(fallback.sessionModelChanged, true);
  assert.match(fallback.text, /continues on claude-opus-5-5 \(was claude-fable-5-1\)/);
  assert.match(fallback.text, /Looks like exploit development/);
  const local = describeEvent({ type: 'system', subtype: 'model_refusal_fallback', direction: 'retry', scope: 'local', original_model: 'a', fallback_model: 'b', content: 'x' });
  assert.equal(local.sessionModelChanged, false);
  const none = describeEvent({ type: 'system', subtype: 'model_refusal_no_fallback', original_model: 'a', content: '' });
  assert.deepEqual([none.kind, none.text, none.fallbackModel], ['refusal', 'The model declined this request.', '']);

  const summary = describeEvent({ type: 'tool_use_summary', summary: 'Read 4 files', preceding_tool_use_ids: ['a', 'b'] });
  assert.deepEqual([summary.kind, summary.text, summary.toolUseIds], ['summary', 'Read 4 files', ['a', 'b']]);

  const recall = describeEvent({ type: 'system', subtype: 'memory_recall', mode: 'select', memories: [{ path: '/m/a.md', scope: 'personal' }, { path: '/m/b.md', scope: 'team' }] });
  assert.deepEqual([recall.kind, recall.text], ['memory_recall', 'Recalled 2 Claude memory files']);
  assert.equal(describeEvent({ type: 'system', subtype: 'memory_recall', mode: 'select', memories: [] }).kind, 'ignore');

  const reset = describeEvent({ type: 'conversation_reset', new_conversation_id: 'n', trigger: 'plan_mode_exit', timestamp: '2026-10-03T12:00:00Z' });
  assert.deepEqual([reset.kind, reset.text], ['reset', 'Conversation cleared to implement the plan']);

  const auth = describeEvent({ type: 'auth_status', isAuthenticating: true, output: ['Open this URL', ''], error: 'expired' });
  assert.deepEqual([auth.kind, auth.authenticating, auth.text, auth.error], ['auth', true, 'Open this URL', 'expired']);

  const out = describeEvent({ type: 'system', subtype: 'local_command_output', content: '\u001b[1mStatus\u001b[0m ok' });
  assert.deepEqual([out.kind, out.text], ['command_output', 'Status ok']);

  assert.match(describeEvent({ type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'github', elicitation_id: 'e' }).text, /github/);
  assert.equal(describeEvent({ type: 'system', subtype: 'plugin_install', status: 'failed', name: 'acme', error: 'no network' }).level, 'warn');
  assert.equal(describeEvent({ type: 'system', subtype: 'plugin_install', status: 'started' }).key, 'plugin_install');
  assert.equal(describeEvent({ type: 'system', subtype: 'files_persisted', files: [{ filename: 'a', file_id: '1' }], failed: [{ filename: 'b', error: 'x' }] }).text, 'Files persisted: 1 file saved, 1 failed (b).');
  assert.equal(describeEvent({ type: 'system', subtype: 'files_persisted', files: [], failed: [] }).kind, 'ignore');
  assert.match(describeEvent({ type: 'active_goal', value: { condition: 'tests pass', iterations: 2, set_at: 1, tokens_at_start: 0 } }).text, /^Goal: tests pass \(iteration 2\)/);
  assert.equal(describeEvent({ type: 'active_goal', value: null }).text, 'Goal cleared.');
  assert.equal(describeEvent({ type: 'system', subtype: 'control_request_progress', request_id: 'r', status: 'started' }).kind, 'ignore');
  assert.equal(describeEvent({ type: 'system', subtype: 'session_info', info: { account: { email: 'a@b.c' } } }).kind, 'session_info');
});

// ── Panel wiring (source contracts) ──

test('the panel reads the hello through the module and keeps the capability set', () => {
  const body = fnBody(panel, 'function _processTabMsg(tab, msg) {');
  assert.match(body, /applyEngineHello\(tab, msg, \{/);
  assert.match(body, /tab\.capabilities = new Set\(hello\.capabilities\)/);
  assert.match(body, /if \(hello\.unavailable\) \{[^}]*break; \}/, 'an unavailable engine leaves the tab as it was');
  assert.match(body, /msg\.code === 'engine_unavailable' && tab\.engineError/);
  assert.match(body, /default:\n\s+\/\/[^\n]*\n\s+noteUnhandledEvent\(tab, `ws:\$\{msg\.type\}`\)/, 'unknown wire messages are noted, not dropped');
});

test('the result branch reports failures and never calls an interrupt one', () => {
  const body = fnBody(panel, 'function handleTabEvent(tab, ev) {');
  assert.match(body, /const outcome = describeResult\(ev, \{/);
  assert.match(body, /if \(outcome\.text\) appendError\(tab, outcome\.text\)/);
  assert.match(body, /else if \(outcome\.notify === 'done'\) notify\('panel', NOTIF_TYPE\.DONE/);
  assert.doesNotMatch(body, /\(ev\.error \|\| ev\.result\)/, 'the old check needed fields an SDK error result does not have');
  assert.match(body, /renderSdkEvent\(tab, scope, ev\);\n\}/, 'whatever no branch consumed goes to the fallback');
});

test('assistant messages go through the extras and the wrapper annotations', () => {
  const body = fnBody(panel, 'function renderAssistant(tab, msg) {');
  assert.match(body, /const extras = splitAssistantBlocks\(content\)/);
  assert.match(body, /!thinks\.length && !extras\.any\) return;/, 'a message with only server blocks still renders');
  assert.equal(body.match(/renderAssistantExtras\(tab, wrap, extras, \{ showThinking: showThinks \}\)/g).length, 2, 'both the update and the new-row path');
  const ev = fnBody(panel, 'function handleTabEvent(tab, ev) {');
  assert.match(ev, /annotateAssistantRow\(tab, scope, ev\)/);
  assert.match(ev, /renderCompactBoundary\(tab, ev\)/);
  assert.match(ev, /tab\.init = readInit\(ev\)/);
});

test('the result branch adds the turn footer and settles denied tools', () => {
  const body = fnBody(panel, 'function handleTabEvent(tab, ev) {');
  assert.match(body, /describeTurnFooter\(ev, usageBase, \{ stopReason: tab\._streamStopReason, noBaseline: usageBase === null \}\)/);
  assert.match(body, /tab\._modelUsagePrev = \{ sid: usageSid, usage: footer\.next \}/);
  assert.match(body, /if \(!tab\.sessionId\) tab\._freshSessionId = ev\.session_id;/, 'a session born in this tab starts from zero');
  assert.match(body, /if \(!outcome\.aborted\) appendTurnFooter\(tab, footer\)/);
  assert.match(body, /markDeniedFromResult\(tab, ev\.permission_denials\)/);
  assert.match(body, /renderLocalCommandResult\(tab, localCommandOutput\(ev\)\)/);
});

test('the stream handler previews tool input and keeps the stop reason', () => {
  const body = fnBody(panel, 'function handleStreamDelta(tab, apiEvent) {');
  assert.match(body, /noteToolInputStart\(tab\._stream, tab\._stream\.blockIdx, cb\)/);
  assert.match(body, /delta\.type === 'input_json_delta'/);
  assert.match(body, /apiEvent\.usage\?\.output_tokens != null/, 'a zero output-token update is applied');
  assert.match(body, /tab\._streamStopReason = apiEvent\.delta\.stop_reason/);
});

test('the slash menu uses the CLI list: aliases, terminal-only, capability-gated entries', () => {
  assert.match(fnBody(panel, 'function _serverSlashCommands() {'), /normalizeSlashCommands\(list, \{ terminalOnly: tab\?\.init\?\.terminalSlashCommands \}\)/);
  const hints = fnBody(panel, 'async function showSlashHints(filter) {');
  assert.match(hints, /matchSlashCommands\(merged, q\)/);
  assert.match(hints, /s\.guess && serverNames\.size && !serverNames\.has/, 'a guessed command the CLI does not list is dropped');
  assert.match(hints, /!needs \|\| hasCapability\(tabNow, needs\)/);
  assert.match(panel, /name: 'reload-skills'[^\n]*needs: 'reload_skills'/);
  assert.doesNotMatch(panel, /SDK_NATIVE_COMMANDS = new Set\(\[[^\]]*'status'/, '/status is answered from init, not passed through');
  assert.match(fnBody(panel, 'function runSlashCommand(tab, raw) {'), /statusRows\(\{ init: tab\.init \|\| null, account: tab\.accountInfo \|\| null, tab \}\)/);
});

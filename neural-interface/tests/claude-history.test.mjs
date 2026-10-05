import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { historyRowsFromEntry, slimToolUseResult, pageHistory } from '../lib/claude-history.js';

// The sidepanel's history endpoint only matched top-level `tool_result` lines,
// which Claude Code transcripts do not have: a result is a block inside a
// `type:"user"` line, with the typed output next to it as `toolUseResult`. So a
// reopened session showed every tool call without its result. These tests pin
// the line format the parser now reads.

const userLine = (content, extra = {}) => ({ type: 'user', uuid: 'u-1', timestamp: '2026-10-03T12:00:00Z', message: { role: 'user', content }, ...extra });

test('a typed prompt is a user row with its uuid, and counts as a turn', () => {
  const out = historyRowsFromEntry(userLine('fix the tests'));
  assert.deepEqual(out.rows, [{ role: 'user', text: 'fix the tests', uuid: 'u-1', timestamp: '2026-10-03T12:00:00Z' }]);
  assert.equal(out.turn, true);
  const blocks = historyRowsFromEntry(userLine([{ type: 'text', text: 'with an image' }, { type: 'image', source: {} }]));
  assert.equal(blocks.rows[0].text, 'with an image');
});

test('lines the CLI injected are not shown as something the user typed', () => {
  assert.deepEqual(historyRowsFromEntry(userLine('<local-command-caveat>…', { isMeta: true })).rows, []);
  assert.deepEqual(historyRowsFromEntry(userLine('This session is being continued…', { isCompactSummary: true })).rows, []);
  assert.equal(historyRowsFromEntry(userLine('x', { isMeta: true })).turn, false);
});

test('a tool result inside a user line becomes a result row with its typed output', () => {
  const out = historyRowsFromEntry(userLine(
    [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok\n' }], is_error: false }],
    { toolUseResult: { stdout: 'ok\n', stderr: '', interrupted: false } },
  ));
  assert.equal(out.turn, false, 'a tool result is not a prompt');
  assert.deepEqual(out.rows, [{
    role: 'tool_result', toolUseId: 'toolu_1', text: 'ok\n', isError: false,
    structured: { stdout: 'ok\n', stderr: '', interrupted: false },
  }]);
  const err = historyRowsFromEntry(userLine([{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'Permission denied', is_error: true }], { toolUseResult: 'Error: Permission denied' }));
  assert.deepEqual([err.rows[0].isError, err.rows[0].text, err.rows[0].structured], [true, 'Permission denied', 'Error: Permission denied']);
  // Two results on one line: the single typed output cannot be attributed.
  const two = historyRowsFromEntry(userLine([
    { type: 'tool_result', tool_use_id: 'a', content: 'A' }, { type: 'tool_result', tool_use_id: 'b', content: 'B' },
  ], { toolUseResult: { x: 1 } }));
  assert.deepEqual(two.rows.map(r => [r.toolUseId, 'structured' in r]), [['a', false], ['b', false]]);
});

test('an assistant line carries text, thinking, tool calls and the context usage', () => {
  const out = historyRowsFromEntry({
    type: 'assistant', uuid: 'a-1',
    message: { content: [
      { type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Running it.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
    ], usage: { input_tokens: 10, cache_read_input_tokens: 900, output_tokens: 5 } },
  });
  assert.deepEqual(out.rows, [{ role: 'assistant', text: 'Running it.', thinking: 'hmm', tools: [{ id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }], uuid: 'a-1' }]);
  assert.equal(out.usage.cache_read_input_tokens, 900);
  const synthetic = historyRowsFromEntry({ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }], usage: { input_tokens: 0, output_tokens: 0 } } });
  assert.equal(synthetic.usage, null, 'an all-zero usage says nothing about the context');
  const sidechain = historyRowsFromEntry({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }], usage: { input_tokens: 5 } } });
  assert.equal(sidechain.usage, null, "a subagent's context is not the session's");
});

test('compaction markers and older top-level result lines', () => {
  const boundary = historyRowsFromEntry({ type: 'system', subtype: 'compact_boundary', uuid: 's-1', compactMetadata: { trigger: 'auto', preTokens: 180000, postTokens: 40000 } });
  assert.deepEqual(boundary.rows[0].compact_metadata, { trigger: 'auto', pre_tokens: 180000, post_tokens: 40000, duration_ms: undefined });
  assert.equal(boundary.rows[0].role, 'system');
  const legacy = historyRowsFromEntry({ type: 'tool_result', tool_use_id: 'old-1', content: 'done' });
  assert.deepEqual(legacy.rows, [{ role: 'tool_result', toolUseId: 'old-1', text: 'done', isError: false }]);
  assert.deepEqual(historyRowsFromEntry({ type: 'ai-title', title: 'x' }).rows, []);
  assert.deepEqual(historyRowsFromEntry({ type: 'system', subtype: 'stop_hook_summary' }).rows, []);
  assert.deepEqual(historyRowsFromEntry(null).rows, []);
});

test('typed output is slimmed: whole-file copies and binary payloads never travel', () => {
  const slim = slimToolUseResult({
    filePath: '/a.js', originalFile: 'x'.repeat(50_000), structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
    file: { base64: 'AAAA', type: 'image/png', originalSize: 10 }, stdout: 'y'.repeat(30_000),
  });
  assert.equal('originalFile' in slim, false);
  assert.equal('base64' in slim.file, false);
  assert.equal(slim.file.originalSize, 10);
  assert.equal(slim.stdout.length, 20_001);
  assert.deepEqual(slim.structuredPatch[0].lines, ['-a', '+b']);
  assert.equal(slimToolUseResult(Array.from({ length: 500 }, (_, i) => i)).length, 200);
  assert.equal(slimToolUseResult(null), undefined);
  assert.equal(slimToolUseResult('plain'), 'plain');
  // Still too large after slimming: dropped, the text result remains.
  assert.equal(slimToolUseResult(Array.from({ length: 200 }, () => 'z'.repeat(19_000))), undefined);
});

test('paging: the last page by default, the page before an index on request', () => {
  const rows = Array.from({ length: 1200 }, (_, i) => ({ role: i % 3 === 2 ? 'tool_result' : (i % 3 === 0 ? 'user' : 'assistant'), n: i }));
  const last = pageHistory(rows, { limit: 500 });
  assert.deepEqual([last.total, last.start, last.messages.length, last.messages[0].n], [1200, 700, 500, 700]);
  assert.equal(last.visible, 800, 'prompts and replies only');
  const earlier = pageHistory(rows, { limit: 500, before: 700 });
  assert.deepEqual([earlier.start, earlier.messages.length, earlier.messages.at(-1).n], [200, 500, 699]);
  const first = pageHistory(rows, { limit: 500, before: 200 });
  assert.deepEqual([first.start, first.messages.length], [0, 200]);
  assert.deepEqual(pageHistory(rows, { limit: 5000 }).messages.length, 1000, 'the limit is capped');
  assert.deepEqual(pageHistory(rows, { limit: 10, before: 'abc' }).start, 1190, 'a bad index means the last page');
  assert.deepEqual(pageHistory([], {}), { messages: [], total: 0, start: 0, visible: 0 });
});

test('the endpoint reads transcripts through this module', async () => {
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf("app.get('/api/claude-code/sessions/:sessionId/messages'");
  assert.ok(start > 0);
  const body = server.slice(start, server.indexOf('// --- Session Indexing ---', start));
  // The collector parses each line, follows the chain and pages (review R09 / R13).
  assert.match(body, /const collector = createHistoryCollector\(\);/);
  assert.match(body, /collector\.add\(JSON\.parse\(line\)\)/);
  assert.match(body, /collector\.finish\(\{ limit, before: req\.query\.before \?\? null \}\)/);
  assert.match(body, /visible: page\.visible/);
  assert.match(body, /turns: page\.turns/);
  assert.doesNotMatch(body, /obj\.type === 'tool_result' \|\| obj\.type === 'tool'/, 'the parser lives in lib/claude-history.js');
});

// ── Review 1: R13 (active branch), R09 (page boundaries), R06 (chain parents) ──

import { createHistoryCollector, createChainIndex } from '../lib/claude-history.js';

const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const prompt = (n, parent, text) => ({ type: 'user', uuid: u(n), parentUuid: parent == null ? null : u(parent), message: { role: 'user', content: text } });
const reply = (n, parent, text) => ({ type: 'assistant', uuid: u(n), parentUuid: u(parent), message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 10 + n } } });
const call = (n, parent, id, name = 'Bash') => ({ type: 'assistant', uuid: u(n), parentUuid: u(parent), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { command: 'ls' } }] } });
const result = (n, parent, id, text = 'ok') => ({ type: 'user', uuid: u(n), parentUuid: u(parent), toolUseResult: { stdout: text }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const collect = (entries, page = {}) => { const c = createHistoryCollector(); for (const e of entries) c.add(e); return c.finish(page); };
const texts = (r) => r.messages.map(m => m.text || m.toolUseId || m.tools?.[0]?.id);

test('R13: a rewound conversation replays only its active branch', () => {
  // 1 → 2 → 3(prompt B) → 4 ; rewound to 2, continued with 5(prompt C) → 6.
  const entries = [
    prompt(1, null, 'A'), reply(2, 1, 'a'),
    prompt(3, 2, 'B (abandoned)'), reply(4, 3, 'b (abandoned)'),
    { type: 'file-history-snapshot', messageId: u(3) },
    prompt(5, 2, 'C'), reply(6, 5, 'c'),
  ];
  const r = collect(entries);
  assert.deepEqual(texts(r), ['A', 'a', 'C', 'c']);
  assert.equal(r.turns, 2, 'the abandoned prompt is not a turn of this conversation');
  assert.equal(r.visible, 4);
  assert.equal(r.usage.input_tokens, 16, 'the gauge reads the active branch');
  assert.equal(r.abandoned, 2);
  // Rewound and nothing sent since: the branch on disk is still the conversation.
  assert.deepEqual(texts(collect(entries.slice(0, 4))), ['A', 'a', 'B (abandoned)', 'b (abandoned)']);
});

test('R13: a compaction, a sidechain and a broken link never lose history', () => {
  // The chain restarts at a compact boundary and points back with logicalParentUuid.
  const compacted = [
    prompt(1, null, 'before'), reply(2, 1, 'old'),
    { type: 'system', subtype: 'compact_boundary', uuid: u(3), parentUuid: null, logicalParentUuid: u(2), compactMetadata: { trigger: 'auto', preTokens: 9, postTokens: 3 } },
    { type: 'user', uuid: u(4), parentUuid: u(3), isCompactSummary: true, message: { role: 'user', content: 'summary' } },
    prompt(5, 4, 'after'), reply(6, 5, 'new'),
  ];
  assert.deepEqual(collect(compacted).messages.map(m => m.text || m.subtype), ['before', 'old', 'compact_boundary', 'after', 'new']);
  // A subagent's inline entries are not the main conversation.
  const side = [prompt(1, null, 'A'), reply(2, 1, 'a'), { ...prompt(7, null, 'subagent prompt'), isSidechain: true }, { ...reply(8, 7, 'subagent reply'), isSidechain: true }, prompt(3, 2, 'B'), reply(4, 3, 'b')];
  assert.deepEqual(texts(collect(side)), ['A', 'a', 'B', 'b']);
  // A parent that is not in the file: everything before the break is kept as it was.
  const broken = [prompt(1, null, 'A'), reply(2, 1, 'a'), prompt(3, 99, 'B'), reply(4, 3, 'b')];
  assert.deepEqual(texts(collect(broken)), ['A', 'a', 'B', 'b']);
  // Lines without a uuid (older transcripts) are kept.
  const legacy = [{ type: 'user', message: { role: 'user', content: 'old style' } }, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } }];
  assert.deepEqual(texts(collect(legacy)), ['old style', 'reply']);
  assert.deepEqual(collect([]).messages, []);
});

test('R09: a page never starts between a tool call and its result', () => {
  // Parallel calls are separate assistant lines, results follow later.
  const entries = [prompt(1, null, 'go'), reply(2, 1, 'first'), call(3, 2, 'toolu_A'), call(4, 3, 'toolu_B'), result(5, 4, 'toolu_A', 'out A'), result(6, 5, 'toolu_B', 'out B'), reply(7, 6, 'done')];
  // limit 3 would start at result A: the page is extended back to its call.
  const page = collect(entries, { limit: 3 });
  assert.deepEqual(texts(page), ['toolu_A', 'toolu_B', 'out A', 'out B', 'done'], 'both calls come with their results');
  assert.equal(page.start, 2);
  assert.equal(page.total, 7);
  // "Load earlier" from that start gets the rest, without overlap.
  assert.deepEqual(texts(collect(entries, { limit: 3, before: page.start })), ['go', 'first']);
  // A result whose call is nowhere (cut transcript) does not walk back forever.
  const orphan = [prompt(1, null, 'x'), reply(2, 1, 'y'), result(3, 2, 'toolu_gone'), reply(4, 3, 'z')];
  assert.deepEqual(collect(orphan, { limit: 2 }).start, 2);
});

test('R06: the entry a prompt follows comes from the transcript chain', () => {
  const chain = createChainIndex();
  const entries = [
    prompt(1, null, 'first'), call(2, 1, 'toolu_A'), result(3, 2, 'toolu_A'),            // an interrupted turn: ends on the carrier
    prompt(4, 3, 'second'), reply(5, 4, 'answer'),
    { type: 'system', subtype: 'turn_duration', uuid: u(6), parentUuid: u(5) },
    { type: 'attachment', uuid: u(7), parentUuid: u(6), attachment: { type: 'structured_output' } },
    prompt(8, 7, 'third'),
  ];
  for (const e of entries) chain.add(e);
  // Rewind: the last chain entry of the kept turn, whatever it is.
  assert.equal(chain.parentOf(u(4)), u(3), 'the tool-result carrier, not the assistant row before it');
  assert.equal(chain.parentOf(u(8)), u(7), 'the attachment that closes the turn');
  // Fork takes a message id: the nearest prompt, reply or carrier.
  assert.equal(chain.parentOf(u(8), { messagesOnly: true }), u(5));
  assert.equal(chain.parentOf(u(4), { messagesOnly: true }), u(3));
  assert.equal(chain.parentOf(u(1)), '', 'the first prompt has nothing before it');
  assert.equal(chain.parentOf(u(99)), null, 'an entry that is not in the transcript');
  assert.equal(chain.parentOf(''), null);
});

test('R10: one tool result can be asked for by its call id', () => {
  const c = createHistoryCollector();
  for (const e of [prompt(1, null, 'go'), call(2, 1, 'toolu_A'), result(3, 2, 'toolu_A', 'x'.repeat(5000)), reply(4, 3, 'done')]) c.add(e);
  assert.equal(c.toolResult('toolu_A').text.length, 5000, 'the whole recorded text, not the clipped view');
  assert.equal(c.toolResult('toolu_missing'), null);
  assert.equal(c.toolResult('../x'), null);
  assert.equal(c.toolResult(undefined), null);
});

test('R13: parallel tool calls and their results are part of the conversation, not a branch', () => {
  // One API message, three tool calls: three assistant lines with the same
  // message id. Results hang off their own call; the chain continues from one.
  const par = (n, parent, id) => ({ type: 'assistant', uuid: u(n), parentUuid: u(parent), message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: {} }] } });
  const entries = [
    prompt(1, null, 'read three files'),
    par(2, 1, 'toolu_A'), par(3, 2, 'toolu_B'),
    result(4, 2, 'toolu_A', 'file A'),               // a twig off the first call
    par(5, 4, 'toolu_C'),                            // a later block of the same message, written after A returned
    result(6, 3, 'toolu_B', 'file B'),               // a twig off the second call
    result(7, 5, 'toolu_C', 'file C'),
    reply(8, 7, 'all read'),
    // An abandoned branch next to it is still left out.
    prompt(9, 8, 'old question'), call(10, 9, 'toolu_X'), result(11, 10, 'toolu_X', 'old'),
    prompt(12, 8, 'new question'), reply(13, 12, 'answer'),
  ];
  const r = collect(entries, { limit: 100 });
  assert.deepEqual(r.messages.filter(m => m.role === 'tool_result').map(m => m.text), ['file A', 'file B', 'file C']);
  assert.deepEqual(r.messages.filter(m => m.role === 'assistant' && m.tools).map(m => m.tools[0].id), ['toolu_A', 'toolu_B', 'toolu_C']);
  assert.deepEqual(r.messages.filter(m => m.role === 'user').map(m => m.text), ['read three files', 'new question']);
  assert.equal(r.abandoned, 3);
});

// ── C51: what else a transcript holds that a reopened session should show ──

test('C51: slash commands, their output, queued prompts and notices replay as what they were', () => {
  const rows = (obj) => historyRowsFromEntry(obj).rows;
  // A typed slash command is stored as XML wrappers: show the command, not the markup.
  const cmd = historyRowsFromEntry({ type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args>full</command-args>' } });
  assert.deepEqual(cmd.rows, [{ role: 'user', text: '/context full', command: true, uuid: 'c1' }]);
  assert.equal(cmd.turn, false, 'a local command is not a model turn');
  assert.deepEqual(rows({ type: 'user', message: { role: 'user', content: '<command-name>/mcp</command-name><command-args></command-args>' } }), [{ role: 'user', text: '/mcp', command: true }]);
  // Its output.
  assert.deepEqual(rows({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Context: 12k of 200k</local-command-stdout>' } }), [{ role: 'system', subtype: 'local_command_output', text: 'Context: 12k of 200k' }]);
  assert.deepEqual(rows({ type: 'user', message: { role: 'user', content: '<local-command-stderr>boom</local-command-stderr>' } }), [{ role: 'system', subtype: 'local_command_output', text: 'boom', isError: true }]);
  assert.deepEqual(rows({ type: 'user', message: { role: 'user', content: '<local-command-stdout></local-command-stdout>' } }), [], 'an empty output is no row');
  // Shell mode.
  assert.deepEqual(rows({ type: 'user', message: { role: 'user', content: '<bash-input>git status</bash-input>' } }), [{ role: 'user', text: '! git status', command: true }]);
  assert.deepEqual(rows({ type: 'user', message: { role: 'user', content: '<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>' } }), [{ role: 'system', subtype: 'local_command_output', text: 'clean' }]);
  // A turn nobody typed says what started it; a prompt queued while Claude worked is a prompt.
  assert.deepEqual(rows({ type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', prompt: '<task-notification>…</task-notification>', commandMode: 'task-notification', origin: { kind: 'task-notification', producer: 'session-task' } } }),
    [{ role: 'system', subtype: 'origin', origin: { kind: 'task-notification', producer: 'session-task' } }]);
  assert.deepEqual(rows({ type: 'attachment', uuid: 'q2', attachment: { type: 'queued_command', prompt: 'also fix the README', commandMode: 'prompt' } }), [{ role: 'user', text: 'also fix the README', queued: true }]);
  assert.deepEqual(rows({ type: 'attachment', attachment: { type: 'hook_success' } }), []);
  // A warning the CLI wrote into the conversation.
  assert.deepEqual(rows({ type: 'system', subtype: 'informational', level: 'warning', content: 'Usage limit close', uuid: 's1' }), [{ role: 'system', subtype: 'informational', level: 'warning', text: 'Usage limit close' }]);
  assert.deepEqual(rows({ type: 'system', subtype: 'informational', level: 'info', content: 'x', isMeta: true }), [], 'meta notes stay out');
  assert.deepEqual(rows({ type: 'system', subtype: 'api_error', level: 'error' }), [], 'a retried API error is not history');
  // Text that only looks like a wrapper in the middle of a prompt stays a prompt.
  assert.equal(rows({ type: 'user', message: { role: 'user', content: 'why does <command-name> show up?' } })[0].text, 'why does <command-name> show up?');
});

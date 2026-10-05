// OpenCode panel, cluster 5: tool cards, todos, cost and per-message meta.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelStore } from '../public/shared/ocp-v2/ocp-v2-state.js';
import { applyEvent } from '../public/shared/ocp-v2/ocp-v2-events.js';
import { rehydrateSessionState } from '../public/shared/ocp-v2/ocp-v2-rehydrate.js';
import { partSignature } from '../public/shared/ocp-v2/ocp-v2-render-logic.js';
import {
  toolCardView, toolCardSignature, toolLabel, toolKey, formatDuration, truncateOutput, parseUnifiedDiff, diffStat,
  todoView, todoWidgetVisible, formatCost, formatTokens, sessionCostOf, messageMetaText,
  TOOL_OUTPUT_MAX_LINES,
} from '../public/shared/ocp-v2/ocp-v2-tools-logic.js';

const tool = (name, state) => ({ id: 'prt_1', callID: 'call_1', messageID: 'msg_1', type: 'tool', tool: name, state });

// ── O12 tool cards ──────────────────────────────────────────────────────────

test('bash card: the shape a 1.18.34 serve really sends', () => {
  // Captured from `session.shell` on a live serve.
  const view = toolCardView(tool('bash', {
    status: 'completed', input: { command: 'echo hi && ls' }, output: 'hi\nREADME.md\n', title: '',
    metadata: { output: 'hi\nREADME.md\n' }, time: { start: 1791057076019, end: 1791057076031 },
  }));
  assert.equal(view.label, 'Bash');
  assert.equal(view.iconKey, 'bash');
  assert.equal(view.title, 'echo hi && ls');
  assert.equal(view.meta, '12ms');
  assert.deepEqual(view.sections.map((s) => s.kind), ['code', 'output']);
  assert.deepEqual([view.sections[0].text, view.sections[0].prompt], ['echo hi && ls', '$']);
  assert.equal(view.sections[1].text, 'hi\nREADME.md\n');
  assert.equal(view.sections[1].truncated, false);
  assert.equal(view.copyText, 'echo hi && ls');
  assert.equal(view.defaultExpanded, false, 'a finished command is collapsed');
});

test('bash card: running or failed is expanded; description, exit code and long output', () => {
  const running = toolCardView(tool('bash', { status: 'running', input: { command: 'npm test', description: 'Run the test suite' } }));
  assert.equal(running.title, 'Run the test suite');
  assert.equal(running.defaultExpanded, true);
  assert.equal(running.meta, '');

  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const failed = toolCardView(tool('bash', {
    status: 'error', input: { command: 'make' }, error: 'Command failed', metadata: { output: long, exit: 2 },
    time: { start: 0, end: 61_000 },
  }));
  assert.equal(failed.defaultExpanded, true);
  assert.equal(failed.meta, '1m 1s · exit 2');
  const output = failed.sections.find((s) => s.kind === 'output');
  assert.equal(output.truncated, true);
  assert.equal(output.text.split('\n').length, TOOL_OUTPUT_MAX_LINES);
  assert.equal(output.hiddenLines, 200 - TOOL_OUTPUT_MAX_LINES);
  assert.equal(output.full, long);
  assert.deepEqual(failed.sections.at(-1), { kind: 'error', text: 'Command failed' });
});

test('edit / write / patch cards show a diff with its +/− count', () => {
  const diff = ['Index: /p/a.js', '===', '--- /p/a.js', '+++ /p/a.js', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new', '+more', ''].join('\n');
  const edit = toolCardView(tool('edit', {
    status: 'completed', input: { filePath: '/p/a.js', oldString: 'old', newString: 'new' }, title: 'a.js', metadata: { diff },
  }));
  assert.equal(edit.label, 'Edit');
  assert.equal(edit.title, 'a.js');
  assert.equal(edit.meta, '+2 −1');
  const section = edit.sections[0];
  assert.equal(section.kind, 'diff');
  assert.deepEqual(section.lines.map((l) => l.type), ['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'add']);
  assert.deepEqual([section.additions, section.deletions, section.hiddenLines], [2, 1, 0]);
  assert.equal(edit.copyText, '/p/a.js');

  // No diff in the metadata: the old and new strings stand in.
  const bare = toolCardView(tool('edit', { status: 'completed', input: { filePath: '/p/b.js', oldString: 'a\nb', newString: 'c' } }));
  assert.equal(bare.title, '/p/b.js');
  assert.deepEqual(bare.sections[0].lines, [{ type: 'del', text: '-a' }, { type: 'del', text: '-b' }, { type: 'add', text: '+c' }]);

  const write = toolCardView(tool('write', { status: 'completed', input: { filePath: '/p/new.txt', content: 'one\ntwo' } }));
  assert.equal(write.meta, '+2 −0');
  const patch = toolCardView(tool('apply_patch', { status: 'completed', input: { patchText: '@@\n-x\n+y' } }));
  assert.equal(patch.label, 'Patch');
  assert.deepEqual(diffStat(patch.sections[0].lines), { additions: 1, deletions: 1 });
  // An edit that has not produced anything yet has no diff section.
  assert.deepEqual(toolCardView(tool('edit', { status: 'pending', input: {} })).sections, []);
});

test('a very long diff is capped', () => {
  const diff = Array.from({ length: 1000 }, (_, i) => `+line ${i}`).join('\n');
  const view = toolCardView(tool('write', { status: 'completed', input: { filePath: '/p/big.txt' }, metadata: { diff } }));
  assert.equal(view.sections[0].lines.length, 400);
  assert.equal(view.sections[0].hiddenLines, 600);
  assert.equal(view.sections[0].additions, 1000, 'the count covers the whole diff');
});

test('read / grep / glob / list / web cards summarise their target', () => {
  const read = toolCardView(tool('read', { status: 'completed', input: { filePath: '/p/src/app.js', offset: 40, limit: 20 }, output: 'content' }));
  assert.deepEqual([read.title, read.meta], ['/p/src/app.js', 'from 40, 20 lines']);
  const grep = toolCardView(tool('grep', { status: 'completed', input: { pattern: 'TODO', path: '/p/src', include: '*.js' }, metadata: { matches: 3 }, output: 'a\nb\nc' }));
  assert.deepEqual([grep.title, grep.meta, grep.iconKey], ['TODO in src (*.js)', '3 matches', 'grep']);
  assert.equal(toolCardView(tool('grep', { status: 'completed', input: { pattern: 'x' }, metadata: { matches: 1 } })).meta, '1 match');
  const glob = toolCardView(tool('glob', { status: 'completed', input: { pattern: '**/*.ts' }, metadata: { count: 12 } }));
  assert.deepEqual([glob.title, glob.meta], ['**/*.ts', '12 results']);
  assert.equal(toolCardView(tool('list', { status: 'completed', input: { path: '/p/src' } })).label, 'List');
  const fetch = toolCardView(tool('webfetch', { status: 'completed', input: { url: 'https://example.com/docs', format: 'markdown' }, output: '# Docs' }));
  assert.deepEqual([fetch.label, fetch.title, fetch.copyText], ['Fetch', 'https://example.com/docs', 'https://example.com/docs']);
  assert.equal(toolCardView(tool('websearch', { status: 'running', input: { query: 'opencode sdk' } })).title, 'opencode sdk');
});

test('task card carries the child session; todowrite card lists the todos', () => {
  const task = toolCardView(tool('task', {
    status: 'running', input: { description: 'Find the callers', prompt: 'Search for…', subagent_type: 'explore' },
    metadata: { sessionId: 'ses_child' },
  }));
  assert.deepEqual([task.label, task.title, task.childSessionId, task.iconKey], ['Task', 'explore · Find the callers', 'ses_child', 'agent']);
  assert.equal(toolCardView(tool('task', { status: 'pending', input: {} })).childSessionId, '');

  const todos = toolCardView(tool('todowrite', {
    status: 'completed',
    input: { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }, { content: 'C', status: 'pending' }] },
  }));
  assert.equal(todos.title, '1/3 done');
  assert.deepEqual(todos.sections[0], { kind: 'todos', items: [
    { content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }, { content: 'C', status: 'pending' },
  ] });
});

test('an unknown or MCP tool falls back to its input and output, never throws on odd shapes', () => {
  const mcp = toolCardView(tool('github_create_issue', {
    status: 'completed', input: { title: 'Bug', body: 'It breaks' }, output: { ok: true, number: 12 }, title: 'Create issue',
  }));
  assert.equal(mcp.label, 'github_create_issue');
  assert.equal(mcp.title, 'Create issue');
  assert.deepEqual(mcp.sections.map((s) => s.kind), ['code', 'output']);
  assert.match(mcp.sections[0].text, /"title": "Bug"/);
  assert.match(mcp.sections[1].text, /"number": 12/);
  assert.equal(toolLabel('mcp__docs__search'), 'docs · search');
  assert.equal(toolLabel(''), 'Tool');
  assert.equal(toolKey(' Bash '), 'bash');

  for (const odd of [null, {}, { type: 'tool' }, tool('bash', null), tool('edit', { input: 'not an object', metadata: 5 }), tool('read', { status: 'completed', output: 42 })]) {
    const view = toolCardView(odd);
    assert.ok(Array.isArray(view.sections));
    assert.equal(typeof toolCardSignature(view), 'string');
  }
  assert.equal(toolCardView(tool('x', { status: 'completed', input: {}, attachments: [{ url: 'data:image/png;base64,AA', mime: 'image/png' }, { nope: 1 }] })).attachments.length, 1);
});

test('the part signature notices a late title, metadata or end time', () => {
  const base = tool('bash', { status: 'running', input: { command: 'ls' } });
  const sig = partSignature(base);
  assert.notEqual(sig, partSignature(tool('bash', { ...base.state, title: 'List files' })));
  assert.notEqual(sig, partSignature(tool('bash', { ...base.state, metadata: { output: 'a' } })));
  assert.notEqual(sig, partSignature(tool('bash', { ...base.state, time: { start: 1, end: 2 } })));
  assert.equal(sig, partSignature(tool('bash', { ...base.state })));
});

test('helpers: durations, truncation, diff parsing', () => {
  assert.equal(formatDuration(12), '12ms');
  assert.equal(formatDuration(1234), '1.2s');
  assert.equal(formatDuration(12_345), '12s');
  assert.equal(formatDuration(125_000), '2m 5s');
  assert.equal(formatDuration(-1), '');
  assert.equal(formatDuration('x'), '');
  assert.deepEqual(truncateOutput('a\nb', 5, 100), { text: 'a\nb', hiddenLines: 0, truncated: false });
  assert.deepEqual(truncateOutput('a\nb\nc\nd', 2, 100), { text: 'a\nb', hiddenLines: 2, truncated: true });
  assert.equal(truncateOutput('x'.repeat(50), 5, 10).text.length, 10);
  assert.equal(truncateOutput(undefined).text, '');
  assert.deepEqual(parseUnifiedDiff(''), []);
  assert.deepEqual(parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\n c\n'), [
    { type: 'hunk', text: '@@ -1 +1 @@' }, { type: 'del', text: '-a' }, { type: 'add', text: '+b' }, { type: 'ctx', text: ' c' },
  ]);
});

// ── O13 todo list ───────────────────────────────────────────────────────────

test('todo.updated fills the store; the widget shows while work is left', () => {
  const store = createPanelStore();
  store.setSession('ses_1', { id: 'ses_1' });
  const todos = [
    { content: 'Read the code', status: 'completed', priority: 'high' },
    { content: '  Write the fix ', status: 'in_progress', priority: 'high' },
    { content: 'Run tests', status: 'pending', priority: 'medium' },
    { content: 'Dropped idea', status: 'cancelled', priority: 'low' },
    { content: '', status: 'pending' },
    { content: 'odd status', status: 'whatever' },
  ];
  applyEvent(store, 'todo.updated', { sessionID: 'ses_1', todos });
  const view = todoView(store.getState().todos);
  assert.deepEqual([view.total, view.done, view.active], [4, 1, 'Write the fix']);
  assert.deepEqual(view.items.map((t) => t.status), ['completed', 'in_progress', 'pending', 'cancelled', 'pending']);
  assert.equal(todoWidgetVisible(view), true);

  applyEvent(store, 'todo.updated', { sessionID: 'ses_1', todos: todos.slice(0, 1) });
  assert.equal(todoWidgetVisible(todoView(store.getState().todos)), false, 'everything done: hidden');
  applyEvent(store, 'todo.updated', { sessionID: 'ses_1' });
  assert.deepEqual(store.getState().todos, []);
  assert.equal(todoWidgetVisible(todoView(null)), false);

  // The list belongs to its session.
  store.setTodos(todos);
  store.setSession('ses_2', { id: 'ses_2' });
  assert.deepEqual(store.getState().todos, []);
  store.setTodos(todos);
  store.clearMessages();
  assert.deepEqual(store.getState().todos, []);
});

test('rehydrate restores the todo list after a reload', async () => {
  const store = createPanelStore();
  store.setSession('ses_1', { id: 'ses_1' });
  const api = {
    sessionStatus: async () => ({ ok: false, unsupported: true }),
    permissionList: async () => ({ ok: false, unsupported: true }),
    questionList: async () => ({ status: 200, data: [] }),
    sessionTodo: async (p) => { assert.equal(p.sessionId, 'ses_1'); return { status: 200, data: [{ content: 'Step 1', status: 'in_progress' }] }; },
  };
  const applied = await rehydrateSessionState(store, api, { sessionId: 'ses_1' });
  assert.equal(applied.todos, true);
  assert.equal(store.getState().todos[0].content, 'Step 1');
  // A panel build without the method, or a refusal, leaves the list alone.
  delete api.sessionTodo;
  assert.equal((await rehydrateSessionState(store, api, { sessionId: 'ses_1' })).todos, false);
  assert.equal(store.getState().todos.length, 1);
});

// ── O15 cost and per-message meta (D8) ──────────────────────────────────────

test('cost is OpenCode\'s own number: the session row or the messages, whichever is ahead', () => {
  const store = createPanelStore();
  store.setSession('ses_1', { id: 'ses_1', cost: 0 });
  assert.equal(sessionCostOf(store.getState()), 0);
  assert.equal(formatCost(sessionCostOf(store.getState())), '', 'nothing to show for a free or empty session');
  store.upsertMessage({ id: 'u1', role: 'user', cost: 99 });
  store.upsertMessage({ id: 'a1', role: 'assistant', cost: 0.0123 });
  store.upsertMessage({ id: 'a2', role: 'assistant', cost: 0.5 });
  assert.equal(sessionCostOf(store.getState()).toFixed(4), '0.5123');
  // The session row catches up when the turn ends, and includes sub-agents.
  store.setSessionInfo({ id: 'ses_1', cost: 0.9 });
  assert.equal(sessionCostOf(store.getState()), 0.9);
  assert.equal(sessionCostOf(null), 0);

  assert.equal(formatCost(0.004321), '$0.0043');
  assert.equal(formatCost(0.5123), '$0.512');
  assert.equal(formatCost(12.3456), '$12.35');
  assert.equal(formatCost(-1), '');
  assert.equal(formatCost('x'), '');
});

test('per-message meta: model, agent, variant, tokens, cost, duration', () => {
  assert.equal(messageMetaText({
    role: 'assistant', modelID: 'claude-x', agent: 'build', variant: 'high', cost: 0.0421,
    tokens: { input: 1200, output: 300, reasoning: 100, cache: { read: 9000, write: 0 } },
    time: { created: 1000, completed: 13_500 },
  }), 'claude-x · build · high · 1.6k tok · $0.042 · 13s');
  assert.equal(messageMetaText({ role: 'assistant', modelID: 'big-pickle', agent: 'build', cost: 0, tokens: { input: 0, output: 0, reasoning: 0 }, time: { created: 5, completed: 5 } }), 'big-pickle · build · $0.00');
  assert.equal(messageMetaText({ role: 'assistant', tokens: { total: 2_500_000 } }), '2.50M tok');
  assert.equal(messageMetaText({ role: 'user', modelID: 'x' }), '');
  assert.equal(messageMetaText(null), '');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(15_400), '15k');
  assert.equal(formatTokens(0), '');
});

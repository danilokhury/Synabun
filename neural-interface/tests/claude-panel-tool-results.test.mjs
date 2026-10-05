import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { installMiniDom } from './fixtures/mini-dom.mjs';
import { setCpCtx } from '../public/shared/cp/cp-ctx.js';
import {
  describeToolCall, describeCallSections, describeToolResult, patchToDiffLines,
  backgroundTaskIdOf, inputRows, applyTaskTool, askAnswerRows,
} from '../public/shared/cp/cp-tool-results.js';
import {
  decorateToolCard, applyStructuredResult, appendResultText,
  buildHistoryAskCard, buildHistoryPlanCard, fillHistoryCard, settleReplayedCards,
} from '../public/shared/cp/cp-tool-cards.js';
import { buildBashCard, updateBashResult, handleBgToolUse, reconcileBgTasks } from '../public/shared/cp/cp-bash.js';
import { buildDiffCard, finalizeDiffCard } from '../public/shared/cp/cp-diff.js';

// Tool cards of the Claude sidepanel: what a call and its typed output
// (tool_use_result) put on a card, live and in a replayed session.

const chipTexts = (v) => v.chips.map(c => c.text);

// ── Calls ──

test('call details: what a tool call is about, from its input', () => {
  assert.equal(describeToolCall('Read', { file_path: '/repo/src/index.ts', offset: 120, limit: 60 }).detail, 'index.ts:120-179');
  assert.equal(describeToolCall('Read', { file_path: '/repo/a.pdf', pages: '1-3' }).detail, 'a.pdf (pages 1-3)');
  assert.deepEqual(chipTexts(describeToolCall('Bash', { command: 'x', dangerouslyDisableSandbox: true, timeout: 120000 })), ['sandbox off', 'timeout 2m 00s']);
  assert.deepEqual(chipTexts(describeToolCall('Edit', { replace_all: true })), ['replace all']);
  assert.equal(describeToolCall('Grep', { pattern: 'TODO', path: '/repo/src', glob: '*.ts', output_mode: 'content' }).detail, 'TODO in src');
  assert.deepEqual(chipTexts(describeToolCall('Grep', { pattern: 'x', glob: '*.ts', output_mode: 'content' })), ['*.ts', 'content']);
  assert.equal(describeToolCall('WebFetch', { url: 'https://example.com/docs/', prompt: 'summarise' }).detail, 'example.com/docs');
  assert.deepEqual(chipTexts(describeToolCall('WebSearch', { query: 'q', allowed_domains: ['a.com'] })), ['only a.com']);
  assert.deepEqual(chipTexts(describeToolCall('Agent', { model: 'opus', isolation: 'worktree', run_in_background: true })), ['opus', 'worktree', 'bg']);
  assert.equal(describeToolCall('TaskUpdate', { taskId: '3', status: 'in_progress' }).detail, '#3 → in progress');
  assert.equal(describeToolCall('ScheduleWakeup', { delaySeconds: 1200, reason: 'watching CI' }).detail, 'in 20m: watching CI');
  assert.equal(describeToolCall('ScheduleWakeup', { stop: true }).detail, 'stop the loop');
  assert.deepEqual(chipTexts(describeToolCall('CronCreate', { cron: '0 9 * * 1', prompt: 'weekly report', durable: true })), ['recurring', 'durable']);
  assert.equal(describeToolCall('Workflow', { name: 'review-changes' }).detail, 'review-changes');
  assert.deepEqual(chipTexts(describeToolCall('ExitWorktree', { action: 'remove', discard_changes: true })), ['discards changes']);
  assert.equal(describeToolCall('ReportFindings', { findings: [{}, {}] }).detail, '2 findings');
  assert.equal(describeToolCall('mcp__github__create_issue', { title: 'Bug', body: 'long' }).detail, 'Bug');
  assert.equal(describeToolCall('Unknown', {}).detail, '');
});

test('generic input is key/value rows, not a JSON dump', () => {
  const rows = inputRows({ a: 'text', b: 2, c: true, d: { nested: 1 }, e: '', f: null, g: 'x'.repeat(500) });
  assert.deepEqual(rows.slice(0, 4), [['a', 'text'], ['b', '2'], ['c', 'true'], ['d', '{"nested":1}']]);
  assert.equal(rows[4][1].length, 300);
  const many = inputRows(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i])));
  assert.deepEqual(many.at(-1), ['…', '8 more']);
  assert.deepEqual(inputRows(null), []);
});

test('findings, proposals and scheduled prompts are sections of the call card', () => {
  const [findings] = describeCallSections('ReportFindings', { findings: [{ file: 'src/a.ts', line: 12, summary: 'Off by one', failure_scenario: 'n = 0', verdict: 'CONFIRMED', outcome: 'fixed' }] });
  assert.deepEqual(findings.items[0], { title: 'a.ts:12 · confirmed · fixed', text: 'Off by one', note: 'n = 0' });
  assert.equal(describeCallSections('ProposeSkills', { proposals: [{ name: 'deploy', kind: 'improvement', target: 'ship', description: 'd', evidence: ['e1', 'e2'], skillMd: '…' }] })[0].items[0].title, 'deploy · improves ship');
  assert.equal(describeCallSections('ProposeGoal', { condition: 'tests pass' })[0].text, 'tests pass');
  assert.equal(describeCallSections('CronCreate', { cron: '* * * * *', prompt: 'check' })[0].label, 'Prompt');
  assert.deepEqual(describeCallSections('Read', {}), []);
});

// ── Results ──

test('Bash: interrupted, timed out, sandbox, background id, git chips, stderr apart', () => {
  const v = describeToolResult('Bash', { command: 'git commit' }, {
    stdout: 'ok', stderr: 'warning: x', interrupted: false, timedOutAfterMs: 120000, dangerouslyDisableSandbox: true,
    backgroundTaskId: 'b46v84ew2', returnCodeInterpretation: 'No matches found', persistedOutputPath: '/tmp/out.txt', persistedOutputSize: 2048,
    gitOperation: { commit: { sha: 'abc1234def', kind: 'committed' }, push: { branch: 'main' }, pr: { number: 12, action: 'created', url: 'https://github.com/o/r/pull/12' } },
  });
  assert.deepEqual(chipTexts(v), ['timed out after 2m 00s', 'sandbox off', 'background b46v84ew2', 'committed abc1234', 'pushed main', 'PR #12 created']);
  assert.equal(v.chips.at(-1).url, 'https://github.com/o/r/pull/12');
  assert.equal(v.bgTaskId, 'b46v84ew2');
  assert.equal(v.stdout, 'ok');
  assert.deepEqual(v.sections, [{ label: 'stderr', text: 'warning: x', tone: 'err' }]);
  assert.equal(v.note, 'No matches found · Full output saved to /tmp/out.txt (2 KB)');
  assert.deepEqual(chipTexts(describeToolResult('Bash', {}, { stdout: '', stderr: '', interrupted: true })), ['interrupted']);
});

test('Edit and Write: the applied patch with line numbers, create or overwrite', () => {
  const patch = [
    { oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: [' ctx', '-old', '+new', ' tail', '\\ No newline at end of file'] },
    { oldStart: 40, oldLines: 1, newStart: 40, newLines: 2, lines: [' a', '+b'] },
  ];
  assert.deepEqual(patchToDiffLines(patch), [
    { kind: 'ctx', text: 'ctx', oldNo: 10, newNo: 10 },
    { kind: 'del', text: 'old', oldNo: 11 },
    { kind: 'add', text: 'new', newNo: 11 },
    { kind: 'ctx', text: 'tail', oldNo: 12, newNo: 12 },
    { kind: 'gap', text: '…' },
    { kind: 'ctx', text: 'a', oldNo: 40, newNo: 40 },
    { kind: 'add', text: 'b', newNo: 41 },
  ]);
  const edit = describeToolResult('Edit', {}, { filePath: '/a', structuredPatch: patch, replaceAll: true, userModified: true, staged: true });
  assert.deepEqual(chipTexts(edit), ['replaced all', 'staged, not applied', 'edited by you']);
  assert.equal(edit.diff.length, 7);
  assert.deepEqual(chipTexts(describeToolResult('Write', {}, { type: 'update', structuredPatch: [] })), ['overwrite']);
  assert.deepEqual(chipTexts(describeToolResult('Write', {}, { type: 'create', structuredPatch: [] })), ['new file']);
});

test('Read, Glob and Grep say how much they returned', () => {
  assert.deepEqual(chipTexts(describeToolResult('Read', {}, { type: 'text', file: { filePath: '/a', numLines: 60, startLine: 120, totalLines: 900, truncatedByTokenCap: true } })), ['lines 120-179 of 900', 'truncated']);
  assert.deepEqual(chipTexts(describeToolResult('Read', {}, { type: 'text', file: { numLines: 12, startLine: 1, totalLines: 12 } })), ['12 lines']);
  assert.deepEqual(chipTexts(describeToolResult('Read', {}, { type: 'file_unchanged', file: { filePath: '/a' } })), ['unchanged since last read']);
  assert.deepEqual(chipTexts(describeToolResult('Read', {}, { type: 'image', file: { originalSize: 204800 } })), ['image 200 KB']);
  const glob = describeToolResult('Glob', {}, { numFiles: 2, filenames: ['a.ts', 'b.ts'], truncated: true, totalMatches: 40, durationMs: 3 });
  assert.deepEqual(chipTexts(glob), ['2 of 40 files', 'truncated']);
  assert.equal(glob.content, 'a.ts\nb.ts');
  assert.equal(describeToolResult('Glob', {}, { numFiles: 0, filenames: [], truncated: false }).content, 'No files matched.');
  const grep = describeToolResult('Grep', {}, { mode: 'content', numFiles: 1, filenames: [], content: 'a.ts:1:TODO', numLines: 1, appliedLimit: 250 });
  assert.deepEqual([chipTexts(grep), grep.content], [['1 line', 'first 250'], 'a.ts:1:TODO']);
  assert.deepEqual(chipTexts(describeToolResult('Grep', {}, { mode: 'count', numFiles: 3, filenames: [], numMatches: 9 })), ['9 matches in 3 files']);
});

test('WebFetch and WebSearch: status, size, sources as safe links', () => {
  const fetched = describeToolResult('WebFetch', {}, { bytes: 20480, code: 200, codeText: 'OK', result: 'Summary', durationMs: 1500, url: 'https://example.com/a' });
  assert.deepEqual(chipTexts(fetched), ['200 OK', '20 KB', '1.5s']);
  assert.equal(fetched.chips[0].tone, 'ok');
  assert.equal(fetched.content, 'Summary');
  assert.deepEqual(fetched.sections[0].links, [{ title: 'example.com/a', url: 'https://example.com/a' }]);
  const search = describeToolResult('WebSearch', {}, { query: 'q', durationSeconds: 2, results: [
    { tool_use_id: 's1', content: [{ title: 'Docs', url: 'https://d.example' }, { title: 'Bad', url: 'javascript:alert(1)' }] }, 'Summary text',
  ] });
  assert.deepEqual(chipTexts(search), ['1 result', '2.0s']);
  assert.deepEqual(search.sections[0].links, [{ title: 'Docs', url: 'https://d.example' }]);
  assert.equal(search.content, 'Summary text');
  assert.deepEqual(chipTexts(describeToolResult('WebFetch', {}, { detachedToolCall: true })), ['running in background']);
});

test('Agent, scheduling, worktree, task and MCP resource results', () => {
  const agent = describeToolResult('Agent', {}, { status: 'completed', agentId: 'a', content: [], resolvedModel: 'claude-opus-5-5', totalTokens: 45200, totalDurationMs: 125000, totalToolUseCount: 12, toolStats: { linesAdded: 30, linesRemoved: 4 }, worktreeBranch: 'feature-x', prompt: 'p' });
  assert.equal(agent.stats, 'opus-5-5 · 45.2k tokens · 2m 05s · 12 tool uses · +30 −4 lines · worktree feature-x');
  assert.equal(describeToolResult('Agent', {}, { status: 'async_launched', agentId: 'ag1', description: 'd', prompt: 'p', outputFile: '/o' }).bgTaskId, 'ag1');
  const wake = describeToolResult('ScheduleWakeup', {}, { scheduledFor: 1790000000, clampedDelaySeconds: 3600, wasClamped: true });
  assert.equal(wake.scheduledFor, 1790000000000);
  assert.deepEqual(chipTexts(wake), ['clamped to 1h 00m']);
  assert.deepEqual(chipTexts(describeToolResult('ScheduleWakeup', {}, { scheduledFor: 0, clampedDelaySeconds: 0, wasClamped: false, stopped: true, cancelledWakeups: 2 })), ['loop stopped, 2 wakeups cancelled']);
  assert.deepEqual(chipTexts(describeToolResult('CronCreate', {}, { id: 'cron_1', humanSchedule: 'Mondays at 9:00', recurring: true })), ['Mondays at 9:00', 'cron_1']);
  assert.equal(describeToolResult('CronList', {}, { jobs: [{ id: 'c1', cron: '* * * * *', humanSchedule: 'every minute', prompt: 'ping\nmore' }] }).content, 'c1  every minute  ping');
  const wf = describeToolResult('Workflow', {}, { status: 'async_launched', taskId: 't9', runId: 'wf_abc', warning: 'slow' });
  assert.deepEqual([chipTexts(wf), wf.bgTaskId, wf.note], [['task t9', 'run wf_abc'], 't9', 'slow']);
  assert.deepEqual(chipTexts(describeToolResult('Monitor', {}, { taskId: 'm1', timeoutMs: 1000, persistent: true })), ['task m1', 'persistent']);
  const exit = describeToolResult('ExitWorktree', {}, { action: 'remove', originalCwd: '/repo', worktreePath: '/wt', discardedFiles: 3, discardedCommits: 1, message: 'm' });
  assert.deepEqual([chipTexts(exit), exit.note], [['removed', 'discarded 3 files, 1 commit'], 'Back in /repo']);
  assert.deepEqual(chipTexts(describeToolResult('TaskUpdate', {}, { success: true, taskId: '2', updatedFields: ['status'], statusChange: { from: 'pending', to: 'in_progress' } })), ['pending → in progress']);
  assert.equal(describeToolResult('TaskList', {}, { tasks: [{ id: '1', subject: 'A', status: 'in_progress', owner: 'me', blockedBy: ['2'] }] }).content, '#1 [in progress] A (me) blocked by #2');
  assert.equal(describeToolResult('ListMcpResources', {}, [{ uri: 'file://a', name: 'A', server: 'fs' }]).content, '[fs] A  file://a');
  assert.equal(describeToolResult('ReadMcpResource', {}, { contents: [{ uri: 'u', text: 'hello' }, { uri: 'b', blobSavedTo: '/tmp/b' }] }).content, 'hello\n\nSaved to /tmp/b');
  // No typed output, or a failed call: nothing is claimed.
  assert.deepEqual(describeToolResult('Bash', {}, null).chips, []);
  assert.deepEqual(describeToolResult('Bash', {}, { interrupted: true }, { isError: true }).chips, []);
});

test('the background id comes from the typed field, or from the sentence the CLI prints', () => {
  assert.equal(backgroundTaskIdOf({ backgroundTaskId: 'b46v84ew2' }, ''), 'b46v84ew2');
  assert.equal(backgroundTaskIdOf(null, 'Command running in background with ID: b46v84ew2. Output is being written to …'), 'b46v84ew2');
  assert.equal(backgroundTaskIdOf(undefined, 'Command running in background with ID: bash_7'), 'bash_7');
  assert.equal(backgroundTaskIdOf(null, 'my .bashrc is fine'), '');
});

test('the task tools maintain the list the todo dock shows', () => {
  let todos = applyTaskTool([], 'TaskCreate', { subject: 'Write tests', activeForm: 'Writing tests' }, { task: { id: '1', subject: 'Write tests' } });
  todos = applyTaskTool(todos, 'TaskCreate', { subject: 'Ship' }, { task: { id: '2', subject: 'Ship' } });
  assert.deepEqual(todos, [
    { id: '1', content: 'Write tests', activeForm: 'Writing tests', status: 'pending' },
    { id: '2', content: 'Ship', activeForm: '', status: 'pending' },
  ]);
  assert.equal(applyTaskTool(todos, 'TaskCreate', {}, { task: { id: '2', subject: 'Ship' } }), null, 'a replayed create changes nothing');
  todos = applyTaskTool(todos, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, { success: true, taskId: '1', updatedFields: ['status'] });
  assert.equal(todos[0].status, 'in_progress');
  todos = applyTaskTool(todos, 'TaskUpdate', { taskId: '2', status: 'deleted' }, { success: true, taskId: '2', updatedFields: ['status'] });
  assert.deepEqual(todos.map(t => t.id), ['1']);
  assert.equal(applyTaskTool(todos, 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: false, taskId: '1', updatedFields: [], error: 'x' }), null);
  // An update for a task this page never saw created still shows up.
  assert.deepEqual(applyTaskTool([], 'TaskUpdate', { taskId: '7', status: 'completed' }, { success: true, taskId: '7', updatedFields: [] }), [{ id: '7', content: 'Task #7', activeForm: '', status: 'completed' }]);
  // TaskList is the whole truth; it keeps the activeForm the dock knew.
  const listed = applyTaskTool(todos, 'TaskList', {}, { tasks: [{ id: '1', subject: 'Write tests', status: 'completed', blockedBy: [] }, { id: '3', subject: 'New', status: 'pending', owner: 'agent', blockedBy: ['1'] }] });
  assert.deepEqual(listed, [
    { id: '1', content: 'Write tests', activeForm: 'Writing tests', status: 'completed' },
    { id: '3', content: 'New', activeForm: '', status: 'pending', owner: 'agent', blockedBy: ['1'] },
  ]);
  assert.equal(applyTaskTool(todos, 'Bash', {}, {}), null);
});

test('an answered question: what was asked and what was chosen', () => {
  const input = { questions: [{ header: 'Scope', question: 'Which scope?', options: [] }, { question: 'Dark mode?', options: [] }] };
  assert.deepEqual(askAnswerRows(input, { answers: { 'Which scope?': 'Whole app', 'Dark mode?': ['Yes', 'Auto'] } }), [
    { header: 'Scope', question: 'Which scope?', answer: 'Whole app' },
    { header: '', question: 'Dark mode?', answer: 'Yes, Auto' },
  ]);
  assert.equal(askAnswerRows({ questions: [{ question: 'Q?' }] }, null, 'User has answered: A')[0].answer, 'User has answered: A');
  assert.deepEqual(askAnswerRows({}, null), []);
});

// ── Cards (DOM glue on the mini DOM) ──

function setup() {
  const dom = installMiniDom();
  const tab = { id: 't', messagesEl: dom.container('cp-messages'), todos: [], bgTasks: new Map(), agents: new Map() };
  const calls = { todoRenders: 0 };
  setCpCtx({
    md: (t) => `<p>${t}</p>`, esc: String, linkifyFilePaths: () => {}, addCopyButtons: () => {}, scrollEnd: () => {},
    activeTab: () => tab, panel: () => null, toolIconSvg: () => '<svg/>',
    renderTodoWidget: () => { calls.todoRenders++; },
  });
  return { dom, tab, calls };
}

function genericCard(name, input, id = 'tu1') {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.toolId = id;
  card.dataset.toolName = name;
  const hdr = document.createElement('div'); hdr.className = 'tool-hdr';
  const detail = document.createElement('span'); detail.className = 'tool-detail';
  const chevron = document.createElement('span'); chevron.className = 'tool-chevron';
  hdr.append(detail, chevron);
  const body = document.createElement('div'); body.className = 'tool-body';
  const pre = document.createElement('pre'); pre.className = 'tool-section'; pre.textContent = JSON.stringify(input);
  const rLbl = document.createElement('div'); rLbl.className = 'tool-section-label tool-result-label';
  const rSec = document.createElement('div'); rSec.className = 'tool-section tool-result-content';
  body.append(pre, rLbl, rSec);
  card.append(hdr, body);
  return card;
}

test('a generic card gets a header detail, chips and a readable input', () => {
  const { dom } = setup();
  try {
    const card = decorateToolCard(genericCard('WebSearch', { query: 'node test runner', allowed_domains: ['nodejs.org'] }), { name: 'WebSearch', input: { query: 'node test runner', allowed_domains: ['nodejs.org'] } });
    assert.equal(card.querySelector('.tool-detail').textContent, 'node test runner');
    assert.deepEqual(card.querySelectorAll('.cp-chip').map(c => c.textContent), ['only nodejs.org']);
    assert.equal(card.querySelector('pre.tool-section'), null, 'the JSON dump is gone');
    assert.deepEqual(card.querySelectorAll('.cp-perm-kv-key').map(k => k.textContent), ['query', 'allowed_domains']);
    assert.deepEqual(card._toolInput, { query: 'node test runner', allowed_domains: ['nodejs.org'] });

    const findings = decorateToolCard(genericCard('ReportFindings', { findings: [] }), { name: 'ReportFindings', input: { findings: [{ file: 'a.ts', line: 3, summary: 'Bug', failure_scenario: 'x' }] } });
    assert.equal(findings.querySelector('.cp-result-item-title').textContent, 'a.ts:3');
    const kids = findings.querySelector('.tool-body').children.map(c => c.className);
    assert.ok(kids.indexOf('cp-result-section') < kids.indexOf('tool-section-label tool-result-label'), 'sections sit above the result');
  } finally { dom.restore(); }
});

test('a typed result adds chips, sections and readable content, once', () => {
  const { dom, tab } = setup();
  try {
    const input = { query: 'q' };
    const card = decorateToolCard(genericCard('WebSearch', input), { name: 'WebSearch', input });
    tab.messagesEl.appendChild(card);
    const ev = { tool_use_id: 'tu1', content: 'raw text', is_error: false, tool_use_result: { query: 'q', durationSeconds: 1, results: [{ tool_use_id: 's', content: [{ title: 'Docs', url: 'https://d.example' }] }, 'The answer'] } };
    const typed = applyStructuredResult(tab, card, ev);
    applyStructuredResult(tab, card, ev);
    assert.equal(typed.content, 'The answer');
    assert.deepEqual(card.querySelectorAll('.cp-chip').map(c => c.textContent), ['1 result', '1.0s']);
    const links = card.querySelectorAll('.cp-result-link');
    assert.deepEqual(links.map(a => [a.textContent, a.href, a.rel]), [['Docs', 'https://d.example', 'noopener noreferrer']]);

    const wake = decorateToolCard(genericCard('ScheduleWakeup', { delaySeconds: 600 }, 'tu2'), { name: 'ScheduleWakeup', input: { delaySeconds: 600 } });
    applyStructuredResult(tab, wake, { tool_use_id: 'tu2', content: '', tool_use_result: { scheduledFor: new Date(2026, 9, 3, 14, 30).getTime(), clampedDelaySeconds: 600, wasClamped: false } });
    assert.deepEqual(wake.querySelectorAll('.cp-chip').map(c => c.textContent), ['wakes at 14:30']);
  } finally { dom.restore(); }
});

test('task tools update the todo dock from the root conversation only', () => {
  const { dom, tab, calls } = setup();
  try {
    const card = decorateToolCard(genericCard('TaskCreate', { subject: 'A' }), { name: 'TaskCreate', input: { subject: 'A' } });
    applyStructuredResult(tab, card, { tool_use_id: 'tu1', content: 'Task #1 created', tool_use_result: { task: { id: '1', subject: 'A' } } });
    assert.deepEqual(tab.todos, [{ id: '1', content: 'A', activeForm: '', status: 'pending' }]);
    assert.equal(calls.todoRenders, 1);
    const scope = Object.create(tab);
    scope._agentScope = true;
    applyStructuredResult(scope, card, { tool_use_id: 'tu1', content: '', tool_use_result: { task: { id: '9', subject: 'sub' } } });
    assert.equal(tab.todos.length, 1, "a subagent's tasks stay out of the dock");
    applyStructuredResult(tab, card, { tool_use_id: 'tu1', content: 'boom', is_error: true, tool_use_result: { task: { id: '5', subject: 'x' } } });
    assert.equal(tab.todos.length, 1);
  } finally { dom.restore(); }
});

test('long result text is cut for the first view and expandable', () => {
  const { dom } = setup();
  try {
    const box = document.createElement('div');
    const pre = appendResultText(box, 'y'.repeat(5000));
    assert.equal(pre.textContent.length, 2000);
    const more = box.querySelector('.cp-result-more');
    assert.equal(more.textContent, 'Show all (5,000 characters)');
    more.click();
    assert.equal(pre.textContent.length, 5000);
    assert.equal(box.querySelector('.cp-result-more'), null);
    const short = document.createElement('div');
    appendResultText(short, 'short');
    assert.equal(short.querySelector('.cp-result-more'), null);
  } finally { dom.restore(); }
});

test('Bash card: stdout apart from stderr, the real background id, stop and completion', () => {
  const { dom, tab } = setup();
  try {
    const block = { id: 'b1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } };
    const card = decorateToolCard(buildBashCard(block, tab), block);
    tab.messagesEl.appendChild(card);
    const ev = { tool_use_id: 'b1', content: 'Command running in background with ID: b46v84ew2. Output is being written to /tmp/x', is_error: false, tool_use_result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b46v84ew2' } };
    const typed = applyStructuredResult(tab, card, ev);
    updateBashResult(card, ev, tab, typed.view);
    const task = tab.bgTasks.get('b1');
    assert.equal(task.bashId, 'b46v84ew2', 'the id the CLI gave it, not a bash_ pattern');
    assert.equal(task.status, 'running');

    // The live task list carries it, then no longer does: it finished.
    reconcileBgTasks(tab, [{ task_id: 'b46v84ew2', task_type: 'local_bash', description: 'npm run dev' }]);
    assert.equal(task.status, 'running');
    reconcileBgTasks(tab, []);
    assert.equal(task.status, 'done');

    // TaskStop by task id finds the card.
    task.status = 'running';
    handleBgToolUse({ id: 'stop1', name: 'TaskStop', input: { task_id: 'b46v84ew2' } }, tab);
    assert.equal(task.status, 'stopped');

    // A foreground command the CLI moved to the background gets an entry too.
    const fg = { id: 'b2', name: 'Bash', input: { command: 'sleep 600' } };
    const fgCard = decorateToolCard(buildBashCard(fg, tab), fg);
    tab.messagesEl.appendChild(fgCard);
    const fgEv = { tool_use_id: 'b2', content: 'moved', tool_use_result: { stdout: 'partial', stderr: 'warn', interrupted: false, backgroundTaskId: 'zz9', backgroundedByUser: true } };
    const fgTyped = applyStructuredResult(tab, fgCard, fgEv);
    updateBashResult(fgCard, fgEv, tab, fgTyped.view);
    assert.equal(tab.bgTasks.get('b2').bashId, 'zz9');
    assert.equal(fgCard.querySelector('.cp-bash-out').textContent, 'partial', 'stdout only: stderr has its own section');
    assert.equal(fgCard.querySelector('.cp-result-err .cp-result-text').textContent, 'warn');
    assert.ok(fgCard.querySelectorAll('.cp-chip').map(c => c.textContent).includes('moved to background'));

    // Without a typed result the merged text and the regex still work.
    const plain = { id: 'b3', name: 'Bash', input: { command: 'false' } };
    const plainCard = buildBashCard(plain, tab);
    updateBashResult(plainCard, { tool_use_id: 'b3', content: 'boom\nExit code: 2', is_error: true }, tab);
    assert.equal(plainCard.querySelector('.cp-exit-pill').textContent, '2');
    assert.match(plainCard.querySelector('.cp-bash-out').textContent, /boom/);
  } finally { dom.restore(); }
});

test('diff card: the applied patch replaces the guessed diff; Write waits for the result to say new or overwrite', () => {
  const { dom, tab } = setup();
  try {
    const block = { id: 'w1', name: 'Write', input: { file_path: '/repo/a.txt', content: 'one\ntwo' } };
    const card = decorateToolCard(buildDiffCard(block, tab), block);
    assert.equal(card.querySelector('.cp-diff-badge'), null, 'no "new file" claim before the result');
    const ev = { tool_use_id: 'w1', content: 'File updated', is_error: false, tool_use_result: { type: 'update', filePath: '/repo/a.txt', content: 'one\ntwo', originalFile: null, structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' one', '-zwei', '+two'] }] } };
    const typed = applyStructuredResult(tab, card, ev);
    finalizeDiffCard(card, ev, typed.view);
    assert.deepEqual(card.querySelectorAll('.cp-chip').map(c => c.textContent), ['overwrite']);
    assert.deepEqual(card.querySelectorAll('.cp-diff-line').map(l => l.className), ['cp-diff-line cp-diff-ctx', 'cp-diff-line cp-diff-del', 'cp-diff-line cp-diff-add']);
    assert.deepEqual(card.querySelectorAll('.cp-diff-lineno').map(n => n.textContent), ['1', '2', '2']);
    assert.ok(card.classList.contains('tool-ok'));
    assert.equal(card.classList.contains('open'), false);

    const del = buildDiffCard({ id: 'n1', name: 'NotebookEdit', input: { notebook_path: '/n.ipynb', cell_id: 'c3', edit_mode: 'delete', new_source: '' } }, tab);
    assert.equal(del.querySelector('.cp-diff-badge').textContent, 'delete');
    assert.equal(del.querySelector('.cp-diff-add'), null, 'a deleted cell is not drawn as additions');
  } finally { dom.restore(); }
});

test('replayed questions and plans are records, filled by their result', () => {
  const { dom, tab } = setup();
  try {
    const ask = buildHistoryAskCard({ id: 'q1', name: 'AskUserQuestion', input: { questions: [{ header: 'Scope', question: 'Which scope?', options: [] }] } });
    const plan = buildHistoryPlanCard({ id: 'p1', name: 'ExitPlanMode', input: { plan: '# Plan\n1. Do it' } });
    tab.messagesEl.append(ask, plan);
    assert.equal(ask.querySelector('.cp-ask-history-q').textContent, 'Scope: Which scope?');
    assert.equal(ask.querySelector('.cp-ask-history-a').textContent, 'No answer recorded');
    assert.equal(plan.querySelector('.cp-plan-history-body').innerHTML, '<p># Plan\n1. Do it</p>');

    assert.equal(fillHistoryCard(tab.messagesEl, { toolUseId: 'q1', text: 'User has answered…', isError: false, structured: { answers: { 'Which scope?': 'Whole app' } } }), true);
    assert.equal(ask.querySelector('.cp-ask-history-a').textContent, 'Whole app');
    assert.ok(ask.querySelector('.cp-ask-history-a').classList.contains('cp-answered'));
    assert.equal(fillHistoryCard(tab.messagesEl, { toolUseId: 'p1', text: 'User has approved your plan', isError: false }), true);
    assert.deepEqual(plan.querySelectorAll('.cp-chip').map(c => c.textContent), ['approved']);
    assert.equal(fillHistoryCard(tab.messagesEl, { toolUseId: 'other', text: 'x' }), false, 'any other result goes to the live renderer');
  } finally { dom.restore(); }
});

test('after a replay, cards without a result stop looking busy', () => {
  const { dom, tab } = setup();
  try {
    const bash = buildBashCard({ id: 'b1', name: 'Bash', input: { command: 'x' } }, tab);
    const diff = buildDiffCard({ id: 'e1', name: 'Edit', input: { file_path: '/a', old_string: 'a', new_string: 'b' } }, tab);
    const agent = document.createElement('div');
    agent.className = 'tool-card cp-agent-card';
    agent.dataset.toolId = 'a1';
    const pill = document.createElement('span'); pill.className = 'cp-agent-pill cp-agent-running'; pill.textContent = '◐';
    const now = document.createElement('div'); now.className = 'cp-agent-now';
    agent.append(pill, now);
    tab.agents.set('a1', { status: 'running' });
    tab.messagesEl.append(bash, diff, agent);
    settleReplayedCards(tab.messagesEl, tab);
    assert.equal(bash.dataset.resolved, '1');
    assert.equal(diff.classList.contains('open'), false);
    assert.equal(agent.dataset.resolved, '1');
    assert.equal(pill.classList.contains('cp-agent-running'), false);
    assert.equal(now.textContent, 'no result in this transcript');
    assert.equal(tab.agents.get('a1').status, 'unknown');
  } finally { dom.restore(); }
});

// ── Panel wiring (source contracts) ──

const panel = (await readFile(new URL('../public/shared/ui-claude-panel.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
function fnBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = src.slice(start + signature.length);
  const next = rest.search(/\n(?:async )?function /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('the typed output reaches the card: stashed from the user message, attached to the result event', () => {
  const ev = fnBody(panel, 'function handleTabEvent(tab, ev) {');
  assert.match(ev, /tab\._typedResults\.set\(results\[0\]\.tool_use_id, ev\.tool_use_result\)/);
  assert.match(ev, /ev = \{ \.\.\.ev, tool_use_result: tab\._typedResults\.get\(ev\.tool_use_id\) \}/);
  const result = fnBody(panel, 'function updateToolResult(tab, ev) {');
  assert.match(result, /typed = applyStructuredResult\(tab, card, ev\)/);
  assert.match(result, /updateBashResult\(card, ev, tab, typed\?\.view\)/);
  assert.match(result, /finalizeDiffCard\(card, ev, typed\?\.view\)/);
  assert.match(result, /appendResultText\(rSec, ev\.content\)/);
  assert.doesNotMatch(result, /slice\(0, 2000\)/, 'no silent cut of the result text');
  assert.match(fnBody(panel, 'function buildTool(block, tab) {'), /decorateToolCard\(card, block\)/);
  assert.match(fnBody(panel, 'function _buildToolCard(block, tab) {'), /if \(Array\.isArray\(todos\)\) \{/, 'an empty TodoWrite list clears the dock');
});

test('replay uses the live renderers, quietly, and can page back', () => {
  const row = fnBody(panel, 'function _renderHistoryRow(tab, $msgs, m) {');
  assert.match(row, /buildHistoryAskCard\(t\)/);
  assert.match(row, /buildHistoryPlanCard\(t\)/);
  assert.match(row, /updateToolResult\(tab, \{ type: 'tool_result', tool_use_id: m\.toolUseId, content: m\.text \|\| '', is_error: !!m\.isError, tool_use_result: m\.structured \}\)/);
  assert.match(row, /_stampUserMessageUuid\(tab, m\.uuid\)/);
  assert.match(row, /renderCompactBoundary\(\{ messagesEl: \$msgs \}, m\)/);
  const load = fnBody(panel, 'async function loadSessionHistory(sid, $msgs) {');
  assert.match(load, /ownerTab\._replaying = \(ownerTab\._replaying \|\| 0\) \+ 1/);
  assert.match(load, /settleReplayedCards\(\$msgs, ownerTab\)/);
  assert.match(load, /probeData\?\.visible \?\? probeData\?\.total \?\? 0/);
  assert.match(fnBody(panel, 'function recordHookEvent(tab, event, detail = \'\') {'), /if \(!tab \|\| tab\._replaying\) return;/);
  const pager = fnBody(panel, 'function _addHistoryPager(tab, $msgs, sid, project, data) {');
  assert.match(pager, /before: String\(start\)/);
  assert.match(pager, /\$msgs\._pruneCap = \$msgs\.childElementCount \+ MAX_MSG_CHILDREN/);
  assert.match(fnBody(panel, 'function pruneMessages($msgs) {'), /\$msgs\?\._pruneCap \|\| MAX_MSG_CHILDREN/);
});

// ── C105: the plan-mode entry card ──

test('C105: EnterPlanMode is a card that says what plan mode means, not an empty tool call', async () => {
  const { dom, tab } = setup();
  try {
    const raw = genericCard('EnterPlanMode', {});
    const name = document.createElement('span'); name.className = 'tool-name'; name.textContent = 'EnterPlanMode';
    raw.querySelector('.tool-hdr').insertBefore(name, raw.querySelector('.tool-detail'));
    const card = decorateToolCard(raw, { name: 'EnterPlanMode', input: {} });
    assert.ok(card.classList.contains('cp-plan-enter'));
    assert.ok(card.classList.contains('open'), 'its explanation is visible without a click');
    assert.equal(card.querySelector('.tool-name').textContent, 'Plan mode');
    assert.equal(card.querySelector('.tool-detail').textContent, 'read and plan; nothing changes until you approve');
    assert.match(card.querySelector('.cp-plan-enter-note').textContent, /No file is edited/);
    assert.equal(card.querySelector('pre.tool-section'), null, 'no JSON dump of an empty input');

    // The result is the CLI's instruction text for the model: the card shows a state instead.
    const entered = applyStructuredResult(tab, card, { tool_use_id: 'tu1', content: 'Entered plan mode. You should now focus on exploring…', tool_use_result: { message: 'Entered plan mode. You should now focus on exploring…' } });
    assert.equal(entered.content, '', 'the instruction text is not printed as a result');
    assert.deepEqual(card.querySelectorAll('.cp-chip').map(c => c.textContent), ['plan mode on']);

    const refused = describeToolResult('EnterPlanMode', {}, 'denied', { text: 'Plan mode is not available here\nmore', isError: true });
    assert.deepEqual(refused.chips.map(c => c.text), ['not entered']);
    assert.equal(refused.note, 'Plan mode is not available here');
    assert.equal(refused.content, '');
    assert.equal(describeToolCall('EnterPlanMode', {}).detail, 'read and plan; nothing changes until you approve');
  } finally { dom.restore(); }
  const panel = (await readFile(new URL('../public/shared/ui-claude-panel.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(panel, /if \(card\.classList\.contains\('cp-plan-enter'\)\) \{\n    card\.classList\.remove\('tool-streaming'\);/);
});

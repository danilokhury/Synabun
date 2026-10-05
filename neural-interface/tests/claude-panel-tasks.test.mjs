import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { installMiniDom } from './fixtures/mini-dom.mjs';
import { setCpCtx } from '../public/shared/cp/cp-ctx.js';
import { reduceTaskEvent, reconcileTasks, taskRows, taskProgressLine, isTaskRunning, hookEntry, describeOrigin } from '../public/shared/cp/cp-tasks-model.js';
import { renderTasksCard } from '../public/shared/cp/cp-tasks.js';
import { renderSdkEvent } from '../public/shared/cp/cp-event-rows.js';
import { describeEvent } from '../public/shared/cp/cp-events.js';

// Background work in the Claude sidepanel: the CLI's task events, the real hook
// lifecycle, prompt suggestions, and where a turn nobody typed came from.

const sys = (subtype, extra) => ({ type: 'system', subtype, ...extra });

test('the task map follows start, progress, update and notification', () => {
  const tasks = new Map();
  const t0 = 1_000_000;
  reduceTaskEvent(tasks, sys('task_started', { task_id: 'a1', tool_use_id: 'toolu_1', description: 'Explore the repo', subagent_type: 'Explore', task_type: 'local_agent', is_backgrounded: false }), t0);
  assert.deepEqual([tasks.get('a1').type, tasks.get('a1').agentType, tasks.get('a1').status, tasks.get('a1').background], ['agent', 'Explore', 'running', false]);
  reduceTaskEvent(tasks, sys('task_progress', { task_id: 'a1', description: 'Explore the repo', usage: { total_tokens: 12_300, tool_uses: 4, duration_ms: 9000 }, last_tool_name: 'Grep', summary: 'Reading the auth module' }), t0 + 9000);
  assert.equal(taskProgressLine(tasks.get('a1')), 'Reading the auth module · 12.3k tokens · 4 tools');
  reduceTaskEvent(tasks, sys('task_updated', { task_id: 'a1', patch: { is_backgrounded: true } }), t0 + 9500);
  assert.equal(tasks.get('a1').background, true);
  reduceTaskEvent(tasks, sys('task_notification', { task_id: 'a1', status: 'completed', summary: 'Found 3 call sites', output_file: '/tmp/o', usage: { total_tokens: 20_000, tool_uses: 7, duration_ms: 30_000 } }), t0 + 30_000);
  const done = tasks.get('a1');
  assert.deepEqual([done.status, done.summary, done.tokens, isTaskRunning(done)], ['completed', 'Found 3 call sites', 20_000, false]);
  assert.equal(done.toolUseId, 'toolu_1', 'the link to the Agent card survives');

  // A shell, a killed task, an event that is not a task event.
  reduceTaskEvent(tasks, sys('task_started', { task_id: 'b1', description: 'npm run dev', task_type: 'local_bash', is_backgrounded: true }), t0);
  reduceTaskEvent(tasks, sys('task_updated', { task_id: 'b1', patch: { status: 'killed', error: 'stopped by user' } }), t0 + 5);
  assert.deepEqual([tasks.get('b1').type, tasks.get('b1').status, tasks.get('b1').error], ['shell', 'stopped', 'stopped by user']);
  assert.equal(reduceTaskEvent(tasks, sys('status', { status: null })), null);
  assert.equal(reduceTaskEvent(tasks, { type: 'tool_progress', task_id: 'x' }), null);
});

test('the tasks card lists running work first and leaves housekeeping out', () => {
  const tasks = new Map();
  reduceTaskEvent(tasks, sys('task_started', { task_id: 'old', description: 'finished earlier', task_type: 'local_agent', is_backgrounded: true }), 1000);
  reduceTaskEvent(tasks, sys('task_notification', { task_id: 'old', status: 'failed', summary: 'boom' }), 2000);
  reduceTaskEvent(tasks, sys('task_started', { task_id: 'fg', tool_use_id: 'toolu_2', description: 'long build', task_type: 'local_bash', is_backgrounded: false }), 3000);
  reduceTaskEvent(tasks, sys('task_started', { task_id: 'amb', description: 'watcher', task_type: 'monitor', ambient: true }), 3500);
  const rows = taskRows(tasks, 13_000);
  assert.deepEqual(rows.map(r => r.id), ['fg', 'old']);
  assert.deepEqual([rows[0].status, rows[0].foreground, rows[0].toolUseId, rows[0].stats], ['running (foreground)', true, 'toolu_2', '10s']);
  assert.deepEqual([rows[1].status, rows[1].line, rows[1].running], ['failed', 'boom', false]);
});

test('finished tasks are capped; a background task that left the live list has ended', () => {
  const tasks = new Map();
  for (let i = 0; i < 30; i++) {
    reduceTaskEvent(tasks, sys('task_started', { task_id: `t${i}`, description: 'x', task_type: 'local_bash', is_backgrounded: true }), i);
    reduceTaskEvent(tasks, sys('task_notification', { task_id: `t${i}`, status: 'completed', summary: '' }), 100 + i);
  }
  assert.equal(tasks.size, 20);
  assert.equal(tasks.has('t0'), false);

  const live = new Map();
  reduceTaskEvent(live, sys('task_started', { task_id: 'bg', description: 'agent', task_type: 'local_agent', is_backgrounded: true }), 1);
  reduceTaskEvent(live, sys('task_started', { task_id: 'never-listed', description: 'agent', task_type: 'local_agent', is_backgrounded: false }), 1);
  assert.equal(reconcileTasks(live, [{ task_id: 'bg' }]), 0);
  assert.equal(reconcileTasks(live, []), 1, 'the CLI process went away: its task is over');
  assert.equal(live.get('bg').status, 'ended');
  assert.equal(live.get('never-listed').status, 'running', 'a task the list never carried is not judged by it');
});

test('a hook that ran: name, outcome, exit code, duration; its output is cut short', () => {
  assert.deepEqual(hookEntry({ hook_event: 'PreToolUse', hook_name: 'pre-task.mjs', outcome: 'success', exit_code: 0, output: '' }), { event: 'PreToolUse', detail: 'pre-task.mjs', output: '', outcome: 'success', real: true });
  const failed = hookEntry({ hook_event: 'Stop', hook_name: 'stop.mjs', outcome: 'error', exit_code: 2, output: 'x'.repeat(2000) }, 1000, 4500);
  assert.equal(failed.detail, 'stop.mjs · error · exit 2 · 3.5s');
  assert.equal(failed.output.length, 600);
  assert.equal(hookEntry({ hook_event: 'SessionStart', hook_name: 'h', outcome: 'cancelled' }).detail, 'h · cancelled');
});

test('a turn nobody typed says what started it', () => {
  assert.equal(describeOrigin({ kind: 'human' }), '');
  assert.equal(describeOrigin(undefined), '');
  assert.equal(describeOrigin({ kind: 'task-notification' }), 'A background task reported back and started this turn.');
  assert.equal(describeOrigin({ kind: 'task-notification', subkind: 'scheduled-trigger', fireReason: 'cron 0 9 * * 1' }), 'A scheduled wakeup started this turn (cron 0 9 * * 1).');
  assert.equal(describeOrigin({ kind: 'channel', server: 'slack' }), 'A message from the slack channel started this turn.');
  assert.equal(describeOrigin({ kind: 'peer', from: 'sess-2', name: 'reviewer' }), 'A message from reviewer started this turn.');
  assert.equal(describeOrigin({ kind: 'auto-continuation' }), 'Claude continued on its own.');
  assert.equal(describeOrigin({ kind: 'unclassified' }), '');
});

test('the events are routed: hooks, tasks, crons, suggestions, session state', () => {
  assert.equal(describeEvent(sys('hook_started', { hook_id: 'h1', hook_name: 'x', hook_event: 'Stop' })).phase, 'started');
  assert.equal(describeEvent(sys('hook_response', { hook_id: 'h1', hook_name: 'x', hook_event: 'Stop', outcome: 'success' })).kind, 'hook');
  assert.equal(describeEvent(sys('hook_progress', { hook_id: 'h1' })).kind, 'ignore');
  for (const subtype of ['task_started', 'task_progress', 'task_updated', 'task_notification']) assert.equal(describeEvent(sys(subtype, { task_id: 't' })).kind, 'task');
  // The panel keeps the state too now (gap C82): the bridge asks the CLI to emit it.
  assert.deepEqual(describeEvent(sys('session_state_changed', { state: 'idle' })), { kind: 'session_state', label: 'system/session_state_changed', state: 'idle' });
  assert.deepEqual(describeEvent(sys('session_crons', { crons: [{ id: 'c', schedule: 'in 20m', recurring: false, prompt: 'check CI' }] })).crons.length, 1);
  assert.deepEqual(describeEvent({ type: 'prompt_suggestion', suggestion: ' run the tests ' }), { kind: 'suggestion', label: 'prompt_suggestion', text: 'run the tests' });
  assert.equal(describeEvent({ type: 'prompt_suggestion', suggestion: '' }).kind, 'ignore');
});

function setup() {
  const dom = installMiniDom();
  const tab = { id: 't', messagesEl: dom.container('cp-messages'), tasks: new Map(), sessionCrons: [], backgroundWork: [], running: true };
  const calls = { hooks: [], suggestions: [], openTasks: 0 };
  setCpCtx({
    activeTab: () => tab, scrollEnd: () => {}, panel: () => null,
    appendStatus: () => null, appendWarn: () => null, appendError: () => null,
    recordRealHook: (t, entry) => calls.hooks.push(entry),
    showSuggestion: (t, text) => calls.suggestions.push(text),
    openTasks: () => { calls.openTasks++; },
  });
  return { dom, tab, calls };
}

test('rendering: a hook is recorded on its response, a task updates its agent card, a suggestion is shown', () => {
  const { dom, tab, calls } = setup();
  try {
    renderSdkEvent(tab, tab, sys('hook_started', { hook_id: 'h1', hook_name: 'pre-task.mjs', hook_event: 'PreToolUse' }));
    assert.equal(calls.hooks.length, 0, 'nothing to show until it ends');
    renderSdkEvent(tab, tab, sys('hook_response', { hook_id: 'h1', hook_name: 'pre-task.mjs', hook_event: 'PreToolUse', outcome: 'error', exit_code: 2, output: 'denied' }));
    assert.deepEqual([calls.hooks[0].event, calls.hooks[0].detail, calls.hooks[0].output], ['PreToolUse', 'pre-task.mjs · error · exit 2', 'denied']);

    const card = document.createElement('div');
    card.className = 'tool-card cp-agent-card';
    card.dataset.toolId = 'toolu_1';
    const now = document.createElement('div');
    now.className = 'cp-agent-now';
    card.appendChild(now);
    tab.messagesEl.appendChild(card);
    renderSdkEvent(tab, tab, sys('task_started', { task_id: 'a1', tool_use_id: 'toolu_1', description: 'Explore', task_type: 'local_agent' }));
    renderSdkEvent(tab, tab, sys('task_progress', { task_id: 'a1', description: 'Explore', usage: { total_tokens: 5000, tool_uses: 2, duration_ms: 1 }, last_tool_name: 'Read' }));
    assert.equal(now.textContent, 'using Read · 5k tokens · 2 tools');
    assert.equal(tab.tasks.get('a1').status, 'running');

    renderSdkEvent(tab, tab, sys('session_crons', { crons: [{ id: 'c1', schedule: 'in 20m', recurring: false, prompt: 'check CI' }] }));
    assert.equal(tab.sessionCrons.length, 1);
    renderSdkEvent(tab, tab, { type: 'prompt_suggestion', suggestion: 'run the tests' });
    assert.deepEqual(calls.suggestions, ['run the tests']);
    assert.equal(tab.messagesEl.querySelector('.cp-unhandled-event'), null, 'none of these is an unknown event any more');
  } finally { dom.restore(); }
});

test('the tasks card: stop per running task, send a foreground one to the background, scheduled wakeups', () => {
  const { dom, tab } = setup();
  try {
    reduceTaskEvent(tab.tasks, sys('task_started', { task_id: 'fg', tool_use_id: 'toolu_2', description: 'long build', task_type: 'local_bash', is_backgrounded: false }));
    reduceTaskEvent(tab.tasks, sys('task_started', { task_id: 'bg', description: 'research', subagent_type: 'Explore', task_type: 'local_agent', is_backgrounded: true }));
    reduceTaskEvent(tab.tasks, sys('task_started', { task_id: 'done', description: 'earlier', task_type: 'local_agent', is_backgrounded: true }));
    reduceTaskEvent(tab.tasks, sys('task_notification', { task_id: 'done', status: 'completed', summary: 'ok' }));
    tab.sessionCrons = [{ id: 'c1', schedule: 'every 5m', recurring: true, prompt: 'check the deploy' }];
    const stopped = [];
    const moved = [];
    const card = renderTasksCard(tab, { canControl: true, onStop: (id) => stopped.push(id), onBackground: (id) => moved.push(id) });
    const rows = card.querySelectorAll('.cp-task-row');
    assert.equal(rows.length, 4, 'three tasks and one scheduled wakeup');
    assert.equal(card.querySelectorAll('.cp-task-stop').length, 2, 'only running tasks can be stopped');
    assert.equal(card.querySelectorAll('.cp-task-bg').length, 1, 'only a foreground task can be sent to the background');
    card.querySelector('.cp-task-row[data-task-id="bg"]').querySelector('.cp-task-stop').click();
    card.querySelector('.cp-task-bg').click();
    assert.deepEqual([stopped, moved], [['bg'], ['toolu_2']]);
    assert.equal(rows[3].querySelector('.cp-task-title').textContent, 'every 5m (recurring)');

    // Without a bridge that takes the controls: a list, no buttons. A second card replaces the first.
    const plain = renderTasksCard(tab, { canControl: false });
    assert.equal(plain.querySelectorAll('button').length, 0);
    assert.equal(tab.messagesEl.querySelectorAll('.cp-tasks-card').length, 1);
    const empty = renderTasksCard({ messagesEl: dom.container('x'), tasks: new Map(), backgroundWork: [], sessionCrons: [] }, {});
    assert.match(empty.querySelector('.cp-info-row').textContent, /Nothing is running/);
  } finally { dom.restore(); }
});

const panel = (await readFile(new URL('../public/shared/ui-claude-panel.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
function fnBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = src.slice(start + signature.length);
  const next = rest.search(/\n(?:async )?function /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('panel wiring: real hooks replace the guesses, only a typed prompt is stamped, Tab takes the suggestion', () => {
  const real = fnBody(panel, 'function _recordRealHook(tab, entry) {');
  assert.match(real, /if \(!tab\._realHooks\) \{ tab\._realHooks = true; tab\.hookEvents = \[\]; \}/);
  assert.match(fnBody(panel, "function recordHookEvent(tab, event, detail = '') {"), /if \(tab\._realHooks\) return;/);
  const send = fnBody(panel, 'function send({ shift = false } = {}) {');
  assert.match(send, /if \(hasCapability\(tab, 'origin_human'\)\) msg\.typed = true;/);
  assert.doesNotMatch(fnBody(panel, 'function advanceQueue(tab) {'), /msg\.typed = true/, 'a queued prompt is not stamped');
  assert.match(fnBody(panel, 'function _applySessionOptions(tab, msg) {'), /msg\.features = \['elicitation', 'task_stop'\]/);
  assert.match(panel, /e\.key === 'Tab' && !e\.shiftKey && tab\?\.suggestion && !\$input\.value/);
  assert.match(fnBody(panel, 'function handleTabEvent(tab, ev) {'), /describeOrigin\(ev\.origin\)/);
  assert.match(fnBody(panel, 'function _setBackgroundWork(tab, tasks) {'), /reconcileTasks\(tab\.tasks, tasks\)/);
  assert.match(fnBody(panel, 'function _openTasks(tab) {'), /type: 'stop_task', taskId/);
});

// ── C51: replayed system rows ──

test('C51: a replayed session shows what started a turn, a CLI warning and a command\'s output', async () => {
  const { describeHistorySystemRow } = await import('../public/shared/cp/cp-tasks-model.js');
  assert.deepEqual(describeHistorySystemRow({ role: 'system', subtype: 'origin', origin: { kind: 'task-notification', producer: 'session-task' } }),
    { kind: 'status', text: 'A background task reported back and started this turn.' });
  assert.equal(describeHistorySystemRow({ role: 'system', subtype: 'origin', origin: { kind: 'human' } }), null);
  assert.deepEqual(describeHistorySystemRow({ role: 'system', subtype: 'informational', level: 'warning', text: ' Usage limit close ' }), { kind: 'warn', text: 'Usage limit close' });
  assert.deepEqual(describeHistorySystemRow({ role: 'system', subtype: 'informational', level: 'notice', text: 'x' }), { kind: 'status', text: 'x' });
  assert.deepEqual(describeHistorySystemRow({ role: 'system', subtype: 'local_command_output', text: 'out', isError: true }), { kind: 'output', text: 'out', isError: true });
  assert.equal(describeHistorySystemRow({ role: 'system', subtype: 'local_command_output', text: '  ' }), null);
  assert.equal(describeHistorySystemRow({ role: 'system', subtype: 'compact_boundary' }), null, 'rendered by its own function');
  assert.equal(describeHistorySystemRow({ role: 'user', text: 'x' }), null);
  assert.equal(describeHistorySystemRow(null), null);
});

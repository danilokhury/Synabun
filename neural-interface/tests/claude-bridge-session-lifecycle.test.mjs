import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ClaudeSession, configureClaudeBridge, createClaudeBridge, killSession } from '../lib/claude-agent-bridge.js';

// Sidepanel sessions used to drop mid-work. Claude Code runs subagents in the
// background by default, so a turn ends while its agents keep working — and the
// bridge treated that as idle: the reaper closed the CLI after 15 minutes, a
// reload destroyed it, and turns the CLI started on its own were invisible.
// These tests drive a ClaudeSession through a scripted stand-in for the SDK Query.

// Streams whatever the test emits, and ends when its input closes — the way the
// CLI exits when the SDK closes its stdin.
function scriptedQuery({ prompt, options }) {
  const queue = [];
  let wake = null;
  let ended = false;
  const wakeUp = () => { const w = wake; wake = null; w?.(); };
  const finish = () => { ended = true; wakeUp(); };
  const q = (async function* () {
    for (;;) {
      while (queue.length) yield queue.shift();
      if (ended) return;
      await new Promise(r => { wake = r; });
    }
  })();
  q.options = options;
  q.pushed = [];
  q.flags = null;
  q.emit = (m) => { queue.push(m); wakeUp(); };
  q.interrupt = async () => {};
  q.setPermissionMode = async () => {};
  q.setModel = async () => {};
  q.applyFlagSettings = async (settings) => { q.flags = settings; };
  q.supportedCommands = async () => [];
  q.mcpServerStatus = async () => [];
  (async () => { for await (const m of prompt) q.pushed.push(m); finish(); })();
  options.abortController?.signal.addEventListener('abort', finish, { once: true });
  return q;
}

function harness() {
  const queries = [];
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(),
    includePartialMessages: false,
    queryFactory: (args) => { const q = scriptedQuery(args); queries.push(q); return q; },
    acquireSessionLock: () => ({ ok: true }),
    heartbeatLock: () => {},
    releaseAllLocks: () => {},
    getSessionCost: () => 0,
    addCost: () => {},
    maybeInjectSkillPrompt: (prompt) => ({ prompt }),
    toCliModelName: (model) => model,
    writePlanFile: () => ({ ok: false }),
  });
  const sent = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (data) => sent.push(JSON.parse(data)) };
  return { session: new ClaudeSession(ws, {}), queries, sent };
}

async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 5));
  }
}

const IDLE_FOR_16_MIN = () => Date.now() - 16 * 60_000;
const events = (sent, type, subtype) => sent
  .filter(p => p.type === 'event' && p.event?.type === type && (!subtype || p.event.subtype === subtype))
  .map(p => p.event);
const agentCall = (id) => ({
  type: 'assistant', parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'Design', subagent_type: 'Plan' } }] },
});
const agentLaunched = (id) => ({
  type: 'user', parent_tool_use_id: null,
  tool_use_result: { status: 'async_launched', agentId: `agent-${id}`, description: 'Design' },
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Async agent launched successfully.' }] },
});

test('the idle reaper spares a session whose background agents are still running', async () => {
  const { session, queries } = harness();
  try {
    session.ensureQuery();
    queries[0].emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [
      { task_id: 't1', task_type: 'local_agent', description: 'Design pty-host fixes' },
    ] });
    await until(() => session._bgTasks.size === 1);
    session.lastActivity = IDLE_FOR_16_MIN();
    session._maybeReapIdle();
    assert.ok(session.q, 'a running background agent keeps the CLI alive');

    queries[0].emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    await until(() => session._bgTasks.size === 0);
    session.lastActivity = IDLE_FOR_16_MIN();
    session._maybeReapIdle();
    assert.equal(session.q, null, 'reaped once nothing will come back to it');
  } finally {
    session.destroy();
  }
});

test('an ambient task the user asked for (a Monitor) also keeps the session alive', async () => {
  const { session, queries } = harness();
  try {
    session.ensureQuery();
    queries[0].emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [
      { task_id: 'm1', task_type: 'monitor', description: 'watch the deploy', ambient: true },
    ] });
    await until(() => session._bgTasks.size === 1);
    session.lastActivity = IDLE_FOR_16_MIN();
    session._maybeReapIdle();
    assert.ok(session.q);
  } finally {
    session.destroy();
  }
});

test('a scheduled wakeup reported to the Stop hook keeps the session alive', async () => {
  const { session, queries } = harness();
  try {
    session.ensureQuery();
    const stopHook = queries[0].options.hooks.Stop[0].hooks[0];
    await stopHook({ hook_event_name: 'Stop', session_crons: [{ id: 'c1', schedule: '*/20 * * * *', recurring: true, prompt: 'check the deploy' }] });
    session.lastActivity = IDLE_FOR_16_MIN();
    session._maybeReapIdle();
    assert.ok(session.q, 'a pending wakeup keeps the CLI alive');

    await stopHook({ hook_event_name: 'Stop', session_crons: [] });
    session._maybeReapIdle();
    assert.equal(session.q, null);

    // A replaced Query's late hook call must not leak into its successor.
    session.ensureQuery();
    await stopHook({ hook_event_name: 'Stop', session_crons: [{ id: 'c2', schedule: '0 9 * * *', recurring: true, prompt: 'x' }] });
    assert.equal(session._sessionCrons.length, 0);
  } finally {
    session.destroy();
  }
});

test('a socket close orphans a session with background work instead of killing it', async () => {
  const { session, queries } = harness();
  try {
    session.windowId = 'w1';
    session.sessionId = 's1';
    session.ensureQuery();
    queries[0].emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [
      { task_id: 't1', task_type: 'local_bash', description: 'npm test' },
    ] });
    await until(() => session._bgTasks.size === 1);
    assert.equal(session.detach(), true);
    assert.ok(session.q, 'the CLI keeps running while no tab is attached');
    assert.equal(queries[0].options.abortController.signal.aborted, false);
  } finally {
    session.destroy();
  }
});

test('a turn the CLI starts on its own is opened, announced and closed by its result', async () => {
  const { session, queries, sent } = harness();
  try {
    session.ensureQuery();
    const q = queries[0];
    q.emit({ type: 'assistant', parent_tool_use_id: 'agent-call', message: { content: [{ type: 'text', text: 'subagent output' }] } });
    await until(() => events(sent, 'assistant').length === 1);
    assert.equal(session.inTurn, false, 'subagent frames are not a main-thread turn');

    q.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Both agents are back.' }] } });
    await until(() => session.inTurn);
    assert.equal(sent.filter(p => p.type === 'turn_started').length, 1);

    q.emit({ type: 'result', subtype: 'success', queued_turn_count: 0, session_id: 's1' });
    await until(() => sent.some(p => p.type === 'done'));
    assert.equal(session.inTurn, false);
  } finally {
    session.destroy();
  }
});

test('output still draining from an interrupted turn does not reopen it', async () => {
  const { session, queries, sent } = harness();
  try {
    session._pushUserText('long task');
    await session.handleMessage({ type: 'abort' });
    queries[0].emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'partial…' }] } });
    await until(() => events(sent, 'assistant').length === 1);
    assert.equal(session.inTurn, false);
    assert.ok(!sent.some(p => p.type === 'turn_started'));
  } finally {
    session.destroy();
  }
});

test('a result that owes no more turns closes prompts the CLI merged into one', async () => {
  const { session, queries, sent } = harness();
  try {
    session._pushUserText('first');
    session._pushUserText('second');
    assert.equal(session.pendingTurns, 2);
    queries[0].emit({ type: 'result', subtype: 'success', queued_turn_count: 0 });
    await until(() => sent.some(p => p.type === 'done'));
    assert.equal(session.inTurn, false);
    assert.equal(session.pendingTurns, 0);
  } finally {
    session.destroy();
  }
});

test('the stall watchdog closes a turn the CLI is not in instead of restarting the CLI', async () => {
  const { session, queries, sent } = harness();
  try {
    session._pushUserText('first');
    session._pushUserText('second');
    await new Promise(r => setTimeout(r, 5));
    // An older CLI reports no queued_turn_count, so the merged second push still counts.
    queries[0].emit({ type: 'result', subtype: 'success' });
    await until(() => sent.some(p => p.type === 'done'));
    assert.equal(session.inTurn, true);

    session.bootComplete = true;
    session.lastEventTime = Date.now() - 10 * 60_000;
    session._checkStall();
    assert.equal(session.inTurn, false);
    assert.equal(sent.filter(p => p.type === 'done').length, 2);
    assert.equal(queries.length, 1, 'no restart, so no background work was killed');
  } finally {
    session.destroy();
  }
});

test('a background agent stays open until its notification, and closes when the CLI goes away', async () => {
  const { session, queries, sent } = harness();
  try {
    session.ensureQuery();
    const q = queries[0];
    q.emit(agentCall('a1'));
    q.emit(agentLaunched('a1'));
    q.emit(agentCall('a2'));
    q.emit(agentLaunched('a2'));
    await until(() => events(sent, 'subagent', 'background').length === 2);
    assert.equal(events(sent, 'subagent', 'stop').length, 0, 'the launch placeholder does not end the card');

    q.emit({ type: 'system', subtype: 'task_notification', task_id: 'k1', tool_use_id: 'a1', status: 'completed', summary: 'Plan ready', output_file: '' });
    await until(() => events(sent, 'subagent', 'stop').length === 1);
    const settled = events(sent, 'subagent', 'stop')[0];
    assert.equal(settled.tool_use_id, 'a1');
    assert.equal(settled.is_error, false);
    assert.equal(settled.summary, 'Plan ready');

    q.emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'k2', task_type: 'local_agent', description: 'Design' }] });
    await until(() => session._bgTasks.size === 1);
    await session._endQuery({ graceful: false });
    const stopped = events(sent, 'subagent', 'stop').find(e => e.tool_use_id === 'a2');
    assert.ok(stopped?.is_error);
    assert.equal(stopped.status, 'stopped');
    assert.deepEqual(events(sent, 'system', 'background_tasks_changed').at(-1).tasks, []);
    assert.equal(session._hasPendingWork(), false);
  } finally {
    session.destroy();
  }
});

test('a query without a sessionId on a session that has one starts a new conversation', async () => {
  const { session, queries } = harness();
  try {
    await session.handleMessage({ type: 'query', prompt: 'hello', windowId: 'w1' });
    queries[0].emit({ type: 'system', subtype: 'init', session_id: 'old-session' });
    await until(() => session.sessionId === 'old-session');
    queries[0].emit({ type: 'result', subtype: 'success', queued_turn_count: 0, session_id: 'old-session' });
    await until(() => !session.inTurn);

    await session.handleMessage({ type: 'query', prompt: 'new chat', windowId: 'w1' });
    await until(() => queries.length === 2);
    assert.equal(queries[1].options.resume, undefined, 'the new chat does not resume the old session');
    await until(() => queries[1].pushed.length === 1);
    assert.equal(queries[0].pushed.length, 1, 'the old conversation never saw the new prompt');
  } finally {
    session.destroy();
  }
});

test('an effort change is applied to the live CLI instead of restarting it', async () => {
  const { session, queries } = harness();
  try {
    await session.handleMessage({ type: 'query', prompt: 'hi', effort: 'high', windowId: 'w1' });
    queries[0].emit({ type: 'system', subtype: 'init', session_id: 's1' });
    await until(() => session.sessionId === 's1');
    await session.handleMessage({ type: 'query', prompt: 'think harder', effort: 'max', sessionId: 's1', windowId: 'w1' });
    await until(() => queries[0].flags);
    assert.deepEqual(queries[0].flags, { effortLevel: 'max' });
    assert.equal(queries.length, 1);
    await until(() => queries[0].pushed.length === 2);
  } finally {
    session.destroy();
  }
});

test('reattaching re-sends pending permission cards and reports background work', async () => {
  const { session, queries } = harness();
  try {
    session.windowId = 'w1';
    session._pushUserText('go');
    queries[0].emit({ type: 'system', subtype: 'init', session_id: 's1' });
    queries[0].emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [
      { task_id: 't1', task_type: 'local_agent', description: 'Explore' },
      { task_id: 'm1', task_type: 'monitor', description: 'watch CI', ambient: true },
    ] });
    await until(() => session.sessionId === 's1' && session._bgTasks.size === 2);
    const decision = session._onCanUseTool('Bash', { command: 'ls' }, {});
    assert.equal(session.detach(), true);

    const sent = [];
    session.reattach({ readyState: 1, bufferedAmount: 0, send: (data) => sent.push(JSON.parse(data)) });
    await until(() => sent.length >= 2);
    assert.equal(sent[0].type, 'reattach_result');
    assert.equal(sent[0].running, true);
    assert.deepEqual(sent[0].backgroundTasks.map(t => [t.task_id, t.ambient]), [['t1', false], ['m1', true]]);
    assert.equal(sent[1].type, 'control_request');
    assert.equal(sent[1].request.tool_name, 'Bash');

    session._resolvePermission(sent[1].request_id, { behavior: 'allow' });
    assert.equal((await decision).behavior, 'allow');
  } finally {
    session.destroy();
  }
});

function fakeSocket() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.bufferedAmount = 0;
  ws.sent = [];
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  ws.ping = () => {};
  ws.terminate = () => {};
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  return ws;
}

async function startTurn(ws, queries, windowId, sessionId) {
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'work', windowId })));
  await until(() => queries.length === 1);
  queries[0].emit({ type: 'system', subtype: 'init', session_id: sessionId });
  await until(() => ws.sent.some(p => p.event?.subtype === 'init'));
  return queries[0];
}

test('closing a tab (dispose) ends its session instead of orphaning it', async () => {
  const { queries } = harness();
  const ws = fakeSocket();
  try {
    createClaudeBridge(ws);
    const q = await startTurn(ws, queries, 'w9', 's9');
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'dispose' })));
    ws.close();
    assert.equal(q.options.abortController.signal.aborted, true, 'the CLI was ended');
    assert.equal(killSession('w9', 's9'), false, 'nothing was left orphaned');
  } finally {
    if (ws.readyState !== 3) ws.close();
  }
});

test('the tray kill reaches a session the bridge orphaned', async () => {
  const { queries } = harness();
  const ws = fakeSocket();
  try {
    createClaudeBridge(ws);
    const q = await startTurn(ws, queries, 'w8', 's8');
    ws.close(); // mid-turn, no dispose → detached for reattach
    assert.equal(q.options.abortController.signal.aborted, false);
    assert.equal(killSession('w8', 's8'), true);
    assert.equal(q.options.abortController.signal.aborted, true);
  } finally {
    if (ws.readyState !== 3) ws.close();
  }
});

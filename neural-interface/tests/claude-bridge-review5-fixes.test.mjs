// Review 5 of the Claude panel parity build, bridge side.
// W05: a control sent after New chat or a session switch ends the old
// conversation's process and waits for it to close. Socket messages are not
// awaited, so the next message (a second Compact, a prompt) used to start a
// replacement during that wait; the first teardown then aborted the
// replacement, and its control went on, on it.
// Now: on a panel session, while one message is closing a process, the others
// that can start or end one (and a Stop, a mode switch) wait in line, in the
// order they arrived, and a teardown only touches the process it found. With
// nothing closing, a message is handled in the tick it arrives, as before.
// The tests hold a teardown open (a process that does not exit when its input
// closes) and send the next message during the wait.
// The W05 tests fail without the fix; the "as before" and non-panel pins pass
// before and after, on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ClaudeSession, configureClaudeBridge, createClaudeBridge, shutdownAllBridges } from '../lib/claude-agent-bridge.js';

// A scripted Query. With `hold` set, it does not end when its input closes: it
// ends on `release()`, or when it is aborted (what a process that is slow to
// exit looks like to _endQuery).
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
  q.hold = false;
  q.inputClosed = false;
  q.release = finish;
  q.emit = (m) => { queue.push(m); wakeUp(); };
  q.interrupts = 0;
  q.modes = [];
  q.interrupt = async () => { q.interrupts++; };
  q.setPermissionMode = async (mode) => { q.modes.push(mode); };
  q.setModel = async () => {};
  q.applyFlagSettings = async () => {};
  q.supportedCommands = async () => [];
  q.mcpServerStatus = async () => [];
  q.initializationResult = async () => ({ commands: [], agents: [], models: [] });
  q.rewindFiles = async () => ({ canRewind: true, filesChanged: [] });
  (async () => { for await (const m of prompt) q.pushed.push(m); q.inputClosed = true; if (!q.hold) finish(); })();
  options.abortController?.signal.addEventListener('abort', finish, { once: true });
  return q;
}

const WORK = '/home/me/.claude-accounts/work';

function configure(extra = {}) {
  const queries = [];
  const locks = [];
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(), includePartialMessages: false,
    queryFactory: (args) => { const q = scriptedQuery(args); queries.push(q); return q; },
    startupFactory: async ({ options }) => ({ options, close() {}, query(prompt) { const q = scriptedQuery({ prompt, options }); queries.push(q); return q; } }),
    acquireSessionLock: (sid, wid) => { locks.push([sid, wid]); return { ok: true }; }, heartbeatLock: () => {}, releaseAllLocks: () => {},
    getSessionCost: () => 0, addCost: () => {}, maybeInjectSkillPrompt: (prompt) => ({ prompt }),
    toCliModelName: (model) => model, writePlanFile: () => ({ ok: false }),
    claudeAccountEnv: (id) => (id === 'work' ? { CLAUDE_CONFIG_DIR: WORK } : {}),
    ...extra,
  });
  queries.locks = locks;
  return queries;
}

function panelConnection(extra = {}) {
  const queries = configure(extra);
  const ws = new EventEmitter();
  Object.assign(ws, { readyState: 1, bufferedAmount: 0, sent: [], ping() {}, terminate() {} });
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  createClaudeBridge(ws);
  const client = (msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)));
  return { ws, queries, client, close: () => { ws.readyState = 3; ws.emit('close'); shutdownAllBridges(); } };
}

// A session object of its own (the tests that reach into it).
function ownSession(opts, extra = {}) {
  const queries = configure(extra);
  const sent = [];
  const session = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send: (d) => sent.push(JSON.parse(d)) }, opts);
  return { session, queries, sent, close: () => { session.destroy(); shutdownAllBridges(); } };
}

async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 5));
  }
}
const settle = (ms = 30) => new Promise(r => setTimeout(r, ms));
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '44444444-4444-4444-8444-444444444444';
const THIRD = '55555555-5555-4555-8555-555555555555';
const PROMPT = '11111111-1111-4111-8111-111111111111';
const AT = '22222222-2222-4222-8222-222222222222';

// What the panel's _startConfig() builds: the fields of a query, without a prompt.
const DEFAULT_CONFIG = Object.freeze({ cwd: process.cwd(), windowId: 'w-w5', accountId: 'default', toolPolicy: 'full', permissionMode: 'default', features: ['elicitation'] });
const WORK_CONFIG = Object.freeze({ ...DEFAULT_CONFIG, accountId: 'work', toolPolicy: 'read-only', permissionMode: 'plan', session: { maxTurns: 7 } });

const texts = (q) => q.pushed.map(m => m.message.content[0].text);
const aborted = (q) => q.options.abortController.signal.aborted;
const errors = (sent) => sent.filter(m => m.type === 'error');

// One finished turn under the default account, in conversation UUID; then its
// process is told not to exit when its input closes.
async function heldConversation(send, queries, sent) {
  send({ type: 'query', prompt: 'hello', ...DEFAULT_CONFIG });
  await until(() => queries.length === 1 && queries[0].pushed.length === 1);
  queries[0].emit({ type: 'system', subtype: 'init', session_id: UUID });
  queries[0].emit({ type: 'result', subtype: 'success', session_id: UUID, total_cost_usd: 0, usage: {} });
  await until(() => sent.some(m => m.type === 'done'));
  queries[0].hold = true;
}

// ── W05: the finding itself, in both orders ──

test('W05: a second Compact sent while the first is closing the old conversation waits its turn; the process they share is never aborted', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    await heldConversation(client, queries, ws.sent);
    // New chat (the tab has no session id now), /account work, Compact.
    client({ type: 'compact', config: WORK_CONFIG });
    await settle();
    assert.equal(queries[0].inputClosed, true, 'the old conversation\'s process is being closed');
    assert.equal(aborted(queries[0]), false, 'and is given its time to exit');
    // The user clicks Compact again while that process is still closing.
    client({ type: 'compact', config: WORK_CONFIG });
    await settle();
    assert.equal(queries.length, 1, 'nothing starts while the old process is closing: the second Compact waits');
    queries[0].release();
    await until(() => queries.length === 2 && queries[1].pushed.length === 2);
    await settle();
    assert.equal(queries.length, 2, 'one new process, for both');
    assert.deepEqual(texts(queries[1]), ['/compact', '/compact']);
    assert.equal(aborted(queries[1]), false, 'the first Compact\'s teardown did not abort the process that replaced the old one');
    assert.equal(aborted(queries[0]), true, 'it ended the process it found');
    assert.equal(queries[1].options.env.CLAUDE_CONFIG_DIR, WORK);
    assert.equal(queries[1].options.resume, undefined, 'the new chat, not the conversation the tab left');
    assert.deepEqual(texts(queries[0]), ['hello'], 'nothing was sent into the conversation the tab left');
    assert.deepEqual(errors(ws.sent), []);
    assert.equal(ws.sent.filter(m => m.type === 'event' && m.event?.subtype === 'compact_started').length, 2, 'neither Compact was dropped');
  } finally { close(); }
});

test('W05: a prompt sent while a Compact is closing the old conversation waits its turn and runs after it, on the same new process', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    await heldConversation(client, queries, ws.sent);
    client({ type: 'compact', config: WORK_CONFIG });
    await settle();
    client({ type: 'query', prompt: 'next', ...WORK_CONFIG });
    await settle();
    assert.equal(queries.length, 1, 'the prompt starts nothing while the old process is closing');
    queries[0].release();
    await until(() => queries.length === 2 && queries[1].pushed.length === 2);
    await settle();
    assert.equal(queries.length, 2);
    assert.deepEqual(texts(queries[1]), ['/compact', 'next'], 'in the order they were sent');
    assert.equal(aborted(queries[1]), false);
    assert.equal(aborted(queries[0]), true);
    assert.equal(queries[1].options.env.CLAUDE_CONFIG_DIR, WORK);
    assert.deepEqual(errors(ws.sent), []);
  } finally { close(); }
});

test('W05: a Compact sent while a prompt is closing the old conversation waits its turn and runs after it, on the same new process', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    await heldConversation(client, queries, ws.sent);
    // New chat, /account work, a prompt: the prompt restarts the session.
    client({ type: 'query', prompt: 'fresh start', ...WORK_CONFIG });
    await settle();
    assert.equal(queries[0].inputClosed, true);
    client({ type: 'compact', config: WORK_CONFIG });
    await settle();
    assert.equal(queries.length, 1, 'the Compact starts nothing while the old process is closing');
    queries[0].release();
    await until(() => queries.length === 2 && queries[1].pushed.length === 2);
    await settle();
    assert.equal(queries.length, 2);
    assert.deepEqual(texts(queries[1]), ['fresh start', '/compact'], 'in the order they were sent');
    assert.equal(aborted(queries[1]), false, 'the prompt\'s teardown did not abort the process that replaced the old one');
    assert.equal(aborted(queries[0]), true);
    assert.equal(queries[1].options.env.CLAUDE_CONFIG_DIR, WORK);
    assert.deepEqual(errors(ws.sent), []);
  } finally { close(); }
});

test('W05: each message acts on the conversation it names: a Compact for one session, then a prompt for another, sent during the wait', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    await heldConversation(client, queries, ws.sent);
    client({ type: 'compact', config: { ...WORK_CONFIG, sessionId: OTHER } });
    await settle();
    client({ type: 'query', prompt: 'go', ...WORK_CONFIG, sessionId: THIRD });
    await settle();
    assert.equal(queries.length, 1);
    queries[0].release();
    await until(() => queries.length === 3 && queries[2].pushed.length === 1);
    await settle();
    assert.equal(queries[1].options.resume, OTHER);
    assert.deepEqual(texts(queries[1]), ['/compact'], 'the Compact ran on the session it named, and nothing else did');
    assert.equal(queries[2].options.resume, THIRD);
    assert.deepEqual(texts(queries[2]), ['go'], 'the prompt ran on the session it named');
    assert.equal(aborted(queries[2]), false);
    assert.equal(aborted(queries[1]), true, 'ended by the prompt that left it, in its own turn');
    assert.deepEqual(queries.locks.map(l => l[0]), [OTHER, THIRD]);
    assert.deepEqual(errors(ws.sent), []);
  } finally { close(); }
});

test('W05: a Stop sent while a prompt waits its turn stops that prompt, instead of answering "stopped" before it starts', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    await heldConversation(client, queries, ws.sent);
    client({ type: 'compact', config: WORK_CONFIG });
    await settle();
    client({ type: 'query', prompt: 'next', ...WORK_CONFIG });
    client({ type: 'abort' });
    await settle();
    assert.equal(ws.sent.some(m => m.type === 'aborted'), false, 'the stop waits in line: nothing is running yet that it could stop');
    queries[0].release();
    await until(() => ws.sent.some(m => m.type === 'aborted'));
    assert.equal(queries.length, 2);
    assert.deepEqual(texts(queries[1]), ['/compact', 'next']);
    assert.equal(queries[1].interrupts, 1, 'the process the prompt runs on was interrupted');
    assert.equal(queries[0].interrupts, 0);
    assert.equal(aborted(queries[1]), false, 'interrupted, not ended');
  } finally { close(); }
});

test('W05: a permission-mode switch sent while a prompt waits its turn is applied after it, not undone by it', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    await heldConversation(client, queries, ws.sent);
    client({ type: 'compact', config: WORK_CONFIG });
    await settle();
    client({ type: 'query', prompt: 'next', ...WORK_CONFIG });
    client({ type: 'set_permission_mode', mode: 'acceptEdits' });
    await settle();
    assert.equal(ws.sent.some(m => m.type === 'event' && m.event?.type === 'mode_changed'), false, 'the switch waits in line');
    queries[0].release();
    await until(() => ws.sent.some(m => m.type === 'event' && m.event?.type === 'mode_changed'));
    assert.equal(queries[1].options.permissionMode, 'plan', 'the process started with the mode the Compact and the prompt named');
    assert.equal(queries[1].modes.at(-1), 'acceptEdits', 'and the switch, sent last, is the mode it ends in');
    assert.deepEqual(texts(queries[1]), ['/compact', 'next']);
  } finally { close(); }
});

// ── W05, the other waits on a closing process ──

test('W05: a prompt sent while a conversation rewind restarts the session waits, and runs on the process resumed at the rewind point', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    await heldConversation(client, queries, ws.sent);
    client({ type: 'rewind_conversation', messageUuid: AT, config: { ...DEFAULT_CONFIG, sessionId: UUID } });
    await settle();
    assert.equal(queries[0].inputClosed, true);
    client({ type: 'query', prompt: 'after the rewind', ...DEFAULT_CONFIG, sessionId: UUID });
    await settle();
    assert.equal(queries.length, 1, 'the prompt starts nothing while the session restarts');
    queries[0].release();
    await until(() => queries.length === 2 && queries[1].pushed.length === 1);
    await settle();
    assert.equal(queries.length, 2);
    assert.equal(queries[1].options.resumeSessionAt, AT, 'the process the prompt runs on is the rewound one');
    assert.equal(queries[1].options.resume, UUID);
    assert.deepEqual(texts(queries[1]), ['after the rewind']);
    assert.equal(aborted(queries[1]), false);
    assert.equal(ws.sent.find(m => m.type === 'rewind_conversation_result')?.ok, true);
  } finally { close(); }
});

test('W05: a prompt sent while the session restarts to forget its rules waits, and its process is not aborted', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    await heldConversation(client, queries, ws.sent);
    client({ type: 'session_request', id: 'f-1', what: 'forget_session_rules' });
    await settle();
    assert.equal(queries[0].inputClosed, true);
    client({ type: 'query', prompt: 'again', ...DEFAULT_CONFIG, sessionId: UUID });
    await settle();
    assert.equal(queries.length, 1);
    queries[0].release();
    await until(() => queries.length === 2 && queries[1].pushed.length === 1);
    await settle();
    assert.equal(aborted(queries[1]), false);
    assert.equal(queries[1].options.resume, UUID);
    const answer = ws.sent.find(m => m.type === 'session_response' && m.id === 'f-1');
    assert.equal(answer?.ok, true);
    assert.equal(answer.data.restarted, true);
  } finally { close(); }
});

test('W05: a teardown ends the process it found, never one started while it waited (an idle reap, then a prompt)', async () => {
  const { session, queries, sent, close } = ownSession({ panel: true });
  try {
    await heldConversation((m) => session.handleMessage(m), queries, sent);
    // What the idle reaper does: end the process, not awaited.
    session._endQuery({ graceful: true });
    await settle();
    await session.handleMessage({ type: 'query', prompt: 'back', ...DEFAULT_CONFIG, sessionId: UUID });
    await until(() => queries.length === 2 && queries[1].pushed.length === 1);
    queries[0].release();
    await settle(60);
    assert.equal(aborted(queries[0]), true);
    assert.equal(aborted(queries[1]), false, 'the process the prompt started is not the reaper\'s to abort');
    assert.equal(session.q, queries[1]);
  } finally { close(); }
});

test('W05: a process a recovery restarted during the wait is not what the control runs on', async () => {
  const { session, queries, sent, close } = ownSession({ panel: true });
  try {
    await heldConversation((m) => session.handleMessage(m), queries, sent);
    const compact = session.handleMessage({ type: 'compact', config: WORK_CONFIG });
    await settle();
    // A stall retry that was already under way restarts the conversation the tab left.
    await session._recreateQuery('continue');
    assert.equal(queries.length, 2);
    assert.equal(queries[1].options.resume, UUID);
    queries[0].release();
    await compact;
    await until(() => queries.length === 3 && queries[2].pushed.length === 1);
    assert.equal(aborted(queries[1]), true, 'what the recovery restarted was the old conversation: it is ended');
    assert.equal(queries[2].options.env.CLAUDE_CONFIG_DIR, WORK);
    assert.equal(queries[2].options.resume, undefined);
    assert.deepEqual(texts(queries[2]), ['/compact']);
    assert.equal(aborted(queries[2]), false);
    assert.equal(texts(queries[1]).includes('/compact'), false);
  } finally { close(); }
});

// ── A control that waits on the CLI gives its turn up, and checks before it goes on ──

test('a rewind whose answer never comes does not keep the tab\'s later messages waiting', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    await heldConversation(client, queries, ws.sent);
    queries[0].hold = false;
    queries[0].rewindFiles = () => new Promise(() => {});
    client({ type: 'rewind', userMessageUuid: PROMPT, config: { ...DEFAULT_CONFIG, sessionId: UUID } });
    client({ type: 'session_request', id: 'p-1', what: 'rewind_preview', args: { userMessageUuid: PROMPT }, config: { ...DEFAULT_CONFIG, sessionId: UUID } });
    client({ type: 'rewind_conversation', messageUuid: AT, userMessageUuid: PROMPT, config: { ...DEFAULT_CONFIG, sessionId: UUID } });
    await settle();
    client({ type: 'query', prompt: 'still here', ...DEFAULT_CONFIG, sessionId: UUID });
    await until(() => queries[0].pushed.length === 2);
    assert.deepEqual(texts(queries[0]), ['hello', 'still here']);
    assert.equal(queries.length, 1);
  } finally { close(); }
});

test('a prompt handled while a conversation rewind restores the files is not ended by it: the rewind stops and says so', async () => {
  const { ws, queries, client, close } = panelConnection({ transcriptParentOf: async () => AT });
  try {
    await heldConversation(client, queries, ws.sent);
    queries[0].hold = false;
    let restored = null;
    queries[0].rewindFiles = () => new Promise((resolve) => { restored = resolve; });
    client({ type: 'rewind_conversation', messageUuid: 'row-uuid', userMessageUuid: PROMPT, config: { ...DEFAULT_CONFIG, sessionId: UUID } });
    await until(() => !!restored);
    client({ type: 'query', prompt: 'meanwhile', ...DEFAULT_CONFIG, sessionId: UUID });
    await until(() => queries[0].pushed.length === 2);
    restored({ canRewind: true, filesChanged: [] });
    await until(() => ws.sent.some(m => m.type === 'rewind_conversation_result'));
    const result = ws.sent.find(m => m.type === 'rewind_conversation_result');
    assert.equal(result.ok, false);
    assert.match(result.error, /started working while the files were being restored/);
    assert.equal(queries.length, 1, 'the session was not restarted');
    assert.equal(aborted(queries[0]), false, 'and the prompt\'s turn was not ended');
    assert.equal(queries[0].inputClosed, false);
  } finally { close(); }
});

test('as before: a turn the CLI starts by itself while a conversation rewind restores the files does not stop the rewind', async () => {
  const { ws, queries, client, close } = panelConnection({ transcriptParentOf: async () => AT });
  try {
    await heldConversation(client, queries, ws.sent);
    queries[0].hold = false;
    let restored = null;
    queries[0].rewindFiles = () => new Promise((resolve) => { restored = resolve; });
    client({ type: 'rewind_conversation', messageUuid: 'row-uuid', userMessageUuid: PROMPT, config: { ...DEFAULT_CONFIG, sessionId: UUID } });
    await until(() => !!restored);
    // A background agent reports back: main-thread output nobody prompted.
    queries[0].emit({ type: 'assistant', parent_tool_use_id: null, session_id: UUID, message: { id: 'm-1', role: 'assistant', content: [{ type: 'text', text: 'the agent is done' }] } });
    await until(() => ws.sent.some(m => m.type === 'event' && m.event?.type === 'assistant'));
    restored({ canRewind: true, filesChanged: [] });
    await until(() => ws.sent.some(m => m.type === 'rewind_conversation_result'));
    assert.equal(ws.sent.find(m => m.type === 'rewind_conversation_result').ok, true);
    assert.equal(queries.length, 2);
    assert.equal(queries[1].options.resumeSessionAt, AT);
  } finally { close(); }
});

test('a conversation rewind does not go on in another conversation the tab moved to while the files were restored', async () => {
  const { ws, queries, client, close } = panelConnection({ transcriptParentOf: async () => AT });
  try {
    await heldConversation(client, queries, ws.sent);
    queries[0].hold = false;
    let restored = null;
    queries[0].rewindFiles = () => new Promise((resolve) => { restored = resolve; });
    client({ type: 'rewind_conversation', messageUuid: 'row-uuid', userMessageUuid: PROMPT, config: { ...DEFAULT_CONFIG, sessionId: UUID } });
    await until(() => !!restored);
    // Another session is picked in the same tab, and one of its checkpoints rewound.
    client({ type: 'rewind', userMessageUuid: PROMPT, config: { ...WORK_CONFIG, sessionId: OTHER } });
    await until(() => ws.sent.some(m => m.type === 'rewind_result'));
    assert.equal(queries.length, 2);
    restored({ canRewind: true, filesChanged: [] });
    await until(() => ws.sent.some(m => m.type === 'rewind_conversation_result'));
    await settle();
    const result = ws.sent.find(m => m.type === 'rewind_conversation_result');
    assert.equal(result.ok, false);
    assert.match(result.error, /moved to another conversation/);
    assert.equal(queries.length, 2, 'the other conversation\'s process was not restarted');
    assert.equal(aborted(queries[1]), false);
    assert.equal(queries[1].options.resumeSessionAt, undefined);
  } finally { close(); }
});

// ── Nothing is left stuck ──

test('the socket closes while a message waits its turn: nothing starts afterwards', async () => {
  const { ws, queries, client } = panelConnection();
  try {
    await heldConversation(client, queries, ws.sent);
    client({ type: 'compact', config: WORK_CONFIG });
    await settle();
    client({ type: 'compact', config: WORK_CONFIG });
    client({ type: 'query', prompt: 'next', ...WORK_CONFIG });
    await settle();
    ws.readyState = 3;
    ws.emit('close');
    queries[0].release();
    await settle(60);
    assert.equal(queries.length, 1, 'neither the Compact that was closing the old process nor the two that waited started one');
  } finally { shutdownAllBridges(); }
});

test('a teardown that throws gives the turn back: the next message is handled', async () => {
  const { session, queries, sent, close } = ownSession({ panel: true });
  try {
    await heldConversation((m) => session.handleMessage(m), queries, sent);
    queries[0].hold = false;
    const real = session._endQuery;
    session._endQuery = async () => { session._endQuery = real; throw new Error('teardown failed'); };
    await assert.rejects(session.handleMessage({ type: 'compact', config: WORK_CONFIG }), /teardown failed/);
    assert.equal(session._turnBusy, false, 'the turn was given back');
    await session.handleMessage({ type: 'compact', config: WORK_CONFIG });
    await until(() => queries.length === 2 && queries[1].pushed.length === 1);
    assert.deepEqual(texts(queries[1]), ['/compact']);
    assert.equal(session._turnBusy, false);
  } finally { close(); }
});

// ── As before (these pass with and without the fix) ──

test('as before: a single Compact after New chat, with nothing overlapping: the old process is given its time, then one new process takes it', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    await heldConversation(client, queries, ws.sent);
    client({ type: 'compact', config: WORK_CONFIG });
    await settle();
    assert.equal(queries.length, 1);
    assert.equal(queries[0].inputClosed, true);
    assert.equal(aborted(queries[0]), false);
    queries[0].release();
    await until(() => queries.length === 2 && queries[1].pushed.length === 1);
    await settle();
    assert.equal(queries.length, 2);
    assert.equal(aborted(queries[0]), true);
    assert.equal(aborted(queries[1]), false);
    assert.equal(queries[1].options.env.CLAUDE_CONFIG_DIR, WORK);
    assert.equal(queries[1].options.permissionMode, 'plan');
    assert.equal(queries[1].options.resume, undefined);
    assert.deepEqual(texts(queries[1]), ['/compact']);
    assert.deepEqual(texts(queries[0]), ['hello']);
    assert.deepEqual(errors(ws.sent), []);
    assert.equal(ws.sent.filter(m => m.type === 'event' && m.event?.subtype === 'compact_started').length, 1);
  } finally { close(); }
});

test('as before: a message that meets no other is handled in the tick it arrives', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'query', prompt: 'hello', ...DEFAULT_CONFIG });
    assert.equal(queries.length, 1, 'the process is started before the message event returns');
    await until(() => queries[0].pushed.length === 1);
    queries[0].emit({ type: 'system', subtype: 'init', session_id: UUID });
    queries[0].emit({ type: 'result', subtype: 'success', session_id: UUID, total_cost_usd: 0, usage: {} });
    await until(() => ws.sent.some(m => m.type === 'done'));
    const before = ws.sent.length;
    client({ type: 'compact', config: { ...DEFAULT_CONFIG, sessionId: UUID } });
    assert.equal(ws.sent.slice(before).some(m => m.type === 'event' && m.event?.subtype === 'compact_started'), true, 'a control too');
    await until(() => queries[0].pushed.length === 2);
    assert.equal(queries.length, 1);
  } finally { close(); }
});

test('as before: messages read in one tick are handled in that tick, in order (a warm start, a prompt, a Stop)', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'warm', ...DEFAULT_CONFIG });
    client({ type: 'query', prompt: 'hello', ...DEFAULT_CONFIG });
    client({ type: 'abort' });
    assert.equal(queries.length, 1, 'the prompt was not held back by the warm start before it');
    assert.equal(queries[0].interrupts, 1, 'and the Stop met the turn the prompt started');
    await until(() => ws.sent.some(m => m.type === 'aborted'));
    assert.deepEqual(texts(queries[0]), ['hello']);
  } finally { close(); }
});

// ── A session without the panel flag (the Assistant brain) ──

test('a session without the panel flag takes no turns and ends a process exactly as before', async () => {
  const { session, queries, sent, close } = ownSession({});
  try {
    await session.handleMessage({ type: 'query', prompt: 'hello', windowId: 'w-np' });
    assert.equal(queries.length, 1);
    await until(() => queries[0].pushed.length === 1);
    queries[0].emit({ type: 'system', subtype: 'init', session_id: UUID });
    queries[0].emit({ type: 'result', subtype: 'success', session_id: UUID, total_cost_usd: 0, usage: {} });
    await until(() => sent.some(m => m.type === 'done'));
    await session.handleMessage({ type: 'rewind', userMessageUuid: PROMPT });
    assert.deepEqual(sent.find(m => m.type === 'rewind_result'), { type: 'rewind_result', ok: true, userMessageUuid: PROMPT });
    queries[0].hold = true;
    // A query without a session id restarts the session: handleMessage resolves
    // at once, it does not wait for the restart.
    const first = session.handleMessage({ type: 'query', prompt: 'new chat', windowId: 'w-np' });
    assert.equal(await Promise.race([first.then(() => 'resolved'), settle().then(() => 'waiting')]), 'resolved');
    assert.equal(queries[0].inputClosed, true);
    // A second one during the wait is not held back: it starts a process at once.
    await session.handleMessage({ type: 'query', prompt: 'second', windowId: 'w-np' });
    assert.equal(queries.length, 2, 'no turns: the message is handled when it arrives');
    queries[0].release();
    await settle(60);
    // Unchanged on purpose (ground rule: this session takes the path it took):
    // its teardown still aborts whatever controller the session has after the wait.
    assert.equal(aborted(queries[1]), true);
    assert.equal(queries.length, 2);
    // Nothing of the panel's turn bookkeeping is ever written on it.
    for (const field of ['_turnBusy', '_turnWaiters', '_conversationMoves', '_everStarted']) assert.equal(session[field], undefined, field);
    // A Stop and a mode switch are handled when they arrive, with or without a process.
    await session.handleMessage({ type: 'set_permission_mode', mode: 'plan' });
    await session.handleMessage({ type: 'abort' });
    assert.equal(sent.filter(m => m.type === 'aborted').length, 1);
    assert.equal(session.permissionMode, 'plan');
  } finally { close(); }
});

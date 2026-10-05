// Review 3 of the Claude panel parity build, bridge side.
// T01: a session object nothing configured yet (the server restarted, or the
// tab's idle session was dropped with its socket) is "cold". Whatever message
// reaches it first must bring the tab's configuration (account, tool policy,
// permission mode, session settings) and establish it the way a query does;
// a control that brings none starts nothing.
// T07: a conversation rewind never uses the page's own row id when the
// transcript lookup the host wired cannot name the parent.
// Each test fails without its fix, except the non-panel pins, which were
// written first and pass before and after.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import { ClaudeSession, configureClaudeBridge, createClaudeBridge, shutdownAllBridges } from '../lib/claude-agent-bridge.js';
import { START_CONFIG_TYPES, withStartConfig } from '../public/shared/cp/cp-restore.js';

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
  q.rewound = [];
  q.emit = (m) => { queue.push(m); wakeUp(); };
  q.interrupt = async () => {};
  q.setPermissionMode = async () => {};
  q.setModel = async () => {};
  q.applyFlagSettings = async () => {};
  q.supportedCommands = async () => [];
  q.mcpServerStatus = async () => [];
  q.initializationResult = async () => ({ commands: [], agents: [], models: [] });
  q.rewindFiles = async (uuid, opts) => { q.rewound.push({ uuid, dryRun: opts?.dryRun === true }); return { canRewind: true, filesChanged: [] }; };
  (async () => { for await (const m of prompt) q.pushed.push(m); finish(); })();
  options.abortController?.signal.addEventListener('abort', finish, { once: true });
  return q;
}

function configure(extra = {}) {
  const queries = [];
  const locks = [];
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(), includePartialMessages: false,
    queryFactory: (args) => { const q = scriptedQuery(args); queries.push(q); return q; },
    acquireSessionLock: (sid, wid) => { locks.push([sid, wid]); return { ok: true }; }, heartbeatLock: () => {}, releaseAllLocks: () => {},
    getSessionCost: () => 0, addCost: () => {}, maybeInjectSkillPrompt: (prompt) => ({ prompt }),
    toCliModelName: (model) => model, writePlanFile: () => ({ ok: false }),
    ...extra,
  });
  queries.locks = locks;
  return queries;
}

const WORK = '/home/me/.claude-accounts/work';
const accounts = { claudeAccountEnv: (id) => (id === 'work' ? { CLAUDE_CONFIG_DIR: WORK } : {}) };

function panelConnection(extra = {}) {
  const queries = configure({ ...accounts, ...extra });
  const ws = new EventEmitter();
  Object.assign(ws, { readyState: 1, bufferedAmount: 0, sent: [], ping() {}, terminate() {} });
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  createClaudeBridge(ws);
  const client = (msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)));
  return { ws, queries, client, close: () => { ws.readyState = 3; ws.emit('close'); } };
}

async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 5));
  }
}
const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PROMPT = '11111111-1111-4111-8111-111111111111';
const BEFORE = '22222222-2222-4222-8222-222222222222';
const PARENT = '33333333-3333-4333-8333-333333333333';

// What the panel's _startConfig() builds for a restored tab: the fields of an
// ordinary query, without a prompt.
const CONFIG = Object.freeze({
  cwd: process.cwd(), sessionId: UUID, windowId: 'w-t1',
  accountId: 'work', toolPolicy: 'read-only', permissionMode: 'plan',
  session: { maxTurns: 7 },
  features: ['elicitation', 'task_stop'],
});

// Every message that can be the first to reach a cold session and start its
// process, with what its refusal looks like on the wire.
const STARTERS = [
  { name: 'compact', msg: { type: 'compact' }, refused: (sent) => sent.find(m => m.type === 'error') },
  { name: 'rewind', msg: { type: 'rewind', userMessageUuid: PROMPT }, refused: (sent) => { const r = sent.find(m => m.type === 'rewind_result'); return r && r.ok === false ? { message: r.error, code: r.code } : null; } },
  { name: 'rewind_conversation', msg: { type: 'rewind_conversation', messageUuid: BEFORE, userMessageUuid: PROMPT }, refused: (sent) => { const r = sent.find(m => m.type === 'rewind_conversation_result'); return r && r.ok === false ? { message: r.error, code: r.code } : null; } },
  { name: 'session_request rewind_preview', msg: { type: 'session_request', id: 'sr-1', what: 'rewind_preview', args: { userMessageUuid: PROMPT } }, refused: (sent) => { const r = sent.find(m => m.type === 'session_response'); return r && r.ok === false ? { message: r.error, code: r.code } : null; } },
];

// ── T01 ──

for (const starter of STARTERS) {
  test(`T01: a cold session starts nothing for ${starter.name} that brings no configuration`, async () => {
    const { ws, queries, client, close } = panelConnection();
    try {
      client({ type: 'reattach', windowId: 'w-t1', sessionId: UUID });
      await until(() => ws.sent.some(m => m.type === 'reattach_result'));
      client(starter.msg);
      await until(() => !!starter.refused(ws.sent));
      await settle();
      assert.equal(queries.length, 0, 'no process started under the default identity');
      const refusal = starter.refused(ws.sent);
      assert.equal(refusal.code, 'config_required');
      assert.match(refusal.message, /reload/i, 'the refusal says what to do');
      assert.equal(ws.sent.some(m => m.type === 'event' && m.event?.subtype === 'compact_started'), false, 'nothing is announced as started');
    } finally { close(); shutdownAllBridges(); }
  });

  test(`T01: ${starter.name} that brings the tab's configuration starts the session under it`, async () => {
    const { ws, queries, client, close } = panelConnection();
    try {
      client({ type: 'reattach', windowId: 'w-t1', sessionId: UUID });
      await until(() => ws.sent.some(m => m.type === 'reattach_result'));
      client({ ...starter.msg, config: CONFIG });
      await until(() => queries.length >= 1);
      await settle();
      const options = queries[0].options;
      assert.equal(options.env.CLAUDE_CONFIG_DIR, WORK, 'the saved account, not the ambient one');
      assert.equal(options.resume, UUID);
      assert.equal(options.permissionMode, 'plan');
      for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Bash']) assert.ok(options.disallowedTools.includes(tool), `${tool} is removed by the read-only policy`);
      assert.equal(options.maxTurns, 7, 'the session settings reached the options');
      assert.equal(typeof options.onElicitation, 'function', 'what the page can render came along');
      assert.equal(ws.sent.some(m => m.code === 'config_required'), false);
      // The same lock an ordinary query takes.
      assert.deepEqual(queries.locks, [[UUID, 'w-t1']]);
    } finally { close(); shutdownAllBridges(); }
  });
}

test('T01: the configuration a control brings is checked like a query\'s: an account that is gone starts nothing', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'reattach', windowId: 'w-t1', sessionId: UUID });
    client({ type: 'compact', config: { ...CONFIG, accountId: 'removed-profile' } });
    await until(() => ws.sent.some(m => m.type === 'error'));
    await settle();
    assert.equal(ws.sent.find(m => m.type === 'error').code, 'account_unavailable');
    assert.equal(queries.length, 0);
    // The tab is not stuck: a control with a usable configuration still starts it.
    client({ type: 'rewind', userMessageUuid: PROMPT, config: CONFIG });
    await until(() => queries.length === 1);
    assert.equal(queries[0].options.env.CLAUDE_CONFIG_DIR, WORK);
  } finally { close(); shutdownAllBridges(); }
});

test('T01: a lock held by another window refuses the cold control, as it refuses a query', async () => {
  const { ws, queries, client, close } = panelConnection({ acquireSessionLock: () => ({ ok: false }) });
  try {
    client({ type: 'reattach', windowId: 'w-t1', sessionId: UUID });
    client({ type: 'rewind', userMessageUuid: PROMPT, config: CONFIG });
    await until(() => ws.sent.some(m => m.type === 'rewind_result'));
    await settle();
    assert.equal(queries.length, 0);
    assert.match(ws.sent.find(m => m.type === 'rewind_result').error, /locked by another window/i);
  } finally { close(); shutdownAllBridges(); }
});

test('T01: the control that established a cold session makes the conversation its account\'s', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'reattach', windowId: 'w-t1', sessionId: UUID });
    client({ type: 'compact', config: CONFIG });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    assert.equal(queries[0].pushed[0].message.content[0].text, '/compact');
    client({ type: 'query', prompt: 'switch', windowId: 'w-t1', sessionId: UUID, accountId: 'default', toolPolicy: 'full' });
    await until(() => ws.sent.some(m => m.type === 'error'));
    assert.equal(ws.sent.find(m => m.type === 'error').code, 'account_change_refused');
    assert.equal(queries.length, 1);
  } finally { close(); shutdownAllBridges(); }
});

test('T01: a new tab whose first message is a control is cold too', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'compact' });
    await until(() => ws.sent.some(m => m.type === 'error'));
    await settle();
    assert.equal(queries.length, 0);
    assert.equal(ws.sent.find(m => m.type === 'error').code, 'config_required');
    assert.equal(ws.sent.some(m => m.type === 'done'), true, 'the tab is released');
  } finally { close(); shutdownAllBridges(); }
});

test('T01: a session a query configured keeps resuming for controls after its process was reaped', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'query', prompt: 'hello', windowId: 'w-t1', accountId: 'work', toolPolicy: 'read-only', permissionMode: 'plan' });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    queries[0].emit({ type: 'system', subtype: 'init', session_id: UUID });
    queries[0].emit({ type: 'result', subtype: 'success', session_id: UUID, total_cost_usd: 0, usage: {} });
    await until(() => ws.sent.some(m => m.type === 'done'));
    // The idle reaper ends the process; the session object stays.
    queries[0].options.abortController.abort();
    await settle();
    client({ type: 'rewind', userMessageUuid: PROMPT });
    await until(() => ws.sent.some(m => m.type === 'rewind_result'));
    const result = ws.sent.find(m => m.type === 'rewind_result');
    if (queries.length === 2) {
      assert.equal(result.ok, true);
      assert.equal(queries[1].options.env.CLAUDE_CONFIG_DIR, WORK, 'resumed under the configuration it has');
      assert.ok(queries[1].options.disallowedTools.includes('Bash'));
    } else {
      // The scripted process is still attached: the rewind ran on it.
      assert.equal(result.ok, true);
    }
    assert.equal(ws.sent.some(m => m.code === 'config_required'), false, 'an established session is never asked for its configuration again');
  } finally { close(); shutdownAllBridges(); }
});

test('T01: a query on a cold session is its own configuration, as before', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'reattach', windowId: 'w-t1', sessionId: UUID });
    client({ type: 'query', prompt: 'continue', windowId: 'w-t1', sessionId: UUID, accountId: 'work', toolPolicy: 'no-web' });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    assert.equal(queries[0].options.env.CLAUDE_CONFIG_DIR, WORK);
    assert.ok(queries[0].options.disallowedTools.includes('WebFetch'));
    assert.deepEqual(ws.sent.filter(m => m.type === 'error'), []);
  } finally { close(); shutdownAllBridges(); }
});

test('T01: every message type that can start a process is one the panel sends its configuration with', () => {
  const src = readFileSync(new URL('../lib/claude-agent-bridge.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async handleMessage(msg, turn = null) {'), src.indexOf('_handleQuery(msg, { warmOnly = false'));
  const cases = body.split(/\n {6}case '/).slice(1);
  const starters = new Set();
  let carried = [];
  for (const chunk of cases) {
    const name = chunk.slice(0, chunk.indexOf("'"));
    carried.push(name);
    // `case 'a':\n case 'b': {` share one body: the names before a body all get it.
    const hasBody = chunk.replace(/^[^\n]*\n/, '').trim().length > 0 || /\{\s*$/.test(chunk.split('\n')[0]);
    if (!hasBody) continue;
    if (/ensureQuery\(|_pushUserText\(|_handleQuery\(/.test(chunk)) for (const n of carried) starters.add(n);
    carried = [];
  }
  // A query and a warm start are the configuration themselves.
  const expected = new Set(['query', 'warm', ...START_CONFIG_TYPES]);
  assert.deepEqual([...starters].sort(), [...expected].sort(), 'a new process-starting message type needs a row in START_CONFIG_TYPES (cp/cp-restore.js) and in this file\'s STARTERS');
  for (const s of STARTERS) assert.ok(expected.has(s.msg.type), s.name);
});

test('T01: the panel attaches the configuration to exactly the starting controls', () => {
  const config = { sessionId: UUID, accountId: 'work' };
  for (const type of START_CONFIG_TYPES) assert.deepEqual(withStartConfig({ type }, config), { type, config });
  for (const type of ['heartbeat', 'abort', 'control_response', 'reattach', 'dispose', 'stop_task', 'mcp_status', 'query', 'warm']) {
    assert.deepEqual(withStartConfig({ type }, config), { type }, `${type} carries none`);
  }
  // Nothing to attach (a tab not on the SDK engine): the message goes as it is.
  assert.deepEqual(withStartConfig({ type: 'compact' }, null), { type: 'compact' });
  const original = { type: 'compact' };
  withStartConfig(original, config);
  assert.deepEqual(original, { type: 'compact' }, 'the message it was given is not changed');
});

// The pre-SDK text answer to a question (`tool_result`) went with the legacy
// engine: no client sends it, and the bridge has no handler that could start a
// process for it, on a panel session or any other.
test('the retired tool_result message starts nothing and is answered with nothing', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'reattach', windowId: 'w-t1', sessionId: UUID });
    await until(() => ws.sent.some(m => m.type === 'reattach_result'));
    const before = ws.sent.length;
    client({ type: 'tool_result', content: 'yes', config: CONFIG });
    await settle();
    assert.equal(queries.length, 0);
    assert.equal(ws.sent.length, before);
  } finally { close(); shutdownAllBridges(); }

  const plain = configure();
  const sent = [];
  const session = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send: (d) => sent.push(JSON.parse(d)) }, {});
  try {
    session.sessionId = UUID;
    await session.handleMessage({ type: 'tool_result', content: 'yes' });
    await settle();
    assert.equal(plain.length, 0);
    assert.deepEqual(sent, []);
  } finally { session.destroy(); shutdownAllBridges(); }
  const src = readFileSync(new URL('../lib/claude-agent-bridge.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /case 'tool_result'/);
});

// ── A session without the panel flag (the Assistant brain, loops) ──

test('a session without the panel flag starts cold for every control exactly as before', async () => {
  for (const starter of STARTERS) {
    const queries = configure();
    const sent = [];
    const session = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send: (d) => sent.push(JSON.parse(d)) }, {});
    try {
      session.sessionId = UUID;
      await session.handleMessage(starter.msg);
      await settle();
      if (starter.msg.type === 'rewind_conversation' || starter.msg.type === 'session_request') {
        // Panel-only messages: ignored, nothing starts, nothing is said.
        assert.equal(queries.length, 0, starter.name);
        assert.deepEqual(sent, [], starter.name);
        continue;
      }
      assert.equal(queries.length, 1, `${starter.name} starts the process without any configuration message`);
      const options = queries[0].options;
      assert.equal(options.resume, UUID);
      assert.equal(options.permissionMode, 'default');
      assert.equal('disallowedTools' in options, false);
      assert.equal('CLAUDE_CONFIG_DIR' in options.env, false);
      assert.equal(sent.some(m => m.type === 'error'), false, starter.name);
      assert.equal(sent.some(m => m.code === 'config_required'), false, starter.name);
      assert.equal(session.accountId, undefined);
      // A `config` field means nothing to it.
      assert.equal(queries.locks.length, 0, 'no lock is taken for a control');
    } finally { session.destroy(); }
  }
  shutdownAllBridges();
});

test('a session without the panel flag ignores a `config` on a control', async () => {
  const queries = configure(accounts);
  const sent = [];
  const session = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send: (d) => sent.push(JSON.parse(d)) }, {});
  try {
    session.sessionId = UUID;
    await session.handleMessage({ type: 'compact', config: CONFIG });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    const options = queries[0].options;
    assert.equal(options.permissionMode, 'default');
    assert.equal('disallowedTools' in options, false);
    assert.equal('CLAUDE_CONFIG_DIR' in options.env, false);
    assert.equal('maxTurns' in options, false);
    assert.equal(session.accountId, undefined);
    assert.equal(queries.locks.length, 0);
  } finally { session.destroy(); shutdownAllBridges(); }
});

// ── T07 ──

async function establishedSession(extra) {
  const conn = panelConnection(extra);
  conn.client({ type: 'query', prompt: 'hello', windowId: 'w-t7', accountId: 'work', cwd: process.cwd() });
  await until(() => conn.queries.length === 1 && conn.queries[0].pushed.length === 1);
  conn.queries[0].emit({ type: 'system', subtype: 'init', session_id: UUID });
  conn.queries[0].emit({ type: 'result', subtype: 'success', session_id: UUID, total_cost_usd: 0, usage: {} });
  await until(() => conn.ws.sent.some(m => m.type === 'done'));
  return conn;
}
const rewindResult = (ws) => ws.sent.find(m => m.type === 'rewind_conversation_result');

for (const [label, lookup] of [
  ['cannot find the prompt', async () => null],
  ['fails', async () => { throw new Error('transcript unreadable'); }],
  ['returns something that is not an id', async () => ({ uuid: PARENT })],
]) {
  test(`T07: a conversation rewind is refused when the transcript lookup ${label}`, async () => {
    const { ws, queries, client, close } = await establishedSession({ transcriptParentOf: lookup });
    try {
      client({ type: 'rewind_conversation', messageUuid: BEFORE, userMessageUuid: PROMPT });
      await until(() => !!rewindResult(ws));
      await settle();
      const result = rewindResult(ws);
      assert.equal(result.ok, false);
      assert.match(result.error, /transcript/i);
      assert.equal(queries.length, 1, 'the session was not restarted');
      assert.deepEqual(queries[0].rewound, [], 'no file was rewound');
      assert.equal(queries[0].options.abortController.signal.aborted, false, 'the process is still the one that was running');
    } finally { close(); shutdownAllBridges(); }
  });
}

test('T07: with a lookup wired, a rewind that names no prompt is refused: the page\'s row id alone is never used', async () => {
  const calls = [];
  const { ws, queries, client, close } = await establishedSession({ transcriptParentOf: async (a) => { calls.push(a); return PARENT; } });
  try {
    client({ type: 'rewind_conversation', messageUuid: BEFORE });
    await until(() => !!rewindResult(ws));
    await settle();
    assert.equal(rewindResult(ws).ok, false);
    assert.equal(queries.length, 1);
    assert.deepEqual(calls, []);
  } finally { close(); shutdownAllBridges(); }
});

test('T07: the transcript\'s answer is where the conversation resumes, with the files rewound to the prompt', async () => {
  const calls = [];
  const { ws, queries, client, close } = await establishedSession({ transcriptParentOf: async (a) => { calls.push(a); return PARENT; } });
  try {
    client({ type: 'rewind_conversation', messageUuid: BEFORE, userMessageUuid: PROMPT });
    await until(() => !!rewindResult(ws) && queries.length === 2);
    assert.equal(rewindResult(ws).ok, true);
    assert.equal(rewindResult(ws).messageUuid, PARENT);
    assert.equal(queries[1].options.resumeSessionAt, PARENT);
    assert.deepEqual(queries[0].rewound, [{ uuid: PROMPT, dryRun: false }]);
    assert.equal(calls[0].uuid, PROMPT);
    assert.equal(calls[0].accountId, 'work');
  } finally { close(); shutdownAllBridges(); }
});

test('T07: a host that wired no lookup keeps the page\'s entry (there is nothing better to ask)', async () => {
  const { ws, queries, client, close } = await establishedSession();
  try {
    client({ type: 'rewind_conversation', messageUuid: BEFORE, userMessageUuid: PROMPT });
    await until(() => !!rewindResult(ws) && queries.length === 2);
    assert.equal(rewindResult(ws).ok, true);
    assert.equal(queries[1].options.resumeSessionAt, BEFORE);
  } finally { close(); shutdownAllBridges(); }
});

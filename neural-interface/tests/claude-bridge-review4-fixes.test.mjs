// Review 4 of the Claude panel parity build (the release gate), bridge side.
// W02: until a process has actually started for a tab, the configuration the
// latest starting message carries decides how it starts. A request that only
// looks (permission rules, usage, MCP status) establishes nothing: it binds no
// account, takes no lock and leaves the session as cold as it found it. Once a
// process has started, the rules are the ones a query has always had (the
// account of a conversation cannot change).
// Each W02 test fails without the fix; the "as before" and non-panel pins pass
// before and after, on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ClaudeSession, configureClaudeBridge, createClaudeBridge, shutdownAllBridges } from '../lib/claude-agent-bridge.js';

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
  q.emit = (m) => { queue.push(m); wakeUp(); };
  q.interrupt = async () => {};
  q.setPermissionMode = async () => {};
  q.setModel = async () => {};
  q.applyFlagSettings = async () => {};
  q.supportedCommands = async () => [];
  q.mcpServerStatus = async () => [];
  q.initializationResult = async () => ({ commands: [], agents: [], models: [] });
  q.rewindFiles = async () => ({ canRewind: true, filesChanged: [] });
  (async () => { for await (const m of prompt) q.pushed.push(m); finish(); })();
  options.abortController?.signal.addEventListener('abort', finish, { once: true });
  return q;
}

const WORK = '/home/me/.claude-accounts/work';
const accounts = { claudeAccountEnv: (id) => (id === 'work' ? { CLAUDE_CONFIG_DIR: WORK } : {}) };

function configure(extra = {}) {
  const queries = [];
  const warms = [];
  const locks = [];
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(), includePartialMessages: false,
    queryFactory: (args) => { const q = scriptedQuery(args); q.cold = true; queries.push(q); return q; },
    startupFactory: async ({ options }) => {
      const handle = { options, closed: false, close() { handle.closed = true; }, query(prompt) { const q = scriptedQuery({ prompt, options }); q.warm = true; queries.push(q); return q; } };
      warms.push(handle);
      return handle;
    },
    acquireSessionLock: (sid, wid) => { locks.push([sid, wid]); return { ok: true }; }, heartbeatLock: () => {}, releaseAllLocks: () => {},
    getSessionCost: () => 0, addCost: () => {}, maybeInjectSkillPrompt: (prompt) => ({ prompt }),
    toCliModelName: (model) => model, writePlanFile: () => ({ ok: false }),
    ...accounts, ...extra,
  });
  queries.locks = locks;
  queries.warms = warms;
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

// What the panel's _startConfig() builds: the fields of a query, without a prompt.
const DEFAULT_CONFIG = Object.freeze({ cwd: process.cwd(), windowId: 'w-w2', accountId: 'default', toolPolicy: 'full', permissionMode: 'default', features: ['elicitation'] });
const WORK_CONFIG = Object.freeze({ ...DEFAULT_CONFIG, accountId: 'work', toolPolicy: 'read-only', permissionMode: 'plan', session: { maxTurns: 7 } });

// The requests that only look: none of them can start a process.
const OBSERVERS = [
  { name: 'permission_rules', msg: { type: 'session_request', id: 'o-1', what: 'permission_rules' } },
  { name: 'usage', msg: { type: 'session_request', id: 'o-2', what: 'usage' } },
  { name: 'context_usage', msg: { type: 'session_request', id: 'o-3', what: 'context_usage' } },
  { name: 'mcp_status', msg: { type: 'session_request', id: 'o-4', what: 'mcp_status' } },
  { name: 'forget_session_rules', msg: { type: 'session_request', id: 'o-5', what: 'forget_session_rules' } },
];
const answered = (ws, id) => ws.sent.find(m => m.type === 'session_response' && m.id === id);

// ── W02: the finding itself ──

for (const observer of OBSERVERS) {
  test(`W02: /${observer.name} on a fresh tab, an account switch, then Compact: the session starts under the account Compact names`, async () => {
    const { ws, queries, client, close } = panelConnection();
    try {
      client({ ...observer.msg, config: DEFAULT_CONFIG });
      await until(() => !!answered(ws, observer.msg.id));
      assert.equal(queries.length, 0, 'looking starts nothing');
      // The user picked the work account (nothing is sent for that), then pressed Compact.
      client({ type: 'compact', config: WORK_CONFIG });
      await until(() => queries.length === 1 && queries[0].pushed.length === 1);
      const options = queries[0].options;
      assert.equal(options.env.CLAUDE_CONFIG_DIR, WORK, 'the account the starting control names, not the one the earlier request carried');
      assert.equal(options.permissionMode, 'plan');
      assert.ok(options.disallowedTools.includes('Bash'), 'and its restrictions');
      assert.equal(options.maxTurns, 7);
      assert.equal(queries[0].pushed[0].message.content[0].text, '/compact');
    } finally { close(); }
  });
}

test('W02: a request that only looks pins nothing: no account is bound, no lock is taken, the session stays cold', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'reattach', windowId: 'w-w2', sessionId: UUID });
    await until(() => ws.sent.some(m => m.type === 'reattach_result'));
    for (const observer of OBSERVERS) {
      client({ ...observer.msg, config: { ...DEFAULT_CONFIG, sessionId: UUID } });
      await until(() => !!answered(ws, observer.msg.id));
    }
    assert.deepEqual(queries.locks, [], 'looking takes no session lock');
    assert.equal(queries.length, 0);
    // Still cold: a control that brings no configuration is refused, as on a session nothing reached.
    client({ type: 'compact' });
    await until(() => ws.sent.some(m => m.type === 'error'));
    assert.equal(ws.sent.find(m => m.type === 'error').code, 'config_required');
    assert.equal(queries.length, 0);
    // The conversation is not the default account's because /permissions was opened under it:
    // the first message says whose it is, as on any cold resume.
    client({ type: 'query', prompt: 'continue', windowId: 'w-w2', sessionId: UUID, accountId: 'work', toolPolicy: 'full' });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    assert.equal(queries[0].options.env.CLAUDE_CONFIG_DIR, WORK);
    assert.equal(ws.sent.some(m => m.code === 'account_change_refused'), false);
  } finally { close(); }
});

test('W02: before a process has started, the latest configuration a starting control brings wins', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    // A rewind that names no message starts nothing, but brought the tab's configuration at the time.
    client({ type: 'rewind', config: DEFAULT_CONFIG });
    await until(() => ws.sent.some(m => m.type === 'rewind_result'));
    assert.equal(queries.length, 0);
    client({ type: 'compact', config: WORK_CONFIG });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    assert.equal(queries[0].options.env.CLAUDE_CONFIG_DIR, WORK);
    assert.ok(queries[0].options.disallowedTools.includes('Bash'));
  } finally { close(); }
});

test('W02: a later configuration that is refused leaves nothing of the earlier one to start under', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'rewind', config: DEFAULT_CONFIG });
    await until(() => ws.sent.some(m => m.type === 'rewind_result'));
    // The tab now names an account that is no longer set up: starting under the earlier one would be the wrong identity.
    client({ type: 'compact', config: { ...DEFAULT_CONFIG, accountId: 'removed-profile' } });
    await until(() => ws.sent.some(m => m.type === 'error'));
    await settle();
    assert.equal(ws.sent.find(m => m.type === 'error').code, 'account_unavailable');
    assert.equal(queries.length, 0, 'nothing started under the configuration that was replaced');
    assert.equal(ws.sent.some(m => m.type === 'event' && m.event?.subtype === 'compact_started'), false);
    // Not stuck: a usable configuration starts it.
    client({ type: 'compact', config: WORK_CONFIG });
    await until(() => queries.length === 1);
    assert.equal(queries[0].options.env.CLAUDE_CONFIG_DIR, WORK);
  } finally { close(); }
});

test('W02: a warm process started for the tab as it was is not what a starting control with another configuration runs on', async () => {
  const { queries, client, close } = panelConnection();
  try {
    client({ type: 'warm', ...DEFAULT_CONFIG });
    await until(() => queries.warms.length === 1);
    await settle(10);
    client({ type: 'compact', config: WORK_CONFIG });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    assert.equal(queries[0].cold, true, 'a fresh process, not the warm one');
    assert.equal(queries[0].options.env.CLAUDE_CONFIG_DIR, WORK);
    assert.equal(queries.warms[0].closed, true, 'the warm process of the other account is closed');
  } finally { close(); }
});

test('W02: the account is bound when the process starts: afterwards the conversation cannot change account', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'reattach', windowId: 'w-w2', sessionId: UUID });
    client({ type: 'session_request', id: 'o-1', what: 'permission_rules', config: { ...DEFAULT_CONFIG, sessionId: UUID } });
    await until(() => !!answered(ws, 'o-1'));
    client({ type: 'compact', config: { ...WORK_CONFIG, sessionId: UUID } });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    assert.equal(queries[0].options.env.CLAUDE_CONFIG_DIR, WORK);
    assert.equal(queries[0].options.resume, UUID);
    assert.deepEqual(queries.locks, [[UUID, 'w-w2']], 'the lock is taken once, by the control that started the session');
    client({ type: 'query', prompt: 'switch', windowId: 'w-w2', sessionId: UUID, accountId: 'default', toolPolicy: 'full' });
    await until(() => ws.sent.some(m => m.type === 'error'));
    assert.equal(ws.sent.find(m => m.type === 'error').code, 'account_change_refused');
    assert.equal(queries.length, 1);
  } finally { close(); }
});

// ── W02, the same tab on another conversation ──
// New chat and the session menu keep the tab's socket, so its session object
// has already started a process: for the conversation the tab was on. A
// starting control for the conversation it is on now is judged the way a
// prompt is (another session id, or none where there was one): the old process
// is not what it runs on, and no process has started for the new one.

const OTHER = '44444444-4444-4444-8444-444444444444';

async function conversationUnderDefault(conn) {
  conn.client({ type: 'query', prompt: 'hello', ...DEFAULT_CONFIG });
  await until(() => conn.queries.length === 1 && conn.queries[0].pushed.length === 1);
  conn.queries[0].emit({ type: 'system', subtype: 'init', session_id: UUID });
  conn.queries[0].emit({ type: 'result', subtype: 'success', session_id: UUID, total_cost_usd: 0, usage: {} });
  await until(() => conn.ws.sent.some(m => m.type === 'done'));
}

test('W02: after New chat in the same tab and an account switch, Compact does not run on the conversation the tab left', async () => {
  const conn = panelConnection();
  const { ws, queries, client, close } = conn;
  try {
    await conversationUnderDefault(conn);
    // New chat (the tab has no session id now), /account work, Compact.
    client({ type: 'compact', config: WORK_CONFIG });
    await until(() => queries.length === 2 && queries[1].pushed.length === 1);
    assert.equal(queries[1].options.env.CLAUDE_CONFIG_DIR, WORK, 'the new chat starts under the account the tab names');
    assert.equal(queries[1].options.resume, undefined, 'and is not the old conversation resumed');
    assert.equal(queries[1].pushed[0].message.content[0].text, '/compact');
    assert.equal(queries[0].pushed.length, 1, 'nothing was sent into the conversation the tab left');
    assert.equal(queries[0].options.abortController.signal.aborted, true, 'its process was ended, as a prompt on the new chat ends it');
    // The new chat is the work account's: its first prompt is not an account change.
    queries[1].emit({ type: 'system', subtype: 'init', session_id: OTHER });
    client({ type: 'query', prompt: 'go on', windowId: 'w-w2', sessionId: OTHER, accountId: 'work', toolPolicy: 'read-only', permissionMode: 'plan', session: { maxTurns: 7 } });
    await until(() => queries[1].pushed.length === 2);
    assert.equal(ws.sent.some(m => m.code === 'account_change_refused'), false);
    assert.equal(queries.length, 2);
  } finally { close(); }
});

test('W02: after another session is picked in the same tab, a rewind starts that session, not the one the tab left', async () => {
  const conn = panelConnection();
  const { ws, queries, client, close } = conn;
  try {
    await conversationUnderDefault(conn);
    client({ type: 'rewind', userMessageUuid: PROMPT, config: { ...WORK_CONFIG, sessionId: OTHER } });
    await until(() => ws.sent.some(m => m.type === 'rewind_result'));
    assert.equal(ws.sent.find(m => m.type === 'rewind_result').ok, true);
    assert.equal(queries.length, 2);
    assert.equal(queries[1].options.resume, OTHER);
    assert.equal(queries[1].options.env.CLAUDE_CONFIG_DIR, WORK);
    assert.ok(queries[1].options.disallowedTools.includes('Bash'));
    assert.deepEqual(queries.locks.filter(l => l[0] === OTHER), [[OTHER, 'w-w2']], 'the session it starts is locked for this window, as by a prompt');
  } finally { close(); }
});

test('as before: a control in a conversation whose id neither side knows yet goes to the running process', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'query', prompt: 'hello', ...WORK_CONFIG });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    // No init yet: the tab has no session id, and neither has the bridge.
    client({ type: 'compact', config: DEFAULT_CONFIG });
    await until(() => queries[0].pushed.length === 2);
    assert.equal(queries.length, 1);
    assert.equal(queries[0].pushed[1].message.content[0].text, '/compact');
    assert.equal(queries[0].options.abortController.signal.aborted, false);
    assert.equal(ws.sent.filter(m => m.type === 'error').length, 0);
  } finally { close(); }
});

// ── As before (these pass with and without the fix) ──

test('as before: once a process has started, a control\'s configuration changes nothing', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'query', prompt: 'hello', windowId: 'w-w2', accountId: 'work', toolPolicy: 'read-only', permissionMode: 'plan' });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    queries[0].emit({ type: 'system', subtype: 'init', session_id: UUID });
    queries[0].emit({ type: 'result', subtype: 'success', session_id: UUID, total_cost_usd: 0, usage: {} });
    await until(() => ws.sent.some(m => m.type === 'done'));
    client({ type: 'compact', config: { ...DEFAULT_CONFIG, sessionId: UUID } });
    await until(() => queries[0].pushed.length === 2);
    assert.equal(queries.length, 1, 'the running process took it');
    assert.equal(queries[0].pushed[1].message.content[0].text, '/compact');
    assert.equal(queries[0].options.env.CLAUDE_CONFIG_DIR, WORK);
    assert.equal(ws.sent.filter(m => m.type === 'error').length, 0);
    // And a rewind after the process was ended resumes under what the conversation has.
    queries[0].options.abortController.abort();
    await settle();
    client({ type: 'rewind', userMessageUuid: PROMPT, config: { ...DEFAULT_CONFIG, sessionId: UUID } });
    await until(() => ws.sent.some(m => m.type === 'rewind_result'));
    if (queries.length === 2) {
      assert.equal(queries[1].options.env.CLAUDE_CONFIG_DIR, WORK, 'still the account it started under');
      assert.ok(queries[1].options.disallowedTools.includes('Bash'));
    }
  } finally { close(); }
});

test('as before: a warm process is adopted by a starting control that names the same configuration', async () => {
  const { queries, client, close } = panelConnection();
  try {
    client({ type: 'warm', ...WORK_CONFIG });
    await until(() => queries.warms.length === 1);
    await settle(10);
    client({ type: 'compact', config: WORK_CONFIG });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    assert.equal(queries[0].warm, true);
    assert.equal(queries.warms[0].closed, false);
  } finally { close(); }
});

test('as before: a starting control without a configuration runs on what a warm start established (a page not reloaded yet)', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'warm', ...WORK_CONFIG });
    await until(() => queries.warms.length === 1);
    await settle(10);
    client({ type: 'compact' });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    assert.equal(queries[0].options.env.CLAUDE_CONFIG_DIR, WORK);
    assert.equal(ws.sent.some(m => m.code === 'config_required'), false);
  } finally { close(); }
});

// ── A session without the panel flag (the Assistant brain) ──

test('a session without the panel flag: looking and starting controls with a `config` behave exactly as before', async () => {
  const queries = configure();
  const sent = [];
  const session = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send: (d) => sent.push(JSON.parse(d)) }, {});
  try {
    session.sessionId = UUID;
    // Panel-only message: ignored, with or without a configuration.
    await session.handleMessage({ type: 'session_request', id: 'o-1', what: 'permission_rules', config: DEFAULT_CONFIG });
    assert.deepEqual(sent, []);
    assert.equal(queries.length, 0);
    await session.handleMessage({ type: 'compact', config: WORK_CONFIG });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    const options = queries[0].options;
    assert.equal(options.permissionMode, 'default');
    assert.equal('disallowedTools' in options, false);
    assert.equal('CLAUDE_CONFIG_DIR' in options.env, false);
    assert.equal('maxTurns' in options, false);
    assert.equal(session.accountId, undefined);
    assert.equal(queries.locks.length, 0);
    assert.equal(sent.some(m => m.type === 'error'), false);
    // A `config` that names another session is nothing to it either: the running process takes the control.
    await session.handleMessage({ type: 'compact', config: { ...WORK_CONFIG, sessionId: '44444444-4444-4444-8444-444444444444' } });
    await until(() => queries[0].pushed.length === 2);
    assert.equal(queries.length, 1);
    assert.equal(session.sessionId, UUID);
    // Nothing of the panel's start bookkeeping is ever written on it.
    for (const field of ['_established', '_accountBound', '_everStarted', '_coldRefusal']) assert.equal(session[field], undefined, field);
  } finally { session.destroy(); shutdownAllBridges(); }
});

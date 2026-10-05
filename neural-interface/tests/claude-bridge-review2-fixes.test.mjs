// Review 2 of the Claude panel parity build, bridge side: V03 and V05 (account
// identity at every process start), V13 (forgetting session rules asks before it
// kills background work), each failing without its fix, plus the proof that a
// session built without the panel flag is untouched by them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ClaudeSession, configureClaudeBridge, createClaudeBridge, shutdownAllBridges, panelCapabilities } from '../lib/claude-agent-bridge.js';

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

function configure(extra = {}) {
  const queries = [];
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(), includePartialMessages: false,
    queryFactory: (args) => { const q = scriptedQuery(args); queries.push(q); return q; },
    acquireSessionLock: () => ({ ok: true }), heartbeatLock: () => {}, releaseAllLocks: () => {},
    getSessionCost: () => 0, addCost: () => {}, maybeInjectSkillPrompt: (prompt) => ({ prompt }),
    toCliModelName: (model) => model, writePlanFile: () => ({ ok: false }),
    ...extra,
  });
  return queries;
}

// A registry the test can change while a session runs (an account removed in Settings).
function registry(initial = { work: '/home/me/.claude-accounts/work' }) {
  const accounts = { ...initial };
  let broken = false;
  return {
    accounts,
    breakIt: () => { broken = true; },
    deps: { claudeAccountEnv: (id) => { if (broken) throw new Error('registry unreadable'); return accounts[id] ? { CLAUDE_CONFIG_DIR: accounts[id] } : {}; } },
  };
}

function panelConnection(extra = {}) {
  const queries = configure(extra);
  const ws = new EventEmitter();
  Object.assign(ws, { readyState: 1, bufferedAmount: 0, sent: [], ping() {}, terminate() {} });
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  createClaudeBridge(ws);
  const client = (msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)));
  return { ws, queries, client, close: () => { ws.readyState = 3; ws.emit('close'); } };
}

function panelSession(extra = {}, opts = { panel: true }) {
  const queries = configure(extra);
  const sent = [];
  const session = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send: (d) => sent.push(JSON.parse(d)) }, opts);
  return { session, queries, sent };
}

async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 5));
  }
}
const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));
const errors = (sent) => sent.filter(m => m.type === 'error');
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const WORK = '/home/me/.claude-accounts/work';

// ── V03 ──

test('V03: a conversation of a named account resumes under it when its server-side object is gone', async () => {
  const { ws, queries, client, close } = panelConnection(registry().deps);
  try {
    // The page comes back after a server restart: there is no session to reattach to.
    client({ type: 'reattach', windowId: 'w-v3', sessionId: UUID });
    await until(() => ws.sent.some(m => m.type === 'reattach_result'));
    assert.equal(ws.sent.find(m => m.type === 'reattach_result').ok, false);
    // The tab's saved account comes with its next message.
    client({ type: 'query', prompt: 'continue', windowId: 'w-v3', sessionId: UUID, accountId: 'work', toolPolicy: 'full' });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    assert.deepEqual(errors(ws.sent), [], 'the legitimate account is not refused');
    assert.equal(queries[0].options.env.CLAUDE_CONFIG_DIR, WORK);
    assert.equal(queries[0].options.resume, UUID);
    // From here the conversation has an owner: another account is refused, as before.
    client({ type: 'query', prompt: 'switch', windowId: 'w-v3', sessionId: UUID, accountId: 'default', toolPolicy: 'full' });
    await until(() => errors(ws.sent).length === 1);
    assert.equal(errors(ws.sent)[0].code, 'account_change_refused');
    assert.equal(queries.length, 1);
    assert.equal(queries[0].pushed.length, 1);
  } finally { close(); shutdownAllBridges(); }
});

test('V03: a cold resume still validates the account, and a default-account conversation is owned by the default account', async () => {
  const a = panelConnection(registry().deps);
  try {
    a.client({ type: 'reattach', windowId: 'w-v3b', sessionId: UUID });
    a.client({ type: 'query', prompt: 'continue', windowId: 'w-v3b', sessionId: UUID, accountId: 'removed-profile' });
    await until(() => errors(a.ws.sent).length === 1);
    assert.equal(errors(a.ws.sent)[0].code, 'account_unavailable');
    await settle();
    assert.equal(a.queries.length, 0, 'nothing ran under the ambient account');
    // A warm start claims nothing: the first real message still decides the account.
    a.client({ type: 'warm', windowId: 'w-v3b', sessionId: UUID, accountId: 'default' });
    await settle();
    a.client({ type: 'query', prompt: 'continue', windowId: 'w-v3b', sessionId: UUID, accountId: 'work' });
    await until(() => a.queries.length === 1 && a.queries[0].pushed.length === 1);
    assert.equal(a.queries[0].options.env.CLAUDE_CONFIG_DIR, WORK);
  } finally { a.close(); shutdownAllBridges(); }

  const b = panelConnection(registry().deps);
  try {
    b.client({ type: 'reattach', windowId: 'w-v3c', sessionId: UUID });
    // A page that names no account (or an older one) owns the conversation as the default account.
    b.client({ type: 'query', prompt: 'continue', windowId: 'w-v3c', sessionId: UUID });
    await until(() => b.queries.length === 1 && b.queries[0].pushed.length === 1);
    assert.equal('CLAUDE_CONFIG_DIR' in b.queries[0].options.env, false);
    b.client({ type: 'query', prompt: 'switch', windowId: 'w-v3c', sessionId: UUID, accountId: 'work' });
    await until(() => errors(b.ws.sent).length === 1);
    assert.equal(errors(b.ws.sent)[0].code, 'account_change_refused');
    assert.equal(b.queries.length, 1);
  } finally { b.close(); shutdownAllBridges(); }
});

// ── V05 ──

test('V05: a process the bridge recreates by itself is refused once the account is gone', async () => {
  const reg = registry();
  const { session, queries, sent } = panelSession(reg.deps);
  try {
    session.windowId = 'w-v5';
    session._handleQuery({ prompt: 'go', accountId: 'work' });
    await until(() => queries[0]?.pushed.length === 1);
    assert.equal(queries[0].options.env.CLAUDE_CONFIG_DIR, WORK);
    queries[0].emit({ type: 'system', subtype: 'init', session_id: UUID });
    await until(() => session.sessionId === UUID);
    // While it is there, a recreation (stall recovery, stream drop) keeps the account.
    await session._recreateQuery('Please continue.');
    await until(() => queries.length === 2 && queries[1].pushed.length === 1);
    assert.equal(queries[1].options.env.CLAUDE_CONFIG_DIR, WORK);
    assert.equal(queries[1].options.resume, UUID);

    // The profile is removed in Settings while its process runs.
    delete reg.accounts.work;
    const before = sent.length;
    await session._recreateQuery('Please continue.');
    await settle();
    assert.equal(queries.length, 2, 'no process was started under the ambient identity');
    assert.equal(session.q, null);
    const after = sent.slice(before);
    assert.equal(errors(after).length, 1);
    assert.equal(errors(after)[0].code, 'account_unavailable');
    assert.equal(after.filter(m => m.type === 'done').length, 1, 'the turn the tab is waiting on is closed');
    assert.equal(session.inTurn, false);
    assert.equal(session.accountId, 'work', 'the tab keeps its identity: it is not rebound to the default account');
  } finally { session.destroy(); }
});

test('V05: lost-session recovery goes through the same check, and a registry that throws counts as gone', async () => {
  const reg = registry();
  const { session, queries, sent } = panelSession(reg.deps);
  try {
    session.windowId = 'w-v5b';
    session._handleQuery({ prompt: 'go', accountId: 'work' });
    await until(() => queries[0]?.pushed.length === 1);
    queries[0].emit({ type: 'system', subtype: 'init', session_id: UUID });
    await until(() => session.sessionId === UUID);
    reg.breakIt();
    queries[0].emit({ type: 'result', subtype: 'error_during_execution', errors: ['No conversation found with session ID x'], session_id: UUID });
    await until(() => errors(sent).some(e => e.code === 'account_unavailable'));
    await settle();
    assert.equal(queries.length, 1, 'the fresh conversation did not start under the ambient identity');
    assert.equal(sent.filter(m => m.type === 'done').length, 1);
    // A later message is refused by the query check as well.
    session._handleQuery({ prompt: 'again', accountId: 'work' });
    await settle();
    assert.equal(queries.length, 1);
  } finally { session.destroy(); }
});

test('V05: a rewind on a reaped session does not start a process for a removed account', async () => {
  const reg = registry();
  const { session, queries, sent } = panelSession(reg.deps);
  try {
    session.windowId = 'w-v5c';
    session._handleQuery({ prompt: 'go', accountId: 'work' });
    await until(() => queries[0]?.pushed.length === 1);
    queries[0].emit({ type: 'system', subtype: 'init', session_id: UUID });
    await until(() => session.sessionId === UUID);
    await session._endQuery({ graceful: false });   // what the idle reaper does
    delete reg.accounts.work;
    await session.handleMessage({ type: 'rewind', userMessageUuid: 'u-1' });
    await settle();
    assert.equal(queries.length, 1);
    const r = sent.find(m => m.type === 'rewind_result');
    assert.equal(r.ok, false);
    assert.match(r.error, /no longer set up/);
  } finally { session.destroy(); }
});

test('V03/V05: a session without the panel flag starts, recreates and recovers exactly as before', async () => {
  const reg = registry();
  const { session, queries, sent } = panelSession(reg.deps, {});
  try {
    session._handleQuery({ prompt: 'x', accountId: 'removed-profile' });
    await until(() => queries[0]?.pushed.length === 1);
    queries[0].emit({ type: 'system', subtype: 'init', session_id: UUID });
    await until(() => session.sessionId === UUID);
    reg.breakIt();
    await session._recreateQuery('Please continue.');
    await until(() => queries.length === 2 && queries[1].pushed.length === 1);
    assert.equal('CLAUDE_CONFIG_DIR' in queries[1].options.env, false);
    assert.deepEqual(Object.keys(queries[1].options).sort(), Object.keys(queries[0].options).concat('resume').filter((k, i, a) => a.indexOf(k) === i).sort());
    assert.deepEqual(Object.keys(queries[1].options.env).sort(), Object.keys(queries[0].options.env).sort());
    queries[1].emit({ type: 'result', subtype: 'error_during_execution', errors: ['No conversation found with session ID x'], session_id: UUID });
    await until(() => queries.length === 3 && queries[2].pushed.length === 1);
    assert.equal('resume' in queries[2].options, false, 'the lost session starts fresh, as before');
    assert.equal(errors(sent).length, 0);
    assert.equal(sent.filter(m => m.type === 'done').length, 0);
    assert.equal(session.accountId, undefined);
  } finally { session.destroy(); }
});

// ── V13 ──

async function sessionWithBackgroundWork() {
  const ctx = panelSession();
  const { session, queries } = ctx;
  session.windowId = 'w-v13';
  session._handleQuery({ prompt: 'go' });
  await until(() => queries[0]?.pushed.length === 1);
  queries[0].emit({ type: 'system', subtype: 'init', session_id: UUID });
  queries[0].emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', task_type: 'local_agent', description: 'Explore the repo' }] });
  await queries[0].options.hooks.Stop[0].hooks[0]({ session_crons: [{ id: 'c1', schedule: 'in 20m', recurring: false, prompt: 'check CI' }] });
  queries[0].emit({ type: 'result', subtype: 'success', session_id: UUID, total_cost_usd: 0, usage: {}, result: 'ok' });
  await until(() => session._bgTasks.size === 1 && !session.inTurn);
  return ctx;
}
const responses = (sent) => sent.filter(m => m.type === 'session_response');

test('V13: forgetting the session rules names the background work it would end and waits for a yes', async () => {
  const { session, queries, sent } = await sessionWithBackgroundWork();
  try {
    await session.handleMessage({ type: 'session_request', id: 'r1', what: 'forget_session_rules' });
    await until(() => responses(sent).length === 1);
    const first = responses(sent)[0];
    assert.equal(first.ok, false);
    assert.equal(first.code, 'confirm_required');
    assert.match(first.error, /1 background task/);
    assert.match(first.error, /1 scheduled wake-up/);
    assert.deepEqual(first.data.backgroundTasks, [{ task_id: 't1', task_type: 'local_agent', description: 'Explore the repo' }]);
    assert.deepEqual(first.data.wakeups, [{ id: 'c1', schedule: 'in 20m', recurring: false, prompt: 'check CI' }]);
    assert.equal(session.q, queries[0], 'nothing was ended');
    assert.equal(session._bgTasks.size, 1);

    await session.handleMessage({ type: 'session_request', id: 'r2', what: 'forget_session_rules', args: { confirm: true } });
    await until(() => responses(sent).length === 2);
    const second = responses(sent)[1];
    assert.equal(second.ok, true);
    assert.equal(second.data.restarted, true);
    assert.equal(session.q, null);
  } finally { session.destroy(); }
});

test('V13: with no background work the rules are forgotten at once, as before', async () => {
  const { session, queries, sent } = panelSession();
  try {
    session.windowId = 'w-v13b';
    session._handleQuery({ prompt: 'go' });
    await until(() => queries[0]?.pushed.length === 1);
    queries[0].emit({ type: 'system', subtype: 'init', session_id: UUID });
    queries[0].emit({ type: 'result', subtype: 'success', session_id: UUID, total_cost_usd: 0, usage: {}, result: 'ok' });
    await until(() => !session.inTurn);
    await session.handleMessage({ type: 'session_request', id: 'r1', what: 'forget_session_rules' });
    await until(() => responses(sent).length === 1);
    assert.equal(responses(sent)[0].ok, true);
    assert.equal(responses(sent)[0].data.restarted, true);
    assert.equal(session.q, null);
  } finally { session.destroy(); }
});

test('the host says whether the settings routes take an account', () => {
  configure();
  assert.equal(panelCapabilities().includes('account_settings'), false);
  configure({ accountSettings: true });
  assert.equal(panelCapabilities().includes('account_settings'), true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { CHAT_WAIT_MS, createAssistantApi } from '../lib/assistant-api.js';
import { DispatchError } from '../lib/assistant-dispatch.js';

function fakeDispatcher() {
  const runs = new Map();
  const calls = [];
  return {
    calls,
    limits: { perSession: 6 },
    async dispatch(spec, ctx) {
      calls.push(['dispatch', spec, ctx]);
      if (spec.provider === 'bad') throw new DispatchError('INVALID_PROVIDER', 'bad provider');
      const run = { runId: 'run-1', provider: spec.provider, state: 'starting', assistantSessionId: ctx.assistantSessionId, providerSessionId: null };
      runs.set(run.runId, run);
      return { ok: true, queued: spec.task === 'queue me', run };
    },
    get(runId) { return runs.get(runId) || null; },
    list() { return [...runs.values()]; },
    totals() { return { active: runs.size, queued: 0, costUsd: 0 }; },
    async wait(args) { calls.push(['wait', args]); return { ok: true, timedOut: false, done: [], pending: [] }; },
    transcript(runId, opts) { if (!runs.has(runId)) throw new DispatchError('RUN_NOT_FOUND', 'nope', { status: 404 }); return { runId, format: opts.format }; },
    sendTurn(runId, text, opts) { calls.push(['send', runId, text, opts]); return { ok: true, queued: false }; },
    respondPermission(runId, requestId, body, opts) { calls.push(['permission', runId, requestId, body, opts]); return runs.get(runId); },
    async stop(runId, reason) { calls.push(['stop', runId, reason]); return { ok: true }; },
    complete(runId) { calls.push(['complete', runId]); return { ok: true }; },
    async killAll(args) { calls.push(['killAll', args]); return { ok: true, stopped: [] }; },
    pendingPermissions() { return []; },
    accountInUse() { return false; },
  };
}

async function startApp({ dispatcher, runtime = null, usage = null, claudeAccounts = null, isGuestRequest = () => false, createLoginTerminal = null, clarifier = null, assistantRouter = null } = {}) {
  const app = express();
  app.use(express.json());
  const broadcasts = [];
  app.use('/api/assistant', createAssistantApi({ dispatcher, runtime, usage, claudeAccounts, createLoginTerminal, isGuestRequest, clarifier, assistantRouter, broadcastSync: (m) => broadcasts.push(m), buildCatalog: async () => ({ models: { codex: [{ id: 'gpt-5.4-mini' }] }, projects: [] }) }));
  const server = await new Promise((resolveListen) => { const s = app.listen(0, '127.0.0.1', () => resolveListen(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/assistant`;
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json() };
  };
  return { server, call, broadcasts, close: () => new Promise((r) => server.close(r)) };
}

test('catalog merges builder output with accounts, limits and runs', async (t) => {
  const dispatcher = fakeDispatcher();
  const claudeAccounts = { listForClient: () => [{ id: 'default', label: 'Default', isDefault: true }] };
  const app = await startApp({ dispatcher, claudeAccounts });
  t.after(app.close);
  const { status, json } = await app.call('GET', '/catalog');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.deepEqual(json.models.codex, [{ id: 'gpt-5.4-mini' }]);
  assert.equal(json.accounts['claude-code'][0].id, 'default');
  assert.equal(json.limits.perSession, 6);
});

test('session usage selects current, a task, or all and rejects unknown sessions', async (t) => {
  const calls = [];
  const usage = {
    taskView(id, task) { calls.push(['ledger-task', id, task]); return { sessionId: id, task: { id: task } }; },
    sessionView(id) { calls.push(['ledger-session', id]); return { sessionId: id, tasks: [{ id: 'task-1' }] }; },
  };
  const runtime = {
    getSession: (id) => id === 'assistant-1' ? { id } : null,
    usageView(id, task) { calls.push(['runtime-task', id, task]); return { sessionId: id, task: { id: task, title: 'decorated' }, session: { live: true, fidelity: 'live' } }; },
  };
  const app = await startApp({ dispatcher: fakeDispatcher(), runtime, usage });
  t.after(app.close);
  assert.equal((await app.call('GET', '/sessions/assistant-1/usage')).json.usage.task.id, 'current');
  assert.equal((await app.call('GET', '/sessions/assistant-1/usage?task=task-2')).json.usage.task.title, 'decorated');
  // task=all: the totals are the ledger's; whether work is in progress is the runtime's to say (the same headline as the packet).
  assert.deepEqual((await app.call('GET', '/sessions/assistant-1/usage?task=all')).json.session, { sessionId: 'assistant-1', tasks: [{ id: 'task-1' }], live: true, fidelity: 'live' });
  assert.equal((await app.call('GET', '/sessions/missing/usage')).status, 404);
  assert.deepEqual(calls, [
    ['runtime-task', 'assistant-1', 'current'], ['runtime-task', 'assistant-1', 'task-2'], ['ledger-session', 'assistant-1'], ['runtime-task', 'assistant-1', 'current'],
  ]);
  delete runtime.usageView;
  assert.equal((await app.call('GET', '/sessions/assistant-1/usage?task=task-3')).json.usage.task.id, 'task-3');
  assert.deepEqual(calls.at(-1), ['ledger-task', 'assistant-1', 'task-3']);
});

test('session usage without a ledger answers an explicit null; task=all with run adds that run in the same call', async (t) => {
  const runtime = { getSession: (id) => id === 'assistant-1' ? { id } : null };
  const bare = await startApp({ dispatcher: fakeDispatcher(), runtime });
  t.after(bare.close);
  // A missing key reads as a dropped body: the caller must see "no metering" spelled out.
  assert.deepEqual((await bare.call('GET', '/sessions/assistant-1/usage')).json, { ok: true, usage: null });
  assert.deepEqual((await bare.call('GET', '/sessions/assistant-1/usage?task=task-1')).json, { ok: true, usage: null });
  assert.deepEqual((await bare.call('GET', '/sessions/assistant-1/usage?task=all')).json, { ok: true, session: null });
  assert.deepEqual((await bare.call('GET', '/sessions/assistant-1/usage?task=all&run=run-1')).json, { ok: true, session: null, run: null });

  const calls = [];
  const usage = {
    sessionView(id) { calls.push(['session', id]); return { sessionId: id, unsynced: 0, tasks: [{ id: 'task-1' }, { id: 'task-2' }] }; },
    taskView(id, task) { calls.push(['task', id, task]); return { sessionId: id, task: { id: task } }; },
    runView(id, runId) { calls.push(['run', id, runId]); return runId === 'run-1' ? { tokens: { total: 9 }, fidelity: 'exact', taskIds: ['task-2'] } : null; },
  };
  const app = await startApp({ dispatcher: fakeDispatcher(), runtime, usage });
  t.after(app.close);
  const answer = (await app.call('GET', '/sessions/assistant-1/usage?task=all&run=run-1')).json;
  assert.deepEqual(answer.run, { tokens: { total: 9 }, fidelity: 'exact', taskIds: ['task-2'] });
  assert.equal(answer.session.tasks.length, 2);
  assert.deepEqual(calls, [['session', 'assistant-1'], ['run', 'assistant-1', 'run-1']], 'one request, no view per task');
  assert.equal((await app.call('GET', '/sessions/assistant-1/usage?task=all&run=run-gone')).json.run, null);
  assert.equal('run' in (await app.call('GET', '/sessions/assistant-1/usage?task=all')).json, false);
});

test('dispatch maps snake_case bodies, resolves the caller, and returns 202 when queued', async (t) => {
  const dispatcher = fakeDispatcher();
  const runtime = { resolveTerminal: (pin) => (pin === 'assistant-abc' ? 'assistant-abc' : null), listSessions: () => [], noteDispatch() {} };
  const app = await startApp({ dispatcher, runtime });
  t.after(app.close);
  const ok = await app.call('POST', '/dispatch', { provider: 'codex', task: 'do it', cwd: '/tmp', permission_policy: 'restricted', max_minutes: 5, account_id: 'work' }, { 'X-Synabun-Terminal': 'assistant-abc' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.run.runId, 'run-1');
  const [, spec, ctx] = dispatcher.calls.find((c) => c[0] === 'dispatch');
  assert.equal(spec.permissionPolicy, 'restricted');
  assert.equal(spec.maxMinutes, 5);
  assert.equal(spec.accountId, 'work');
  assert.equal(ctx.assistantSessionId, 'assistant-abc');
  assert.equal(ctx.origin, 'assistant');
  const queued = await app.call('POST', '/dispatch', { provider: 'codex', task: 'queue me', cwd: '/tmp', assistantSessionId: 'assistant-ui' });
  assert.equal(queued.status, 202);
  const bad = await app.call('POST', '/dispatch', { provider: 'bad', task: 'x' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'INVALID_PROVIDER');
});

test('worker pins cannot orchestrate; guests are rejected everywhere', async (t) => {
  const dispatcher = fakeDispatcher();
  const app = await startApp({ dispatcher, isGuestRequest: (req) => req.headers['x-guest'] === '1' });
  t.after(app.close);
  await app.call('POST', '/dispatch', { provider: 'codex', task: 'seed', cwd: '/tmp' });
  const forbidden = await app.call('POST', '/dispatch', { provider: 'codex', task: 'again', cwd: '/tmp' }, { 'X-Synabun-Terminal': 'run-1' });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.json.code, 'AGENTS_NOT_PERMITTED');
  const guest = await app.call('GET', '/runs', null, { 'x-guest': '1' });
  assert.equal(guest.status, 403);
});

test('run routes delegate to the dispatcher and surface typed errors', async (t) => {
  const dispatcher = fakeDispatcher();
  const app = await startApp({ dispatcher });
  t.after(app.close);
  await app.call('POST', '/dispatch', { provider: 'codex', task: 'seed', cwd: '/tmp' });
  assert.equal((await app.call('GET', '/runs/run-1')).json.run.runId, 'run-1');
  assert.equal((await app.call('GET', '/runs/missing')).status, 404);
  assert.equal((await app.call('GET', '/runs/run-1/transcript?format=text')).json.format, 'text');
  assert.equal((await app.call('GET', '/runs/missing/result')).status, 404);
  const sent = await app.call('POST', '/runs/run-1/send', { text: 'more', origin: 'user' });
  assert.equal(sent.status, 200);
  assert.deepEqual(dispatcher.calls.find((c) => c[0] === 'send').slice(1), ['run-1', 'more', { origin: 'user', queue: true }]);
  const noRequest = await app.call('POST', '/runs/run-1/permission', { behavior: 'allow' });
  assert.equal(noRequest.status, 400);
  const perm = await app.call('POST', '/runs/run-1/permission', { request_id: 'perm-1', behavior: 'allow' });
  assert.equal(perm.status, 200);
  assert.equal(dispatcher.calls.find((c) => c[0] === 'permission')[4].origin, 'user');
  await app.call('POST', '/runs/run-1/stop', {});
  assert.equal(dispatcher.calls.find((c) => c[0] === 'stop')[2], 'user');
  const focus = await app.call('POST', '/runs/run-1/focus', {});
  assert.equal(focus.json.focused, true);
  assert.ok(app.broadcasts.some((m) => m.type === 'assistant:focus' && m.runId === 'run-1'));
  const waited = await app.call('POST', '/wait', { run_ids: ['run-1'], timeout_seconds: 2 });
  assert.equal(waited.json.ok, true);
  assert.equal(dispatcher.calls.find((c) => c[0] === 'wait')[1].timeoutMs, 2000);
  await app.call('POST', '/kill-all', { assistant_session_id: 's1' });
  assert.equal(dispatcher.calls.find((c) => c[0] === 'killAll')[1].assistantSessionId, 's1');
});

test('finished-run removal endpoints require the UI and enforce scope and active-run errors', async () => {
  const dispatcher = fakeDispatcher();
  dispatcher.remove = (runId, options) => {
    dispatcher.calls.push(['remove', runId, options]);
    if (runId === 'active') throw new DispatchError('RUN_ACTIVE', 'stop it first', { status: 409 });
    return { ok: true, removed: [runId] };
  };
  dispatcher.removeFinished = (options) => {
    dispatcher.calls.push(['removeFinished', options]);
    return { ok: true, removed: ['finished'], skipped: ['active'] };
  };
  await dispatcher.dispatch({ provider: 'codex', task: 'seed', cwd: '/tmp' }, { assistantSessionId: 'assistant-abc' });
  const router = createAssistantApi({ dispatcher });
  const invoke = async (method, path, { runId = 'finished', body = {}, query = {}, pin = '' } = {}) => {
    const layer = router.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} is registered`);
    const req = { params: { runId }, body, query, get: (name) => name.toLowerCase() === 'x-synabun-terminal' ? pin : '' };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(json) { this.body = json; return this; } };
    await layer.route.stack[0].handle(req, res);
    return { status: res.statusCode, json: res.body };
  };
  const oneRoute = '/runs/:runId';
  const allRoute = '/runs/clear-finished';
  assert.equal((await invoke('delete', oneRoute, { pin: 'assistant-abc' })).json.code, 'UI_ONLY');
  assert.equal((await invoke('post', allRoute, { body: { assistantSessionId: 'assistant-abc' }, pin: 'assistant-abc' })).status, 403);
  assert.equal((await invoke('delete', oneRoute, { pin: 'run-1' })).status, 403);
  assert.equal((await invoke('post', allRoute)).json.code, 'SCOPE_REQUIRED');
  assert.equal((await invoke('delete', oneRoute, { runId: 'active', query: { assistantSessionId: 'assistant-abc' } })).status, 409);

  const one = await invoke('delete', oneRoute, { query: { assistantSessionId: 'assistant-abc' } });
  assert.equal(one.status, 200);
  assert.deepEqual(one.json.removed, ['finished']);
  assert.deepEqual(dispatcher.calls.find((call) => call[0] === 'remove' && call[1] === 'finished')[2], { assistantSessionId: 'assistant-abc' });
  const all = await invoke('post', allRoute, { body: { assistant_session_id: 'assistant-abc' } });
  assert.equal(all.status, 200);
  assert.deepEqual(all.json, { ok: true, removed: ['finished'], skipped: ['active'] });
  assert.deepEqual(dispatcher.calls.find((call) => call[0] === 'removeFinished')[1], { assistantSessionId: 'assistant-abc', workflowId: null, runIds: null });
});

test('sessions require the runtime and accounts drive the login terminal', async (t) => {
  const dispatcher = fakeDispatcher();
  const sessions = new Map();
  const runtime = {
    resolveTerminal: () => null,
    listSessions: () => [...sessions.values()],
    async createSession(spec) { const s = { id: 'assistant-1', brain: spec.brain || {}, title: spec.label || 'Assistant 1' }; sessions.set(s.id, s); return s; },
    getSession: (id) => (sessions.has(id) ? { ...sessions.get(id), transcript: [] } : null),
    async updateSession(id, patch) { if (!sessions.has(id)) return null; Object.assign(sessions.get(id), patch); return sessions.get(id); },
    async closeSession(id) { return sessions.get(id); },
    async destroySession(id) { return sessions.delete(id); },
    accountInUse: () => false,
  };
  const logins = [];
  const watchers = [];
  const claudeAccounts = {
    listForClient: () => [{ id: 'default', isDefault: true }, { id: 'cacct-1', label: 'Work', isDefault: false }],
    create: ({ label }) => ({ id: 'cacct-1', label, home: '/tmp/cacct-1' }),
    get: (id) => (id === 'cacct-1' ? { id } : id === 'default' ? { id } : null),
    loginCommand: () => ({ env: { CLAUDE_CONFIG_DIR: '/tmp/cacct-1' }, cwd: '/tmp/cacct-1', command: 'claude' }),
    watchLogin: (id, opts) => { watchers.push([id, opts]); return () => {}; },
    rename: (id, label) => ({ id, label }),
    remove: (id, { inUse }) => { const reason = inUse(id); if (reason) throw Object.assign(new Error(reason), { code: 'ACCOUNT_IN_USE', status: 409 }); return { ok: true, removed: id }; },
  };
  const noRuntime = await startApp({ dispatcher });
  t.after(noRuntime.close);
  assert.equal((await noRuntime.call('GET', '/sessions')).status, 503);
  const app = await startApp({ dispatcher, runtime, claudeAccounts, createLoginTerminal: async (args) => { logins.push(args); return { terminalSessionId: 'term-9', profile: 'claude-code' }; } });
  t.after(app.close);
  const created = await app.call('POST', '/sessions', { brain: { provider: 'codex' }, label: 'Ops' });
  assert.equal(created.status, 201);
  assert.equal(created.json.session.id, 'assistant-1');
  assert.equal((await app.call('GET', '/sessions/assistant-1')).json.session.title, 'Ops');
  assert.equal((await app.call('GET', '/sessions/nope')).status, 404);
  const account = await app.call('POST', '/claude/accounts', { label: 'Work' });
  assert.equal(account.status, 201);
  assert.equal(account.json.login.terminalSessionId, 'term-9');
  assert.deepEqual(logins[0].env, { CLAUDE_CONFIG_DIR: '/tmp/cacct-1' });
  assert.equal(watchers[0][0], 'cacct-1');
  watchers[0][1].onLogin({ email: 'w@example.com' });
  assert.ok(app.broadcasts.some((m) => m.type === 'assistant:accounts-changed' && m.provider === 'claude-code'));
  const removed = await app.call('DELETE', '/claude/accounts/cacct-1');
  assert.equal(removed.status, 200);
  assert.equal((await app.call('POST', '/ui/tabs', { windowId: 'w1', panels: { codex: [{ tabId: 't1' }] } })).json.ok, true);
  const tabs = await app.call('GET', '/ui/tabs');
  assert.equal(tabs.json.windows[0].windowId, 'w1');
});

function deliveringDispatcher() {
  const base = fakeDispatcher();
  const marks = [];
  const big = 'x'.repeat(5000);
  const run = {
    runId: 'run-7', provider: 'codex', state: 'idle', assistantSessionId: 'assistant-abc', resultTurn: 2, lastText: big,
    lastResult: { found: true, status: 'done', summary: 'did it', files: ['a.js'], raw: big },
    turns: [
      { n: 1, origin: 'dispatch', text: big, result: { status: 'blocked', summary: 's'.repeat(900), raw: big }, costUsd: 0.01 },
      { n: 2, origin: 'assistant', text: big, result: { status: 'done', summary: 'did it', raw: big }, costUsd: 0.01 },
    ],
  };
  return {
    ...base, marks, run,
    get: (runId) => (runId === run.runId ? run : base.get(runId)),
    transcript: (runId, opts) => (runId === run.runId ? { runId, format: opts.format, result: opts.format === 'result' ? run.lastResult : undefined, text: opts.format === 'text' ? big : undefined } : base.transcript(runId, opts)),
    async wait(args) { base.calls.push(['wait', args]); return { ok: true, timedOut: false, done: [run], pending: [] }; },
    markDelivered(runId, mark) { marks.push({ runId, ...mark }); return true; },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

test('brain reads mark the run delivered (result, text, waits, status) and get slim views', async (t) => {
  const dispatcher = deliveringDispatcher();
  const runtime = { resolveTerminal: (pin) => (pin === 'assistant-abc' ? 'assistant-abc' : null), listSessions: () => [], noteDispatch() {} };
  const app = await startApp({ dispatcher, runtime });
  t.after(app.close);
  const brain = { 'X-Synabun-Terminal': 'assistant-abc', 'X-Synabun-Role': 'assistant' };
  const status = await app.call('GET', '/runs/run-7', null, brain);
  const view = status.json.run;
  assert.equal(view.lastText, undefined, 'no full text in a brain view');
  assert.equal(view.lastResult.raw, undefined);
  assert.equal(view.lastResult.summary, 'did it');
  assert.deepEqual(view.turns.map((turn) => [turn.n, turn.status, turn.text, turn.result]), [[1, 'blocked', undefined, undefined], [2, 'done', undefined, undefined]]);
  assert.ok(view.turns[0].summary.length <= 300);
  assert.ok(JSON.stringify(view).length < 2500, `slim view is small (${JSON.stringify(view).length})`);
  await settle();
  assert.deepEqual(dispatcher.marks.at(-1), { runId: 'run-7', turn: 2, state: 'idle', via: 'agent_status', assistantSessionId: 'assistant-abc' });
  await app.call('GET', '/runs/run-7/result', null, brain);
  await settle();
  assert.equal(dispatcher.marks.at(-1).via, 'agent_read');
  const tail = dispatcher.marks.length;
  await app.call('GET', '/runs/run-7/transcript?format=tail', null, brain);
  await settle();
  assert.equal(dispatcher.marks.length, tail, 'a tail of events is not a read of the result');
  const text = await app.call('GET', '/runs/run-7/transcript?format=text', null, brain);
  assert.equal(text.json.text.length, 5000, 'agent_read format:"text" still returns the full text');
  await settle();
  assert.equal(dispatcher.marks.length, tail + 1);
  const waited = await app.call('GET', '/runs/run-7/wait?timeout=1000', null, brain);
  assert.equal(waited.json.done[0].lastText, undefined);
  await settle();
  assert.equal(dispatcher.marks.at(-1).via, 'agent_wait');
  const many = await app.call('POST', '/wait', { run_ids: ['run-7'] }, brain);
  assert.equal(many.json.done[0].lastResult.raw, undefined);
  await settle();
  assert.equal(dispatcher.marks.length, tail + 3);
  // The Codex brain's MCP child pins codex-sp-<uuid> (no session resolves it) but sends the role.
  await app.call('GET', '/runs/run-7', null, { 'X-Synabun-Terminal': 'codex-sp-1234', 'X-Synabun-Role': 'assistant' });
  await settle();
  assert.equal(dispatcher.marks.length, tail + 4);
  assert.equal(dispatcher.marks.at(-1).assistantSessionId, null);
});

test('the UI, workers and unknown pins never mark a delivery and keep full views', async (t) => {
  const dispatcher = deliveringDispatcher();
  const runtime = { resolveTerminal: () => null, listSessions: () => [], noteDispatch() {} };
  const app = await startApp({ dispatcher, runtime });
  t.after(app.close);
  const ui = await app.call('GET', '/runs/run-7');
  assert.equal(ui.json.run.lastText.length, 5000, 'the UI keeps the full view');
  await app.call('GET', '/runs/run-7/result');
  await app.call('POST', '/wait', { run_ids: ['run-7'] });
  await app.call('GET', '/runs/run-7', null, { 'X-Synabun-Terminal': 'codex-sp-1234' });
  await dispatcher.dispatch({ provider: 'codex', task: 'seed', cwd: '/tmp' }, { assistantSessionId: null });
  const worker = await app.call('GET', '/runs/run-7', null, { 'X-Synabun-Terminal': 'run-1', 'X-Synabun-Role': 'assistant' });
  assert.equal(worker.status, 200);
  assert.equal(worker.json.run.lastText.length, 5000, 'a worker pin is not a brain, whatever role it claims');
  await app.call('GET', '/runs/run-7/result', null, { 'X-Synabun-Terminal': 'run-1' });
  assert.equal((await app.call('POST', '/wait', { run_ids: ['run-7'] }, { 'X-Synabun-Terminal': 'run-1' })).status, 403);
  await settle();
  assert.deepEqual(dispatcher.marks, []);
});

test('a dispatcher without markDelivered still serves brain reads', async (t) => {
  const dispatcher = fakeDispatcher();
  const runtime = { resolveTerminal: (pin) => (pin === 'assistant-abc' ? 'assistant-abc' : null), listSessions: () => [], noteDispatch() {} };
  const app = await startApp({ dispatcher, runtime });
  t.after(app.close);
  await app.call('POST', '/dispatch', { provider: 'codex', task: 'seed', cwd: '/tmp' });
  const brain = { 'X-Synabun-Terminal': 'assistant-abc' };
  assert.equal((await app.call('GET', '/runs/run-1', null, brain)).json.run.runId, 'run-1');
  assert.equal((await app.call('GET', '/runs/run-1/wait?timeout=1000', null, brain)).json.ok, true);
  assert.equal((await app.call('POST', '/wait', { run_ids: ['run-1'] }, brain)).json.ok, true);
});

// ── remote sessions (WhatsApp Link) ──────────────────────────────────────────
test('permission answers: a brain cannot answer a strict WhatsApp session\'s workers; only the UI names an origin', async (t) => {
  const dispatcher = fakeDispatcher();
  await dispatcher.dispatch({ provider: 'claude-code', task: 'x' }, { assistantSessionId: 'assistant-wa' });
  const policies = new Map([['assistant-wa', { level: 'ask', strictWorkerApprovals: true }]]);
  const runtime = { resolveTerminal: (pin) => (pin === 'assistant-wa' || pin === 'assistant-desk' ? pin : null), listSessions: () => [], isPlanning: () => false, sessionPolicy: (id) => policies.get(id) || null };
  const app = await startApp({ dispatcher, runtime });
  t.after(app.close);
  const brain = { 'X-Synabun-Terminal': 'assistant-wa' };
  const refused = await app.call('POST', '/runs/run-1/permission', { request_id: 'perm-1', behavior: 'allow' }, brain);
  assert.equal(refused.status, 403);
  assert.equal(refused.json.code, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(dispatcher.calls.filter((c) => c[0] === 'permission').length, 0);
  const ui = await app.call('POST', '/runs/run-1/permission', { request_id: 'perm-1', behavior: 'allow', origin: 'whatsapp' });
  assert.equal(ui.status, 200, 'the user answers from the panel (or the phone through the runtime)');
  assert.equal(dispatcher.calls.filter((c) => c[0] === 'permission').at(-1)[4].origin, 'whatsapp', 'the UI may name its origin');
  // Autonomous (or no strict approvals): the brain may answer, and never as someone else.
  policies.set('assistant-wa', { level: 'autonomous', autonomousUntil: Date.now() + 60_000, strictWorkerApprovals: true });
  const byBrain = await app.call('POST', '/runs/run-1/permission', { request_id: 'perm-2', behavior: 'allow', origin: 'user' }, brain);
  assert.equal(byBrain.status, 200);
  assert.equal(dispatcher.calls.filter((c) => c[0] === 'permission').at(-1)[4].origin, 'assistant', 'body.origin is ignored for a brain');
});

test('permission answers: a brain answers its own session\'s workers only (RUN_NOT_IN_SESSION for another session\'s run, allow and deny alike); the UI is unchanged', async (t) => {
  const dispatcher = fakeDispatcher();
  await dispatcher.dispatch({ provider: 'claude-code', task: 'x' }, { assistantSessionId: 'assistant-wa' });
  // WhatsApp's default: strict worker approvals off.
  const policies = new Map([['assistant-wa', { level: 'ask', strictWorkerApprovals: false }]]);
  const runtime = { resolveTerminal: (pin) => (pin === 'assistant-wa' || pin === 'assistant-desk' ? pin : null), listSessions: () => [], isPlanning: () => false, sessionPolicy: (id) => policies.get(id) || null };
  const app = await startApp({ dispatcher, runtime });
  t.after(app.close);
  const answers = () => dispatcher.calls.filter((c) => c[0] === 'permission');
  // The brain of ANOTHER session (its pin resolves to assistant-desk): refused, whatever it answers.
  const other = { 'X-Synabun-Terminal': 'assistant-desk' };
  for (const behavior of ['allow', 'deny']) {
    const refused = await app.call('POST', '/runs/run-1/permission', { request_id: 'perm-1', behavior }, other);
    assert.deepEqual([refused.status, refused.json.code], [403, 'RUN_NOT_IN_SESSION'], behavior);
    assert.match(refused.json.error, /belongs to another assistant session/);
  }
  // A brain whose pin resolves to no session (Codex's MCP child) and that declares another session: refused too.
  const codex = { 'X-Synabun-Terminal': 'codex-sp-1234', 'X-Synabun-Role': 'assistant' };
  const declared = await app.call('POST', '/runs/run-1/permission', { request_id: 'perm-1', behavior: 'allow', assistant_session_id: 'assistant-desk' }, codex);
  assert.deepEqual([declared.status, declared.json.code], [403, 'RUN_NOT_IN_SESSION']);
  assert.equal(answers().length, 0, 'nothing reached the worker');
  // The run's own brain still answers (strict off: unchanged), as "assistant".
  const own = await app.call('POST', '/runs/run-1/permission', { request_id: 'perm-1', behavior: 'allow' }, { 'X-Synabun-Terminal': 'assistant-wa' });
  assert.equal(own.status, 200);
  assert.deepEqual([answers().at(-1)[1], answers().at(-1)[4].origin], ['run-1', 'assistant']);
  // The UI (a person, no pin) answers any run, exactly as before.
  const ui = await app.call('POST', '/runs/run-1/permission', { request_id: 'perm-2', behavior: 'deny' });
  assert.equal(ui.status, 200);
  assert.equal(answers().at(-1)[4].origin, 'user');
  // A brain caller the API cannot place (no session behind its pin, none declared) is left as it was.
  const unplaced = await app.call('POST', '/runs/run-1/permission', { request_id: 'perm-3', behavior: 'deny' }, codex);
  assert.equal(unplaced.status, 200, 'unchanged: the API cannot tell which session this caller belongs to');
  // A missing request id is still the first refusal.
  assert.equal((await app.call('POST', '/runs/run-1/permission', { behavior: 'allow' }, other)).json.code, 'REQUEST_ID_REQUIRED');
});

test('the REST card answers never hand "superseded" on: the router and the clarifier get the answer without the key', async (t) => {
  // "superseded" (a silent cancel: the user wrote something else) is the WhatsApp bridge's alone.
  // The answer parsers ignore the key today; this pins that the REST layer drops it before them.
  const got = [];
  const assistantRouter = { answer: async (id, response, opts) => { got.push(['route', id, response, opts.origin]); return { ok: true, status: response.decline ? 'declined' : 'approved' }; } };
  const clarifier = { answer: (id, response, opts) => { got.push(['clarify', id, response, opts.origin]); return { ok: true, status: 'declined' }; } };
  const app = await startApp({ dispatcher: fakeDispatcher(), assistantRouter, clarifier });
  t.after(app.close);
  assert.equal((await app.call('POST', '/routes/route-1/answer', { response: { decline: true, superseded: true } })).status, 200);
  assert.equal((await app.call('POST', '/routes/route-2/answer', { optionId: 's1', remember: false, superseded: true })).status, 200);
  assert.equal((await app.call('POST', '/clarify/clarify-1/answer', { response: { behavior: 'deny', message: 'later', superseded: true } })).status, 200);
  assert.equal((await app.call('POST', '/clarify/clarify-2/answer', { behavior: 'allow', answers: [['Whole app']], superseded: true })).status, 200);
  assert.deepEqual(got, [
    ['route', 'route-1', { decline: true }, 'rest'],
    ['route', 'route-2', { optionId: 's1', remember: false }, 'rest'],
    ['clarify', 'clarify-1', { behavior: 'deny', message: 'later' }, 'rest'],
    ['clarify', 'clarify-2', { behavior: 'allow', answers: [['Whole app']] }, 'rest'],
  ]);
  // Agents still cannot answer these cards at all.
  const brain = { 'X-Synabun-Terminal': 'assistant-abc' };
  assert.equal((await app.call('POST', '/routes/route-3/answer', { decline: true, superseded: true }, brain)).json.code, 'UI_ONLY');
  assert.equal((await app.call('POST', '/clarify/clarify-3/answer', { behavior: 'deny', superseded: true }, brain)).json.code, 'UI_ONLY');
  assert.equal(got.length, 4);
});

test('POST /sessions cannot make a remote session: the body goes to createSession alone', async (t) => {
  const created = [];
  const runtime = { listSessions: () => [], createSession: async (...args) => { created.push(args); return { id: 'assistant-new' }; } };
  const app = await startApp({ dispatcher: fakeDispatcher(), runtime });
  t.after(app.close);
  const res = await app.call('POST', '/sessions', { brain: { provider: 'codex' }, channel: 'whatsapp', remote: { level: 'autonomous' } });
  assert.equal(res.status, 201);
  assert.equal(created[0].length, 1, 'no internal second argument from REST');
});

// ── A WhatsApp conversation never sits in agent_wait (docs/whatsapp.md → "Chat while work runs") ──

function channelRuntime() {
  return {
    resolveTerminal: (pin) => (['assistant-wa', 'assistant-desk'].includes(pin) ? pin : null), listSessions: () => [], noteDispatch() {},
    // The session the phone talks to; the other one is a desktop panel session.
    sessionChannel: (id) => (id === 'assistant-wa' ? 'whatsapp' : null),
  };
}

test('agent_wait for a WhatsApp conversation returns at once and says what to do instead; desktop sessions and the UI wait as asked', async (t) => {
  const dispatcher = fakeDispatcher();
  const runs = { 'run-wa': { runId: 'run-wa', assistantSessionId: 'assistant-wa', state: 'running' }, 'run-desk': { runId: 'run-desk', assistantSessionId: 'assistant-desk', state: 'running' } };
  dispatcher.get = (id) => runs[id] || null;
  dispatcher.list = ({ workflowId } = {}) => (workflowId === 'wf-wa' ? [runs['run-wa']] : []);
  // A wait that really blocks for its timeout (the run never finishes), like the dispatcher's.
  dispatcher.wait = async (args) => {
    dispatcher.calls.push(['wait', args]);
    await new Promise((r) => setTimeout(r, Math.min(Number(args.timeoutMs) || 0, 5000)));
    const ids = args.runIds || (args.runId ? [args.runId] : ['run-wa']);
    return { ok: true, timedOut: true, done: [], pending: ids.map((id) => runs[id]) };
  };
  const app = await startApp({ dispatcher, runtime: channelRuntime() });
  t.after(app.close);
  const wa = { 'X-Synabun-Terminal': 'assistant-wa', 'X-Synabun-Role': 'assistant' };
  const desk = { 'X-Synabun-Terminal': 'assistant-desk', 'X-Synabun-Role': 'assistant' };
  const lastTimeout = () => dispatcher.calls.filter((c) => c[0] === 'wait').at(-1)[1].timeoutMs;

  // The brain asks to wait almost two minutes: the WhatsApp wait is over in about a second.
  let started = Date.now();
  const waited = await app.call('POST', '/wait', { run_ids: ['run-wa'], timeout_seconds: 110 }, wa);
  assert.ok(Date.now() - started < 2500, `did not block (${Date.now() - started} ms)`);
  assert.equal(lastTimeout(), CHAT_WAIT_MS);
  assert.equal(waited.status, 200);
  assert.equal(waited.json.channel, 'whatsapp');
  assert.match(waited.json.next, /End your turn now/);
  assert.match(waited.json.next, /\[SynaBun Mailbox\] event/);
  assert.match(waited.json.next, /Do not call agent_wait again/);
  assert.deepEqual(waited.json.pending.map((run) => run.runId), ['run-wa'], 'still says what is running');
  // The single-run route, a workflow barrier, and a Codex brain (no session pin: the run names its session).
  const single = await app.call('GET', '/runs/run-wa/wait?timeout=120000', null, wa);
  assert.equal(lastTimeout(), CHAT_WAIT_MS);
  assert.match(single.json.next, /End your turn now/);
  await app.call('POST', '/wait', { workflow_id: 'wf-wa', timeout_seconds: 60 }, { 'X-Synabun-Terminal': 'codex-sp-1', 'X-Synabun-Role': 'assistant' });
  assert.equal(lastTimeout(), CHAT_WAIT_MS, 'a Codex brain of a WhatsApp session too');
  // Runs that are finished already come back as they are: nothing to add.
  const done = { ...runs['run-wa'], state: 'idle', lastResult: { status: 'done', summary: 'ok' } };
  const blocking = dispatcher.wait;
  dispatcher.wait = async (args) => { dispatcher.calls.push(['wait', args]); return { ok: true, timedOut: false, done: [done], pending: [] }; };
  const finished = await app.call('POST', '/wait', { run_ids: ['run-wa'] }, wa);
  assert.equal(finished.json.next, undefined);
  assert.equal(finished.json.done[0].lastResult.summary, 'ok');
  dispatcher.wait = blocking;

  // A desktop session: the wait blocks for what it asked, and nothing is added.
  started = Date.now();
  const desktop = await app.call('POST', '/wait', { run_ids: ['run-desk'], timeout_seconds: 1.5 }, desk);
  assert.ok(Date.now() - started >= 1400, `waited as asked (${Date.now() - started} ms)`);
  assert.equal(lastTimeout(), 1500);
  assert.equal(desktop.json.next, undefined);
  assert.equal(desktop.json.channel, undefined);
  await app.call('GET', '/runs/run-desk/wait?timeout=1200', null, desk);
  assert.equal(lastTimeout(), 1200);
  // The UI (no pin) waiting on a WhatsApp session's run: unchanged too.
  const ui = await app.call('POST', '/wait', { run_ids: ['run-wa'], timeout_seconds: 1.2 });
  assert.equal(lastTimeout(), 1200);
  assert.equal(ui.json.next, undefined);
});

test('agent_clarify on a WhatsApp conversation raises no card: the brain is told to ask in plain text; desktop sessions get the card', async (t) => {
  const asked = [];
  const clarifier = { ask: async (args) => { asked.push(args); return { ok: true, status: 'answered', briefId: 'brief-1', next: 'route' }; } };
  const app = await startApp({ dispatcher: fakeDispatcher(), runtime: channelRuntime(), clarifier });
  t.after(app.close);
  const body = { summary: 'Build the API', questions: [{ question: 'Which database?', options: ['Postgres', 'SQLite'] }] };
  const wa = await app.call('POST', '/clarify', body, { 'X-Synabun-Terminal': 'assistant-wa', 'X-Synabun-Role': 'assistant' });
  assert.equal(wa.status, 200);
  assert.deepEqual([wa.json.ok, wa.json.status, wa.json.code], [false, 'text_only', 'CLARIFY_TEXT_ONLY']);
  assert.match(wa.json.next, /plain text, not on a card: nothing was shown to the user/);
  assert.match(wa.json.next, /end your turn/);
  assert.equal(asked.length, 0, 'no clarify round was opened, so nothing can be left pending');
  const desk = await app.call('POST', '/clarify', body, { 'X-Synabun-Terminal': 'assistant-desk', 'X-Synabun-Role': 'assistant' });
  assert.equal(desk.json.status, 'answered');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].sessionId, 'assistant-desk');
});

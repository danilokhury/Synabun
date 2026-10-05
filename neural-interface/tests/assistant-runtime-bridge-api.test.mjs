import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import express from 'express';
import { createAssistantRuntime } from '../lib/assistant-runtime.js';
import { createAssistantApi } from '../lib/assistant-api.js';
import * as remotePolicyModule from '../lib/remote-policy.js';
import { createRemotePolicyRegistry } from '../lib/remote-policy.js';
import { createAssistantRouter } from '../lib/assistant-router.js';
import { createAssistantClarifier } from '../lib/assistant-clarify.js';
import { createAssistantCatalog } from '../lib/assistant-catalog.js';
import { effectiveRouting } from '../lib/assistant-config.js';
import { PRICING, fakeFetch } from './assistant-catalog.fixtures.mjs';

process.env.SYNABUN_TYPESAFE = 'off';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 2000, step = 5 } = {}) {
  const start = Date.now();
  for (;;) { const value = fn(); if (value) return value; if (Date.now() - start > timeout) throw new Error('waitFor timed out'); await wait(step); }
}

/** A brain that answers each turn after `delayMs`; `hold` keeps it busy until release(). */
function fakeBrainFactory(log, { delayMs = 10, failStart = false } = {}) {
  return ({ session, sink, deps, hooks }) => {
    let busy = false;
    log.push(['create', session.brain.provider, { remoteLevel: deps.remoteLevel ?? null, hooks, permissionMode: session.brain.permissionMode, planMode: session.brain.planMode === true, desktopGrant: deps.desktopGrant || null }]);
    return {
      kind: session.brain.provider,
      async start() { if (failStart) { const error = new Error('no CLI'); error.code = 'CLI_MISSING'; throw error; } },
      async sendUserTurn({ text, permissionMode, planMode }) {
        log.push(['turn', text, { permissionMode, planMode }]);
        busy = true;
        setTimeout(() => {
          sink.send({ type: 'event', event: { type: 'assistant', uuid: `u-${Math.random()}`, message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${text.slice(0, 40)}` }] } } });
          sink.send({ type: 'event', event: { type: 'result', subtype: 'success', result: `echo: ${text.slice(0, 40)}` } });
          busy = false;
          sink.send({ type: 'done', code: 0 });
        }, delayMs);
      },
      async abort() { log.push(['abort']); busy = false; sink.send({ type: 'aborted' }); },
      async setPermissionMode(mode, opts) { log.push(['mode', mode, opts?.planMode === true]); },
      respondControl(id, response) { log.push(['brain-control', id, response]); },
      isBusy: () => busy,
      identity: () => ({}),
      async dispose() { log.push(['dispose']); },
    };
  };
}

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
  packets(type) { return this.sent.filter((p) => p.type === type); }
}
const send = (ws, message) => ws.emit('message', Buffer.from(JSON.stringify(message)));

// The phone's authority (lib/remote-policy.js createPhoneAuthority): the runtime gets the verifier, a test plays the bridge with authority.issue().
const newAuthority = () => (typeof remotePolicyModule.createPhoneAuthority === 'function' ? remotePolicyModule.createPhoneAuthority() : { issue: () => Symbol('none'), revoke() {}, verify: () => false });
function harness(t, { dispatcher = null, router = null, clarifier = null, desktop = null, memory = null, config = {}, delayMs = 10, failStart = false, registry = createRemotePolicyRegistry(), root = null, projects = ['/tmp'], brain = null, authority = newAuthority() } = {}) {
  const dir = root || mkdtempSync(resolve(tmpdir(), 'synabun-bridge-api-'));
  if (!root) t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = [];
  // `brain`: a factory of the test's own (log) → factory; else one that answers each turn after delayMs.
  const factory = brain ? brain(log) : fakeBrainFactory(log, { delayMs, failStart });
  const runtime = createAssistantRuntime({
    dispatcher, router, clarifier, desktop, memory, dataDir: dir, detectProject: () => 'proj',
    buildCatalog: async () => ({ models: {} }),
    brainFactories: { 'claude-code': factory, codex: factory, opencode: factory }, config: { mailboxBatchMs: 20, ...config },
    remotePolicy: registry, registeredProjects: () => projects, phoneAuthority: authority.verify,
  });
  t.after(() => runtime.shutdown());
  return { runtime, log, registry, root: dir, authority };
}
async function attach(runtime, id) {
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${id}` });
  return ws;
}
const REMOTE = (level = 'ask', extra = {}) => ({ remote: { channel: 'whatsapp', level, ...extra } });

test('observe: sees packets with no socket attached; a later UI attach still gets the replay buffer', async (t) => {
  const { runtime } = harness(t);
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const seen = [];
  const off = runtime.observe((message) => seen.push(message));
  const result = await runtime.submit(session.id, { text: 'hello from the phone', origin: 'whatsapp' });
  assert.deepEqual(result, { ok: true });
  await waitFor(() => seen.some((m) => m.packet.type === 'done'));
  assert.ok(seen.every((m) => m.sessionId === session.id));
  assert.ok(seen.some((m) => m.packet.type === 'event' && m.packet.event.type === 'assistant'));
  const ws = await attach(runtime, session.id);
  const replay = ws.packets('reattach_result')[0];
  assert.ok(replay.replayed > 0, 'the observer did not drain the UI buffer');
  assert.ok(ws.packets('done').length === 1);
  off();
  const before = seen.length;
  await runtime.submit(session.id, { text: 'again', origin: 'whatsapp' });
  await waitFor(() => ws.packets('done').length === 2);
  assert.equal(seen.length, before, 'unsubscribed');
});

test('observe: an observer never holds a session open (idle disposal still runs)', async (t) => {
  const { runtime, log } = harness(t);
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  runtime.observe(() => {});
  runtime._internals.settings.idleDisposeMs = 30;
  await runtime.submit(session.id, { text: 'one turn', origin: 'whatsapp' });
  await waitFor(() => log.some((row) => row[0] === 'dispose'), { timeout: 1000 });
  assert.equal(runtime._internals.sessions.get(session.id).brain, null);
});

test('submit: a live user_prompt with its origin (the panel path sends none), a result per refusal', async (t) => {
  const { runtime, log } = harness(t, { delayMs: 40 });
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const ws = await attach(runtime, session.id);
  send(ws, { type: 'query', prompt: 'typed in the panel' });
  await waitFor(() => ws.packets('done').length === 1);
  assert.equal(ws.sent.filter((p) => p.type === 'event' && p.event.type === 'synabun.user_prompt').length, 0, 'the panel draws its own prompt');
  const first = runtime.submit(session.id, { text: 'from the phone', origin: 'whatsapp' });
  // Busy from the first call on, before its prefix finished: the mailbox / a second submit cannot slip in.
  assert.equal(runtime.isBusy(session.id), true);
  const second = await runtime.submit(session.id, { text: 'second', origin: 'whatsapp' });
  assert.equal(second.code, 'ASSISTANT_BUSY');
  assert.deepEqual(await first, { ok: true });
  const live = ws.sent.filter((p) => p.type === 'event' && p.event.type === 'synabun.user_prompt');
  assert.deepEqual(live.map((p) => [p.event.text, p.event.origin]), [['from the phone', 'whatsapp']]);
  await waitFor(() => ws.packets('done').length === 2);
  const journal = runtime.getSession(session.id).transcript.map((e) => e.packet.event).filter((e) => e?.type === 'synabun.user_prompt');
  assert.deepEqual(journal.map((e) => [e.text, e.origin || null]), [['typed in the panel', null], ['from the phone', 'whatsapp']], 'origin journaled only when not the panel');
  assert.equal((await runtime.submit('assistant-nope', { text: 'x' })).code, 'SESSION_NOT_FOUND');
  assert.deepEqual(await runtime.submit(session.id, { text: '   ' }), { ok: false, code: 'EMPTY_PROMPT', message: 'No prompt provided' });
  assert.deepEqual(ws.packets('error').at(-1), { type: 'error', message: 'No prompt provided' }, 'the same packet the panel always got');
  await runtime.closeSession(session.id);
  assert.equal((await runtime.submit(session.id, { text: 'x' })).code, 'SESSION_ENDED');
  assert.ok(log.filter((row) => row[0] === 'turn').length === 2);
});

test('submit: budget refusals and a brain that cannot start come back as results', async (t) => {
  const dispatcher = { limits: {}, subscribe: () => () => {}, totals: () => ({ costUsd: 0 }), sessionBudget: () => ({ totalUsd: 26, hardUsd: 25, brainUsd: 1, dispatchUsd: 25 }) };
  const { runtime } = harness(t, { dispatcher });
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const refused = await runtime.submit(session.id, { text: 'go', origin: 'whatsapp' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'SESSION_BUDGET_EXCEEDED');
  assert.match(refused.message, /\$26\.00/);
  const { runtime: broken } = harness(t, { failStart: true });
  const other = await broken.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const failed = await broken.submit(other.id, { text: 'go', origin: 'whatsapp' });
  assert.deepEqual([failed.ok, failed.code], [false, 'CLI_MISSING']);
});

test('the mailbox waits while a prompt is still in its prefix (recall awaits before the turn runs)', async (t) => {
  let releaseRecall;
  const memory = { recallForPrompt: () => new Promise((r) => { releaseRecall = () => r({ results: [] }); }) };
  const listeners = new Set();
  const dispatcher = { limits: {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, totals: () => ({ costUsd: 0 }), get: (runId) => ({ runId }) };
  const { runtime, log } = harness(t, { memory, dispatcher });
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const pending = runtime.submit(session.id, { text: 'slow prefix', origin: 'whatsapp' });
  await waitFor(() => typeof releaseRecall === 'function');
  for (const listener of listeners) listener({ type: 'assistant:dispatch', reason: 'stalled', run: { runId: 'r1', assistantSessionId: session.id, provider: 'codex', title: 'T' } });
  await wait(80);
  assert.equal(log.filter((row) => row[0] === 'turn').length, 0, 'no mailbox turn slipped in before the prompt');
  releaseRecall();
  await pending;
  await waitFor(() => log.filter((row) => row[0] === 'turn').length === 2, { timeout: 1500 });
  const turns = log.filter((row) => row[0] === 'turn').map((row) => row[1]);
  assert.equal(turns[0], 'slow prefix');
  assert.match(turns[1], /\[SynaBun Mailbox\]/);
});

test('answerControl: brain cards must be pending (unknown ids never reach the brain); control_resolved carries the origin', async (t) => {
  const answered = [];
  const router = { owns: (id) => id === 'route-1', answer: async (id, response, opts) => { answered.push(['route', id, opts.origin]); }, pendingCards: () => [{ type: 'control_request', request_id: 'route-1', request: { subtype: 'route' } }], cancelForSession: () => {}, stamp: () => null };
  const clarifier = {
    owns: (id) => id === 'clarify-1' || id === 'clarify-2',
    answer: (id, response, opts) => { if (id === 'clarify-2') throw Object.assign(new Error('already'), { code: 'CLARIFY_ALREADY_ANSWERED' }); answered.push(['clarify', id, opts.origin]); },
    pendingCards: () => [{ type: 'control_request', request_id: 'clarify-1', request: { subtype: 'clarify' } }],
    onNativeQuestion: () => {}, onNativeAnswer: () => {}, onNativeSettled: () => {}, onUserPrompt: () => null, cancelForSession: () => {},
  };
  const { runtime, log } = harness(t, { router, clarifier });
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const ws = await attach(runtime, session.id);
  const live = runtime._internals.sessions.get(session.id);
  await runtime._internals.ensureBrain(live);
  runtime._internals.onBrainPacket(live, { type: 'control_request', request_id: 'toolu_1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  assert.deepEqual(runtime.pendingControls(session.id).map((p) => p.request_id), ['toolu_1', 'route-1', 'clarify-1'], 'what the panel replays');

  assert.deepEqual(await runtime.answerControl(session.id, 'toolu_404', { behavior: 'allow' }, { origin: 'whatsapp' }), { ok: false, kind: 'brain', code: 'CONTROL_UNKNOWN', message: 'No open request toolu_404 in this session.' });
  send(ws, { type: 'control_response', request_id: 'toolu_405', response: { behavior: 'allow' } });
  await wait(5);
  assert.equal(log.filter((row) => row[0] === 'brain-control').length, 0, 'an unknown id never reaches the brain, from either path');

  assert.deepEqual(await runtime.answerControl(session.id, 'toolu_1', { behavior: 'allow' }, { origin: 'whatsapp' }), { ok: true, kind: 'brain' });
  assert.deepEqual(log.filter((row) => row[0] === 'brain-control').map((row) => row[1]), ['toolu_1']);
  assert.deepEqual(ws.packets('control_resolved').at(-1), { type: 'control_resolved', request_id: 'toolu_1', origin: 'whatsapp' });
  assert.equal(live.pendingControls.size, 0);

  assert.deepEqual(await runtime.answerControl(session.id, 'route-1', { kind: 'route', optionId: 's1', remember: false }, { origin: 'whatsapp' }), { ok: true, kind: 'route' });
  assert.deepEqual(await runtime.answerControl(session.id, 'clarify-1', { kind: 'clarify', behavior: 'deny' }, { origin: 'whatsapp' }), { ok: true, kind: 'clarify' });
  assert.deepEqual(answered, [['route', 'route-1', 'whatsapp'], ['clarify', 'clarify-1', 'whatsapp']]);
  assert.deepEqual(ws.packets('control_resolved').map((p) => [p.request_id, p.origin]), [['toolu_1', 'whatsapp'], ['route-1', 'whatsapp'], ['clarify-1', 'whatsapp']]);
  const failed = await runtime.answerControl(session.id, 'clarify-2', {}, { origin: 'whatsapp' });
  assert.deepEqual([failed.ok, failed.code], [false, 'CLARIFY_ALREADY_ANSWERED']);
  // The panel's own answer: control_resolved with origin 'ui'; a rejected clarify answer still errors to the socket.
  send(ws, { type: 'control_response', request_id: 'clarify-2', response: {} });
  await wait(5);
  assert.deepEqual(ws.packets('error').at(-1), { type: 'error', code: 'CLARIFY_ALREADY_ANSWERED', request_id: 'clarify-2', message: 'already' });
});

test('answerDispatchControl: resolvedBy = origin, only for this session\'s runs; stopTurn aborts; isBusy', async (t) => {
  const calls = [];
  const dispatcher = {
    limits: {}, subscribe: () => () => {}, totals: () => ({ costUsd: 0 }),
    get: (runId) => (runId === 'run-mine' ? { runId, assistantSessionId: 'SESSION' } : runId === 'run-other' ? { runId, assistantSessionId: 'assistant-other' } : null),
    respondPermission(runId, requestId, response, opts) {
      if (requestId === 'done') throw Object.assign(new Error('Request done was already resolved'), { code: 'PERMISSION_ALREADY_RESOLVED' });
      calls.push([runId, requestId, response.behavior, opts.origin]);
      return {};
    },
  };
  const { runtime, log } = harness(t, { dispatcher, delayMs: 200 });
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  dispatcher.get = ((get) => (runId) => { const run = get(runId); return run?.assistantSessionId === 'SESSION' ? { ...run, assistantSessionId: session.id } : run; })(dispatcher.get);
  assert.deepEqual(runtime.answerDispatchControl(session.id, 'run-mine', 'perm-1', { behavior: 'allow' }, { origin: 'whatsapp' }), { ok: true });
  assert.deepEqual(calls, [['run-mine', 'perm-1', 'allow', 'whatsapp']]);
  assert.equal(runtime.answerDispatchControl(session.id, 'run-other', 'perm-2', {}, { origin: 'whatsapp' }).code, 'RUN_NOT_IN_SESSION');
  assert.equal(runtime.answerDispatchControl(session.id, 'run-mine', 'done', {}, { origin: 'whatsapp' }).code, 'PERMISSION_ALREADY_RESOLVED');
  const ws = await attach(runtime, session.id);
  send(ws, { type: 'dispatch_control_response', runId: 'run-mine', request_id: 'perm-3', response: { behavior: 'deny' } });
  await wait(5);
  assert.deepEqual(calls.at(-1), ['run-mine', 'perm-3', 'deny', 'user'], 'the panel still resolves as "user"');
  send(ws, { type: 'dispatch_control_response', runId: 'run-mine', request_id: 'done', response: {} });
  await wait(5);
  assert.deepEqual(ws.packets('error').at(-1), { type: 'error', message: 'Request done was already resolved' });

  assert.equal(runtime.isBusy(session.id), false);
  await runtime.submit(session.id, { text: 'long one', origin: 'whatsapp' });
  assert.equal(runtime.isBusy(session.id), true);
  // A "do it here" pick waits for the running turn; the Stop drops it with the turn.
  assert.equal(runtime.routerContinue(session.id, { target: { kind: 'direct', provider: 'codex', model: 'x' }, route: { summary: 'tidy' } }), true);
  assert.deepEqual(await runtime.stopTurn(session.id, { origin: 'whatsapp' }), { ok: true });
  assert.ok(log.some((row) => row[0] === 'abort'));
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(log.filter((row) => row[0] === 'turn').map((row) => row[1]), ['long one'], 'the continuation never runs');
  assert.equal((await runtime.stopTurn('assistant-nope')).code, 'SESSION_NOT_FOUND');
  assert.equal(runtime.isBusy('assistant-nope'), false);
});

test('a remote session: registered before it is persisted, flagged on its record, read-only after a restart without registration', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-bridge-api-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const registry = createRemotePolicyRegistry();
  const { runtime } = harness(t, { root, registry });
  const created = [];
  registry.subscribe((e) => created.push(e.sessionId));
  const session = await runtime.createSession({ brain: { provider: 'claude-code', permissionMode: 'bypassPermissions' }, label: 'WhatsApp · Sep 28', channel: 'whatsapp', fallback: true }, REMOTE('ask', { strictWorkerApprovals: true }));
  assert.equal(created[0], session.id);
  assert.equal(registry.getSessionPolicy(session.id).level, 'ask');
  assert.equal(session.channel, 'whatsapp');
  assert.equal(session.remote.channel, 'whatsapp');
  assert.equal(session.computerUse, false);
  assert.equal(session.remoteLevel, 'ask');
  assert.equal(session.brain.permissionMode, 'default', 'ask: the approval mode is default');
  assert.equal(session.remote.modes.permissionMode, 'bypassPermissions', 'what was asked for is kept');
  assert.equal(session.routing.effectiveMode, 'always-ask');
  const index = JSON.parse(readFileSync(resolve(root, 'assistant-sessions.json'), 'utf8'));
  assert.ok(index.find((row) => row.id === session.id).remote, 'flagged in the persisted index');
  const plain = await runtime.createSession({ brain: { provider: 'codex' }, remote: { level: 'autonomous' } }, {});
  assert.equal(plain.remote, undefined, 'a body cannot make a remote session');
  assert.equal(registry.getSessionPolicy(plain.id), null);
  await runtime.shutdown();
  // A restart: a fresh registry, nobody registered it again.
  const fresh = createRemotePolicyRegistry();
  const { runtime: second } = harness(t, { root, registry: fresh });
  assert.equal(second.sessionPolicy(session.id).level, 'read-only');
  assert.equal(second.sessionPolicy(session.id).failClosed, true);
  assert.equal(second.getSession(session.id).remoteLevel, 'read-only');
  assert.equal(second.sessionPolicy(plain.id), null);
});

test('computer use cannot be turned on for a remote session: updateSession, the socket, PATCH', async (t) => {
  const desktop = { isSupported: () => true, isReady: () => true, defaultSessionOn: () => true, onSessionToggle: () => {}, mintGrant: () => 'grant-token', revokeFor: () => {}, releaseOwner: () => {} };
  const { runtime, log } = harness(t, { desktop });
  const session = await runtime.createSession({ brain: { provider: 'claude-code' } }, REMOTE('autonomous', { autonomousUntil: Date.now() + 3600_000 }));
  assert.equal(session.computerUse, false);
  assert.equal((await runtime.updateSession(session.id, { computerUse: true })).computerUse, false);
  const ws = await attach(runtime, session.id);
  send(ws, { type: 'set_computer_use', enabled: true });
  await wait(5);
  assert.equal(runtime.getSession(session.id).computerUse, false);
  assert.equal(runtime.getComputerUse(session.id), false);
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', createAssistantApi({ dispatcher: { limits: {}, get: () => null, list: () => [], totals: () => ({}) }, runtime }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/assistant/sessions/${session.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ computerUse: true }) });
  assert.equal((await res.json()).session.computerUse, false);
  // Its brain never gets a desktop grant; a desktop session's does.
  await runtime.submit(session.id, { text: 'hi', origin: 'whatsapp' });
  const desk = await runtime.createSession({ brain: { provider: 'claude-code' } });
  await runtime.submit(desk.id, { text: 'hi', origin: 'api' });
  const creates = log.filter((row) => row[0] === 'create');
  assert.deepEqual(creates.map((row) => row[2].desktopGrant), [null, 'grant-token']);
});

test('the remote hook: ask for what plan mode refuses (subagents too), deny credentials at every level, the level per turn', async (t) => {
  const { runtime, log, registry } = harness(t);
  const session = await runtime.createSession({ brain: { provider: 'claude-code' }, channel: 'whatsapp' }, REMOTE('ask'));
  await runtime.submit(session.id, { text: 'hi', origin: 'whatsapp' });
  await waitFor(() => !runtime.isBusy(session.id));
  const created = log.find((row) => row[0] === 'create')[2];
  assert.equal(created.remoteLevel, 'ask');
  const hook = created.hooks.PreToolUse.at(-1).hooks[0];
  const decide = async (tool_name, tool_input, extra = {}) => (await hook({ tool_name, tool_input, ...extra }))?.hookSpecificOutput?.permissionDecision || null;
  assert.equal(await decide('Bash', { command: 'rm -rf build' }), 'ask');
  assert.equal(await decide('Bash', { command: 'rm -rf build' }, { agent_id: 'sub-1' }), 'ask', 'subagents are asked too');
  assert.equal(await decide('Edit', { file_path: '/tmp/a', old_string: 'a', new_string: 'b' }), 'ask');
  assert.equal(await decide('mcp__SynaBun__agent_send', { run_id: 'r', text: 'x' }), 'ask');
  assert.equal(await decide('Read', { file_path: '/tmp/a' }), null);
  assert.equal(await decide('Bash', { command: 'git status' }), null);
  assert.equal(await decide('mcp__SynaBun__remember', { content: 'x' }), null, 'memory writes stay unasked');
  assert.equal(await decide('mcp__SynaBun__agent_dispatch', { task: 'x' }), null, 'its route card is the approval');
  assert.equal(await decide('AskUserQuestion', {}), null);
  assert.equal(await decide('Read', { file_path: '~/.ssh/id_rsa' }), 'deny');
  assert.equal(await decide('mcp__SynaBun__computer', { action: 'screenshot' }), 'deny');
  registry.registerSessionPolicy(session.id, { level: 'autonomous', autonomousUntil: Date.now() + 3600_000 });
  assert.equal(await decide('Bash', { command: 'rm -rf build' }), null, 'autonomous runs it');
  assert.equal(await decide('Bash', { command: 'cat ~/.aws/credentials' }), 'deny', 'still never credentials');
  runtime._internals.sessions.get(session.id).turnUntrusted = true;
  assert.equal(await decide('Bash', { command: 'rm -rf build' }), 'ask', 'an untrusted turn is capped at ask');
  // A desktop session's Claude brain gets no remote hook.
  const desk = await runtime.createSession({ brain: { provider: 'claude-code' } });
  await runtime.submit(desk.id, { text: 'hi', origin: 'api' });
  const deskCreate = log.filter((row) => row[0] === 'create').at(-1)[2];
  assert.equal(deskCreate.remoteLevel, null);
  // Only the browser policy's hook (every Claude brain): nothing is asked, credentials are not the desktop's concern here.
  assert.equal(deskCreate.hooks.PreToolUse.length, 1);
  const deskHook = deskCreate.hooks.PreToolUse[0].hooks[0];
  assert.deepEqual(await deskHook({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }), {});
  assert.equal((await deskHook({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } })).hookSpecificOutput.permissionDecision, 'deny');
});

test('modes follow the level at every write; an untrusted prompt runs at ask; raising the level gives the asked mode back', async (t) => {
  const { runtime, log, registry } = harness(t);
  const until = Date.now() + 3600_000;
  const session = await runtime.createSession({ brain: { provider: 'claude-code', permissionMode: 'bypassPermissions' } }, REMOTE('autonomous', { autonomousUntil: until }));
  assert.equal(session.brain.permissionMode, 'bypassPermissions', 'autonomous keeps it');
  await runtime.submit(session.id, { text: 'untrusted', origin: 'whatsapp', untrusted: true });
  assert.equal(log.find((row) => row[0] === 'turn')[2].permissionMode, 'default', 'an untrusted turn is capped at ask');
  await waitFor(() => !runtime.isBusy(session.id));
  await runtime.submit(session.id, { text: 'trusted', origin: 'whatsapp' });
  assert.equal(log.filter((row) => row[0] === 'turn').at(-1)[2].permissionMode, 'bypassPermissions', 'the next trusted prompt gets it back');
  await waitFor(() => !runtime.isBusy(session.id));
  // Lowered to read-only: plan mode, pushed to the live brain.
  registry.registerSessionPolicy(session.id, { level: 'read-only' });
  await wait(5);
  assert.deepEqual([runtime.getSession(session.id).brain.permissionMode, runtime.getSession(session.id).brain.planMode], ['default', true]);
  const ws = await attach(runtime, session.id);
  send(ws, { type: 'set_permission_mode', mode: 'bypassPermissions', planMode: false });
  await wait(5);
  assert.deepEqual(log.filter((row) => row[0] === 'mode').at(-1), ['mode', 'default', true], 'the socket cannot leave read-only');
  const updated = await runtime.updateSession(session.id, { brain: { permissionMode: 'acceptEdits', planMode: false } });
  assert.deepEqual([updated.brain.permissionMode, updated.brain.planMode], ['default', true]);
  // The brain reports it left plan mode on its own: put back.
  const live = runtime._internals.sessions.get(session.id);
  runtime._internals.onBrainPacket(live, { type: 'event', event: { type: 'mode_changed', mode: 'default' } });
  await wait(5);
  assert.equal(runtime.getSession(session.id).brain.planMode, true);
  assert.deepEqual(log.filter((row) => row[0] === 'mode').at(-1), ['mode', 'default', true]);
  // The desktop approves the plan: it may run for this turn.
  runtime._internals.onBrainPacket(live, { type: 'control_request', request_id: 'toolu_plan', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'x' } } });
  assert.equal((await runtime.answerControl(session.id, 'toolu_plan', { behavior: 'allow', planDecision: 'default' }, { origin: 'ui' })).ok, true);
  runtime._internals.onBrainPacket(live, { type: 'event', event: { type: 'mode_changed', mode: 'default' } });
  assert.equal(runtime.getSession(session.id).brain.planMode, false, 'a desktop-approved plan runs');
  runtime._internals.onBrainPacket(live, { type: 'done', code: 0 });
  await runtime.submit(session.id, { text: 'next from the phone', origin: 'whatsapp' });
  assert.equal(log.filter((row) => row[0] === 'turn').at(-1)[2].planMode, true, 'the next turn is read-only again');
  // Raised to autonomous: the asked-for modes come back (acceptEdits was the last asked).
  await waitFor(() => !runtime.isBusy(session.id));
  registry.registerSessionPolicy(session.id, { level: 'autonomous', autonomousUntil: until });
  await wait(5);
  assert.equal(runtime.getSession(session.id).brain.permissionMode, 'acceptEdits');
});

test('lowering the level stops this session\'s runs above it; a Claude brain built for another level restarts', async (t) => {
  const stopped = [];
  const runs = [
    { runId: 'r-plain', provider: 'claude-code', cwd: '/tmp/app', tags: [], permissionPolicy: 'auto', capability: 'full', usesComputer: false },
    { runId: 'r-full', provider: 'claude-code', cwd: '/tmp/app', tags: ['user-authorized-full'], permissionPolicy: 'auto', capability: 'full', usesComputer: false },
  ];
  const dispatcher = { limits: {}, subscribe: () => () => {}, totals: () => ({ costUsd: 0 }), list: ({ activeOnly }) => (activeOnly ? runs : []), stop: async (runId, reason) => { stopped.push([runId, reason]); } };
  const { runtime, log, registry } = harness(t, { dispatcher, projects: ['/tmp/app'] });
  const session = await runtime.createSession({ brain: { provider: 'claude-code' } }, REMOTE('autonomous', { autonomousUntil: Date.now() + 3600_000 }));
  await runtime.submit(session.id, { text: 'hi', origin: 'whatsapp' });
  await waitFor(() => !runtime.isBusy(session.id));
  assert.equal(log.find((row) => row[0] === 'create')[2].remoteLevel, 'autonomous');
  registry.registerSessionPolicy(session.id, { level: 'ask' });
  await wait(10);
  assert.deepEqual(stopped, [['r-full', 'remote_policy']], 'ask: only the run past it');
  assert.ok(log.some((row) => row[0] === 'dispose'), 'the brain allowed bypass: rebuilt at the next turn');
  registry.registerSessionPolicy(session.id, { level: 'ask', paused: true });
  await wait(10);
  assert.deepEqual(stopped.map((row) => row[0]), ['r-full', 'r-plain', 'r-full'], 'paused = read-only: every run');
});

test('answerControl "superseded" (the user wrote something else): a route and a clarify card are cancelled, not answered; the marker never reaches a brain', async (t) => {
  const calls = [];
  const router = {
    owns: (id) => id === 'route-1' || id === 'route-2',
    answer: async (id, response, opts) => { calls.push(['route.answer', id, response, opts.origin]); },
    cancel: (id, reason, opts) => { calls.push(['route.cancel', id, reason, opts?.sessionId]); return true; },
    pendingCards: () => [], cancelForSession: () => {}, stamp: () => null,
  };
  const clarifier = {
    owns: (id) => id === 'clarify-1',
    answer: (id, response, opts) => { calls.push(['clarify.answer', id, response, opts.origin]); },
    cancel: (id, reason, opts) => { calls.push(['clarify.cancel', id, reason, opts?.sessionId]); return true; },
    pendingCards: () => [], onNativeQuestion: () => {}, onNativeAnswer: () => {}, onNativeSettled: () => {}, onUserPrompt: () => null, cancelForSession: () => {},
  };
  const { runtime, log } = harness(t, { router, clarifier });
  const session = await runtime.createSession({ brain: { provider: 'claude-code' }, cwd: '/tmp', channel: 'whatsapp' }, REMOTE('ask'));
  const ws = await attach(runtime, session.id);
  const live = runtime._internals.sessions.get(session.id);
  await runtime._internals.ensureBrain(live);
  assert.equal(runtime.sessionChannel(session.id), 'whatsapp');
  assert.equal(runtime.sessionChannel('assistant-none'), null);

  const MOVED_ON = { origin: 'whatsapp', superseded: true };
  assert.deepEqual(await runtime.answerControl(session.id, 'route-1', { kind: 'route', optionId: null, remember: false, decline: true }, MOVED_ON), { ok: true, kind: 'route', superseded: true });
  assert.deepEqual(await runtime.answerControl(session.id, 'clarify-1', { kind: 'clarify', behavior: 'deny', message: 'moved on' }, MOVED_ON), { ok: true, kind: 'clarify', superseded: true });
  assert.deepEqual(calls, [['route.cancel', 'route-1', 'superseded', session.id], ['clarify.cancel', 'clarify-1', 'superseded', session.id]], 'cancelled for this session: no "declined", no "go with your assumptions"');
  // The desktop card locks as answered on WhatsApp.
  assert.deepEqual(ws.packets('control_resolved').map((p) => [p.request_id, p.origin]), [['route-1', 'whatsapp'], ['clarify-1', 'whatsapp']]);
  // The option only ever goes with a denial: it can never ride on a pick.
  await runtime.answerControl(session.id, 'route-2', { kind: 'route', optionId: 's1', remember: false }, MOVED_ON);
  assert.deepEqual(calls.at(-1), ['route.answer', 'route-2', { kind: 'route', optionId: 's1', remember: false }, 'whatsapp'], 'a pick is answered the normal way');
  // A "superseded" key inside a response is not the option: it is dropped, and a decline stays the user's own "no".
  await runtime.answerControl(session.id, 'route-2', { kind: 'route', optionId: null, remember: false, decline: true, superseded: true }, { origin: 'whatsapp' });
  assert.deepEqual(calls.at(-1), ['route.answer', 'route-2', { kind: 'route', optionId: null, remember: false, decline: true }, 'whatsapp'], 'answered, not cancelled; the key never reaches the router');
  // A brain's own card: denied, and the brain never sees a marker, whichever way it came.
  runtime._internals.onBrainPacket(live, { type: 'control_request', request_id: 'toolu_9', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  assert.deepEqual(await runtime.answerControl(session.id, 'toolu_9', { behavior: 'deny', message: 'the user sent a new message instead', superseded: true }, MOVED_ON), { ok: true, kind: 'brain' });
  assert.deepEqual(log.filter((row) => row[0] === 'brain-control').at(-1), ['brain-control', 'toolu_9', { behavior: 'deny', message: 'the user sent a new message instead' }]);
  // A desktop session reports no channel.
  const desk = await runtime.createSession({ brain: { provider: 'claude-code' }, cwd: '/tmp' });
  assert.equal(runtime.sessionChannel(desk.id), null);
});

test('the runtime\'s own plan card closed as "superseded" revises nothing: plan mode stays on and the session is free for the user\'s message', async (t) => {
  const { runtime, log } = harness(t);
  const session = await runtime.createSession({ brain: { provider: 'codex', planMode: true }, cwd: '/tmp' });
  const live = runtime._internals.sessions.get(session.id);
  const offer = (requestId) => {
    live.planCard = { requestId, plan: 'Step 1' };
    live.pendingControls.set(requestId, { type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', kind: 'plan', tool_name: 'ExitPlanMode', input: { plan: 'Step 1' } } });
  };
  // A note from the user themselves starts a revision turn…
  offer('plan-a');
  assert.deepEqual(await runtime.answerControl(session.id, 'plan-a', { behavior: 'deny', message: 'add tests first' }, { origin: 'ui' }), { ok: true, kind: 'plan' });
  // The revision is reserved the moment the card is answered (before any turn starts): the session is busy.
  assert.equal(runtime.isBusy(session.id), true, 'a revision turn is queued');
  await waitFor(() => log.some((row) => row[0] === 'turn' && /Revise it with their feedback/.test(row[1])));
  await waitFor(() => !runtime.isBusy(session.id));
  const turns = log.filter((row) => row[0] === 'turn').length;
  // …a card closed because they wrote something else does not: their message is the feedback.
  offer('plan-b');
  assert.deepEqual(await runtime.answerControl(session.id, 'plan-b', { behavior: 'deny', message: 'The user did not answer this on WhatsApp: they sent a new message instead.' }, { origin: 'whatsapp', superseded: true }), { ok: true, kind: 'plan' });
  // Nothing was queued (no sleep: a revision would be reserved here already, as it was above).
  assert.equal(live.work.size, 0, 'no revision is queued');
  assert.equal(live.workActive, null);
  assert.equal(runtime.isBusy(session.id), false, 'a prompt is taken at once');
  assert.equal(live.planCard, null);
  // Macrotask turns, no clock: whatever was scheduled has run by now, and no turn started.
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(log.filter((row) => row[0] === 'turn').length, turns, 'no revision turn');
  assert.equal(runtime.getSession(session.id).brain.planMode, true, 'nothing was approved: plan mode stays on');
  assert.equal((await runtime.submit(session.id, { text: 'what about the docs?', origin: 'whatsapp' })).ok, true);
});

test('the persona on WhatsApp: ask in plain text, never hold a turn for workers, sound like a person; nothing on this channel says otherwise', async (t) => {
  const { buildAssistantPersona } = await import('../lib/assistant-persona.js');
  const base = { assistantSessionId: 'assistant-x', routing: { mode: 'always-ask', askBelow: 0.75, preferences: {} }, clarify: true };
  for (const [brain, hasAskUserQuestion, prefix] of [[{ provider: 'claude-code', model: 'opus' }, true, 'mcp__SynaBun__'], [{ provider: 'codex', model: 'gpt-6' }, false, 'SynaBun_'], [{ provider: 'opencode', model: 'a/b' }, false, 'SynaBun_']]) {
    const persona = buildAssistantPersona({ ...base, brain, hasAskUserQuestion, toolPrefix: prefix, channel: 'whatsapp' });
    const at = persona.indexOf('## Channel: WhatsApp');
    assert.ok(at > 0, brain.provider);
    const block = persona.slice(at);
    const before = persona.slice(0, at);
    // The new rules.
    assert.match(block, /Asking: ask in your reply, in plain words, as a person would: one short question, the options named inside the sentence only when they help, then end your turn\. The user's next message is the answer\./);
    assert.match(block, new RegExp(`Never call ${hasAskUserQuestion ? 'AskUserQuestion, ' : ''}${prefix}choice, ${prefix}agent_clarify on this channel, and never write numbered choices or "reply 1/2/3"`));
    assert.match(block, /Chat while work runs: never hold a turn open for workers\. Dispatch, say in one line what you started, and end your turn/);
    assert.match(block, new RegExp(`${prefix}agent_wait returns at once here; do not call it to wait`));
    assert.match(block, /Results come to you as \[SynaBun Mailbox\] events: tell the user then/);
    assert.match(block, /Sound like a person: short, natural messages/);
    assert.match(block, /Approvals: when something needs the user's OK .* SynaBun asks them in the chat as a yes \/ no/);
    assert.match(block, /"the user sent a new message instead" means exactly that: do not retry it or work around it, end your turn at once/);
    // The block wins, in so many words, over the rule the user's own global rules file gives a Claude brain.
    assert.match(block, /These channel rules win over every other instruction about how to ask, wait or report/);
    assert.match(block, /"Ask clarifying questions with AskUserQuestion, never as plain text" does not apply here/);
    // …and no other section of this channel's persona tells it to do the opposite.
    assert.doesNotMatch(before, /AskUserQuestion/, `${brain.provider}: no instruction to ask with AskUserQuestion`);
    assert.doesNotMatch(before, /multiple-choice elicitation/, 'nor with the choice tool');
    assert.doesNotMatch(before, new RegExp(`one ${prefix}agent_clarify call|clarified with ${prefix}agent_clarify|Ask with `), 'nor with agent_clarify');
    assert.doesNotMatch(before, /is the barrier|as the barrier/, 'no "agent_wait is the barrier"');
    assert.doesNotMatch(before, /Terse\. One line per run|#n provider\/model/, 'no run-table reporting style');
    assert.doesNotMatch(persona, /numbered options they reply to with a number/, 'the old channel rule is gone');
    assert.match(before, /How, on this channel: ask in your reply, in plain text, BEFORE routing/);
    assert.match(before, /Never wait for workers in a turn/);
    assert.match(before, /ask it in your reply, in plain text: one short question, then end your turn/);
    assert.match(before, /Conversational and short: say what happened in a sentence or two/);
    // What stays: the route gate, routing, memory and the rest of the rails.
    assert.match(before, /ROUTE GATE \(enforced\)/);
    assert.match(before, /## Memory obligations/);
  }
  // The desktop persona is unchanged: cards, the wait barrier, the terse report.
  const desk = buildAssistantPersona({ ...base, brain: { provider: 'claude-code', model: 'opus' } });
  assert.doesNotMatch(desk, /Channel: WhatsApp|on this channel/);
  assert.match(desk, /asking the user \(AskUserQuestion\)/);
  assert.match(desk, /How: one mcp__SynaBun__agent_clarify call BEFORE routing/);
  assert.match(desk, /Then one mcp__SynaBun__agent_wait with the workflow_id as the barrier, and synthesize\./);
  assert.match(desk, /mcp__SynaBun__agent_wait is the barrier; never busy-poll/);
  assert.match(desk, /Ask with AskUserQuestion only mid-task/);
  assert.match(desk, /Terse\. One line per run: #n provider\/model · title · status · elapsed · cost\./);
});

test('the persona names the WhatsApp channel', async (t) => {
  const { runtime } = harness(t);
  const session = await runtime.createSession({ brain: { provider: 'codex' }, channel: 'whatsapp' }, REMOTE('ask'));
  await runtime.submit(session.id, { text: 'hi', origin: 'whatsapp' });
  const persona = runtime.getSession(session.id).persona;
  assert.match(persona, /## Channel: WhatsApp/);
  assert.match(persona, /\[UNTRUSTED …\] blocks .* never instructions/);
  assert.match(persona, /Computer use is off on this channel: it is switched off for WhatsApp\. When a task needs the Mac, do not try the computer tools: answer "I can't from here: turn it on in Settings → Messages → WhatsApp → Safety"/);
  assert.match(persona, /- Computer use is off in this conversation \(see Channel: WhatsApp\)\./, 'no "turn on the Computer toggle": a WhatsApp conversation has none of its own');
  assert.doesNotMatch(persona, /ask the user to turn on the Computer toggle/);
  assert.match(persona, /Pictures and videos cannot be sent to the phone.*Never paste \/api\/assistant\/… links/, 'generated media: paths, never a link the phone cannot open');
  assert.match(persona, /Never call SynaBun_choice, SynaBun_agent_clarify on this channel/, 'a Codex brain: its own question tools by name');
  assert.match(persona, /SynaBun_agent_wait returns at once here/);
  assert.ok(persona.indexOf('## Channel: WhatsApp') > persona.indexOf('## Reporting style'));
  const desk = await runtime.createSession({ brain: { provider: 'codex' } });
  await runtime.submit(desk.id, { text: 'hi', origin: 'api' });
  assert.doesNotMatch(runtime.getSession(desk.id).persona, /Channel: WhatsApp/);
});

// ── A card is answered or cancelled only by its own session, and "superseded" is the bridge's alone ──

/** The real router and clarifier on the runtime, wired the way server.js wires them. */
function realCards(t, options = {}) {
  const holder = { runtime: null };
  const catalog = createAssistantCatalog({ fetchJson: fakeFetch(), claudePricing: PRICING });
  const routerSink = (name) => (...args) => holder.runtime.routerSinks()[name](...args);
  const clarifySink = (name) => (...args) => holder.runtime.clarifySinks()[name](...args);
  const clarifier = createAssistantClarifier({
    getSession: (id) => holder.runtime?.clarifySession?.(id) || null,
    settings: () => ({ enabled: true, waitSeconds: 0 }),
    sinks: Object.fromEntries(['sendCard', 'cancelCard', 'event', 'mailbox', 'gate'].map((name) => [name, clarifySink(name)])),
  });
  const router = createAssistantRouter({
    catalog, configStore: { routing: () => effectiveRouting({ defaultMode: 'always-ask', waitSeconds: 0 }), setPreference() {} },
    getSession: (id) => holder.runtime?.routerSession?.(id) || null,
    sinks: Object.fromEntries(['sendCard', 'cancelCard', 'routeEvent', 'mailbox', 'continueDirect', 'routed', 'routeFailed'].map((name) => [name, routerSink(name)])),
    clarifier,
  });
  const h = harness(t, { router, clarifier, ...options });
  holder.runtime = h.runtime;
  t.after(() => { router.shutdown(); clarifier.shutdown(); });
  return { ...h, router, clarifier };
}
const ROUTE_BODY = { task_class: 'research', confidence: 0.9, summary: 'look it up', proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' }] };
const CLARIFY_BODY = { summary: 'Polish the UI', questions: [{ id: 'area', header: 'Area', question: 'Which part of the app?', options: [{ label: 'Settings page' }, { label: 'Whole app' }] }] };
const routePhases = (ws) => ws.sent.filter((p) => p.type === 'event' && p.event?.type === 'synabun.route').map((p) => p.event.phase);
const clarifyPhases = (ws) => ws.sent.filter((p) => p.type === 'event' && p.event?.type === 'synabun.clarify').map((p) => p.event.phase);

test('a control answer is scoped to its session: session A can neither cancel, decline nor pick session B\'s route, clarify or tool request', async (t) => {
  const { runtime, router, clarifier, log } = realCards(t);
  const a = await runtime.createSession({ brain: { provider: 'claude-code' }, cwd: '/tmp' });
  const b = await runtime.createSession({ brain: { provider: 'claude-code' }, cwd: '/tmp', channel: 'whatsapp' }, REMOTE('ask'));
  const wsA = await attach(runtime, a.id);
  const wsB = await attach(runtime, b.id);
  const liveB = runtime._internals.sessions.get(b.id);
  await runtime._internals.ensureBrain(liveB);
  const route = await router.propose({ sessionId: b.id, body: ROUTE_BODY, waitMs: 0 });
  const clarify = await clarifier.ask({ sessionId: b.id, body: CLARIFY_BODY, waitMs: 0 });
  assert.deepEqual([route.status, clarify.status], ['pending', 'pending']);
  const routeId = router.pendingCards(b.id)[0].request_id;
  const clarifyId = clarifier.pendingCards(b.id)[0].request_id;
  runtime._internals.onBrainPacket(liveB, { type: 'control_request', request_id: 'toolu_b', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  const open = () => [router.pendingCards(b.id).length, clarifier.pendingCards(b.id).length, runtime.pendingControls(b.id).length];
  assert.deepEqual(open(), [1, 1, 3]);

  // On session A's socket, with session B's request ids: the "superseded" cancel, a decline, a pick, an allow.
  // (The old cancel ran before the socket handler's first await, so it shows at once.)
  send(wsA, { type: 'control_response', request_id: routeId, response: { kind: 'route', behavior: 'deny', decline: true, superseded: true } });
  send(wsA, { type: 'control_response', request_id: clarifyId, response: { behavior: 'deny', superseded: true } });
  assert.deepEqual(open(), [1, 1, 3], 'a socket of another session cancels nothing');
  // The same through the runtime's own entry point, awaited: every answer of another session's card is unknown here.
  const UNKNOWN = { ok: false, kind: 'brain', code: 'CONTROL_UNKNOWN', message: undefined };
  const strip = (result) => ({ ...result, message: undefined });
  for (const opts of [{ origin: 'ui' }, { origin: 'whatsapp', superseded: true }]) {
    assert.deepEqual(strip(await runtime.answerControl(a.id, routeId, { kind: 'route', decline: true, behavior: 'deny', superseded: true }, opts)), UNKNOWN);
    assert.deepEqual(strip(await runtime.answerControl(a.id, clarifyId, { behavior: 'deny', superseded: true }, opts)), UNKNOWN);
    assert.deepEqual(strip(await runtime.answerControl(a.id, routeId, { kind: 'route', optionId: 's1', remember: false }, opts)), UNKNOWN, 'nor approve it');
    assert.deepEqual(strip(await runtime.answerControl(a.id, clarifyId, { behavior: 'allow', answers: [['Whole app']] }, opts)), UNKNOWN);
    assert.deepEqual(strip(await runtime.answerControl(a.id, 'toolu_b', { behavior: 'allow' }, opts)), UNKNOWN);
  }
  assert.deepEqual(open(), [1, 1, 3], 'session B still waits for its own answers');
  assert.equal(router.status(route.routeId).status, 'pending');
  assert.deepEqual([routePhases(wsB), clarifyPhases(wsB)], [['card'], ['card']], 'nothing was decided, declined or cancelled');
  assert.equal(wsB.packets('control_resolved').length + wsB.packets('control_cancelled').length, 0);
  assert.equal(wsA.packets('control_resolved').length, 0, 'session A heard no "resolved" for a card that is not its own');
  assert.equal(log.some((row) => row[0] === 'brain-control'), false, 'session B\'s brain heard nothing');
  // Session B's own answers still work.
  assert.deepEqual(await runtime.answerControl(b.id, routeId, { kind: 'route', optionId: null, remember: false, decline: true }, { origin: 'whatsapp', superseded: true }), { ok: true, kind: 'route', superseded: true });
  assert.deepEqual(await runtime.answerControl(b.id, clarifyId, { behavior: 'deny' }, { origin: 'whatsapp', superseded: true }), { ok: true, kind: 'clarify', superseded: true });
  assert.deepEqual(open(), [0, 0, 1]);
  assert.deepEqual([routePhases(wsB).at(-1), clarifyPhases(wsB).at(-1)], ['expired', 'cancelled']);
});

test('"superseded" is the bridge\'s alone: on a socket or over REST the marker is dropped, so a denial there is the user\'s own "no"', async (t) => {
  const { runtime, router, clarifier, log } = realCards(t);
  const session = await runtime.createSession({ brain: { provider: 'claude-code' }, cwd: '/tmp', channel: 'whatsapp' }, REMOTE('ask'));
  const ws = await attach(runtime, session.id);
  const live = runtime._internals.sessions.get(session.id);
  await runtime._internals.ensureBrain(live);
  // A socket (the panel, origin "ui") sends a decline that carries the marker.
  const first = await router.propose({ sessionId: session.id, body: ROUTE_BODY, waitMs: 0 });
  send(ws, { type: 'control_response', request_id: first.routeId, response: { kind: 'route', optionId: null, remember: false, decline: true, superseded: true } });
  await waitFor(() => routePhases(ws).length === 2);
  assert.deepEqual(routePhases(ws), ['card', 'declined'], 'declined (the user\'s own "no"), not the silent cancel');
  assert.equal(ws.packets('control_cancelled').length, 0);
  assert.deepEqual(ws.packets('control_resolved').map((p) => [p.request_id, p.origin]), [[first.routeId, 'ui']]);
  // The same for a clarify card: declined ("go with your assumptions" follows), not cancelled.
  await clarifier.ask({ sessionId: session.id, body: CLARIFY_BODY, waitMs: 0 });
  const clarifyId = clarifier.pendingCards(session.id)[0].request_id;
  send(ws, { type: 'control_response', request_id: clarifyId, response: { behavior: 'deny', superseded: true } });
  await waitFor(() => clarifyPhases(ws).length === 2);
  assert.deepEqual(clarifyPhases(ws), ['card', 'declined']);
  // A plan card of the runtime's own: a note with the marker still revises the plan (the marker is not honoured).
  live.planCard = { requestId: 'plan-x', plan: 'Step 1' };
  live.pendingControls.set('plan-x', { type: 'control_request', request_id: 'plan-x', request: { subtype: 'can_use_tool', kind: 'plan', tool_name: 'ExitPlanMode', input: { plan: 'Step 1' } } });
  send(ws, { type: 'control_response', request_id: 'plan-x', response: { behavior: 'deny', message: 'add tests first', superseded: true } });
  await waitFor(() => log.some((row) => row[0] === 'turn' && /Revise it with their feedback/.test(row[1])));
  await waitFor(() => !runtime.isBusy(session.id));
  // A brain's own request: the marker never reaches the brain.
  runtime._internals.onBrainPacket(live, { type: 'control_request', request_id: 'toolu_s', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  send(ws, { type: 'control_response', request_id: 'toolu_s', response: { behavior: 'deny', message: 'no', superseded: true } });
  await waitFor(() => log.some((row) => row[0] === 'brain-control' && row[1] === 'toolu_s'));
  assert.deepEqual(log.filter((row) => row[0] === 'brain-control').at(-1), ['brain-control', 'toolu_s', { behavior: 'deny', message: 'no' }]);

  // REST: the route and clarify answer routes take a decline with the marker as a plain decline.
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', createAssistantApi({ dispatcher: { limits: {}, get: () => null, list: () => [], totals: () => ({}) }, runtime, assistantRouter: router, clarifier }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const post = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/assistant${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const second = await router.propose({ sessionId: session.id, body: ROUTE_BODY, waitMs: 0 });
  const viaRest = await post(`/routes/${second.routeId}/answer`, { response: { decline: true, superseded: true } });
  assert.deepEqual([viaRest.status, viaRest.body.status], [200, 'declined']);
  assert.deepEqual(routePhases(ws).slice(-2), ['card', 'declined'], 'REST cannot cancel a card as "superseded"');
  await clarifier.ask({ sessionId: session.id, body: { ...CLARIFY_BODY, independent: true }, waitMs: 0 });
  const again = clarifier.pendingCards(session.id)[0]?.request_id;
  assert.ok(again, 'a second clarify card is open');
  const clarifyRest = await post(`/clarify/${again}/answer`, { response: { behavior: 'deny', superseded: true } });
  assert.deepEqual([clarifyRest.status, clarifyRest.body.status], [200, 'declined']);
  assert.equal(ws.packets('control_cancelled').length, 0, 'never the silent cancel');
});

test('the mailbox turn: a route_decided item whose run already exists names the run and asks for no dispatch; one with no run still says "dispatch now"', async (t) => {
  const runs = [{ runId: 'aaaaaaaa11112222', state: 'running', assistantSessionId: null, route: { routeId: 'route-started' } }];
  const dispatcher = { limits: {}, subscribe: () => () => {}, totals: () => ({ costUsd: 0 }), get: () => null, list: ({ assistantSessionId }) => runs.filter((run) => run.assistantSessionId === assistantSessionId) };
  const { runtime, log } = harness(t, { dispatcher });
  const session = await runtime.createSession({ brain: { provider: 'claude-code' }, cwd: '/tmp' });
  runs[0].assistantSessionId = session.id;
  const live = runtime._internals.sessions.get(session.id);
  const item = (routeId) => ({ kind: 'route_decided', route: { routeId, taskClass: 'code', summary: 'Fix it', target: { kind: 'dispatch', provider: 'codex', model: 'gpt', label: 'GPT' }, decidedBy: 'user' }, runIds: [], text: `The user picked GPT. Dispatch now with agent_dispatch route_id="${routeId}".` });
  runtime._internals.enqueueMailbox(live, item('route-started'));
  runtime._internals.enqueueMailbox(live, item('route-open'));
  const turn = await waitFor(() => log.find((row) => row[0] === 'turn' && /Mailbox/.test(row[1])));
  const [, started, , open] = turn[1].split('\n').filter((line) => /^\d\. |^ {3}/.test(line));
  assert.doesNotMatch(started, /agent_dispatch|Dispatch now/, started);
  assert.match(started, /already started on this route \(aaaaaaaa: running\)\. Do not dispatch it again\./);
  assert.match(turn[1], /1\. route_decided · route-started .* · runs aaaaaaaa/);
  assert.match(open, /next: agent_dispatch with route_id "route-open" · The user picked GPT\. Dispatch now/, 'no run on that route: unchanged');
});

// ── Computer use from a remote session: not a per-conversation choice ────────

test('a remote session: set_computer_use, a PATCH and updateSession change nothing; the meta carries the effective value and the reason', async (t) => {
  const toggles = [];
  const grants = [];
  const desktop = {
    isSupported: () => true, isReady: () => true, setupState: () => 'ready', defaultSessionOn: () => true,
    onSessionToggle: (id, on) => toggles.push([id, on]), mintGrant: (meta) => { grants.push(meta); return `grant-${grants.length}`; },
    setGrantActive: () => true, revokeFor: () => {}, releaseOwner: () => {},
  };
  const { runtime, log, registry } = harness(t, { desktop });
  const until = Date.now() + 3600_000;
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', createAssistantApi({ dispatcher: { limits: {}, get: () => null, list: () => [], totals: () => ({}) }, runtime }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const patch = async (id, body) => (await (await fetch(`http://127.0.0.1:${server.address().port}/api/assistant/sessions/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()).session;
  const remote = (view) => [view.computerUse, view.computerUseExplicit, view.computerRemote?.state, view.computerRemote?.reason];

  // The owner's switch is off: off, whatever is tried, with the reason.
  const off = await runtime.createSession({ brain: { provider: 'claude-code' }, channel: 'whatsapp' }, REMOTE('autonomous', { autonomousUntil: until }));
  assert.deepEqual(remote(off), [false, null, 'off', 'switch_off']);
  const ws = await attach(runtime, off.id);
  for (const enabled of [true, false, null]) {
    assert.deepEqual(remote(await runtime.updateSession(off.id, { computerUse: enabled })), [false, null, 'off', 'switch_off'], `updateSession ${enabled}`);
    assert.deepEqual(remote(await patch(off.id, { computerUse: enabled })), [false, null, 'off', 'switch_off'], `PATCH ${enabled}`);
    send(ws, { type: 'set_computer_use', enabled });
    await wait(5);
    assert.deepEqual(remote(runtime.getSession(off.id)), [false, null, 'off', 'switch_off'], `socket ${enabled}`);
  }
  // The socket is answered with what is in effect and why (the panel shows it instead of bouncing).
  const told = ws.packets('assistant:session').filter((p) => p.reason === 'computer').at(-1);
  assert.deepEqual([told.session.computerUse, told.session.computerRemote.reason], [false, 'switch_off']);
  assert.equal(runtime._internals.sessions.get(off.id).record.computerUse, false, 'the record is untouched');

  // The switch is on: on, and no socket, PATCH or updateSession turns it off either.
  const on = await runtime.createSession({ brain: { provider: 'claude-code' }, channel: 'whatsapp' }, REMOTE('autonomous', { autonomousUntil: until, computerUse: true }));
  assert.deepEqual(remote(on), [true, null, 'allowed', 'autonomous']);
  const ws2 = await attach(runtime, on.id);
  for (const enabled of [false, null, true]) {
    assert.deepEqual(remote(await runtime.updateSession(on.id, { computerUse: enabled })), [true, null, 'allowed', 'autonomous'], `updateSession ${enabled}`);
    assert.deepEqual(remote(await patch(on.id, { computerUse: enabled })), [true, null, 'allowed', 'autonomous'], `PATCH ${enabled}`);
    send(ws2, { type: 'set_computer_use', enabled });
    await wait(5);
    assert.deepEqual(remote(runtime.getSession(on.id)), [true, null, 'allowed', 'autonomous'], `socket ${enabled}`);
  }
  assert.deepEqual(toggles, [], 'nothing was switched at the desktop service');
  // The reason follows the policy: Ask, paused, read-only, an expired window, the switch off again.
  const reason = () => { const view = runtime.getSession(on.id); return [view.computerUse, view.computerRemote.state, view.computerRemote.reason]; };
  registry.registerSessionPolicy(on.id, { level: 'ask', computerUse: true });
  assert.deepEqual(reason(), [true, 'ask', 'ask']);
  registry.registerSessionPolicy(on.id, { level: 'ask', computerUse: true, paused: true });
  assert.deepEqual(reason(), [false, 'off', 'paused']);
  registry.registerSessionPolicy(on.id, { level: 'read-only', computerUse: true });
  assert.deepEqual(reason(), [false, 'off', 'read_only']);
  registry.registerSessionPolicy(on.id, { level: 'autonomous', autonomousUntil: Date.now() - 1, computerUse: true });
  assert.deepEqual(reason(), [true, 'ask', 'autonomous_expired']);
  registry.registerSessionPolicy(on.id, { level: 'autonomous', autonomousUntil: until, computerUse: false });
  assert.deepEqual(reason(), [false, 'off', 'switch_off']);
  assert.ok(ws2.packets('assistant:session').some((p) => p.reason === 'remote' && p.session.computerRemote.reason === 'paused'), 'the panel hears every change');
  // Between turns the desktop gate refuses a remote session even when it is "on".
  registry.registerSessionPolicy(on.id, { level: 'autonomous', autonomousUntil: until, computerUse: true });
  assert.equal(runtime.getSession(on.id).computerUse, true);
  assert.equal(runtime.getComputerUse(on.id), false, 'no turn is running');
  // Its brain is built with a HELD grant; the off session's with none; a desktop session's as before.
  await runtime.submit(on.id, { text: 'hi', origin: 'whatsapp' });
  await runtime.submit(off.id, { text: 'hi', origin: 'whatsapp' });
  const desk = await runtime.createSession({ brain: { provider: 'claude-code' } });
  await runtime.submit(desk.id, { text: 'hi', origin: 'api' });
  const built = Object.fromEntries(log.filter((row) => row[0] === 'create').map((row, i) => [[on.id, off.id, desk.id][i], row[2].desktopGrant]));
  assert.deepEqual(built, { [on.id]: 'grant-1', [off.id]: null, [desk.id]: 'grant-2' });
  assert.deepEqual([grants[0].held, grants[0].remote, grants[0].assistantSessionId], [true, { channel: 'whatsapp' }, on.id]);
  assert.deepEqual([grants[1].held, grants[1].remote], [undefined, undefined], 'a desktop session\'s grant is minted exactly as before');
  // A desktop session keeps its toggle.
  assert.deepEqual([desk.computerUse, desk.computerUseExplicit, desk.computerRemote], [true, null, null]);
  const toggled = await runtime.updateSession(desk.id, { computerUse: false });
  assert.deepEqual([toggled.computerUse, toggled.computerUseExplicit, toggled.computerRemote], [false, false, null]);
  assert.deepEqual(toggles, [[desk.id, false]]);
});

test('the remote hook and computer tools: denied with the reason, asked once per turn, or allowed; Codex / OpenCode hosts are always refused', async (t) => {
  const desktop = { isSupported: () => true, isReady: () => true, setupState: () => 'ready', defaultSessionOn: () => true, onSessionToggle: () => {}, mintGrant: () => 'grant', setGrantActive: () => true, revokeFor: () => {}, releaseOwner: () => {} };
  const router = { owns: () => false, pendingCards: () => [], cancelForSession: () => {}, stamp: () => null };
  // A brain whose turns end when the test says so (no timer): finish() reports the turn's end.
  const manual = (rows) => ({ session, sink, hooks }) => {
    let busy = false;
    rows.push(['create', session.brain.provider, { hooks }]);
    return {
      kind: session.brain.provider, async start() {},
      async sendUserTurn({ text }) { rows.push(['turn', text]); busy = true; },
      finish({ queued = false } = {}) { busy = queued; sink.send({ type: 'done', code: 0 }); },
      async abort() { busy = false; sink.send({ type: 'aborted' }); },
      async setPermissionMode() {}, respondControl(id, response) { rows.push(['brain-control', id, response]); },
      isBusy: () => busy, identity: () => ({}), async dispose() {},
    };
  };
  const { runtime, log, registry, authority } = harness(t, { desktop, router, brain: manual });
  const phoneCap = authority.issue(); // this test plays the bridge
  const until = Date.now() + 3600_000;
  const session = await runtime.createSession({ brain: { provider: 'claude-code' }, channel: 'whatsapp' }, REMOTE('ask', { computerUse: true }));
  const live = runtime._internals.sessions.get(session.id);
  await runtime._internals.ensureBrain(live);
  const hook = log.find((row) => row[0] === 'create')[2].hooks.PreToolUse.at(-1).hooks[0];
  const decide = async (tool_name, tool_input = { action: 'screenshot' }) => { const out = (await hook({ tool_name, tool_input }))?.hookSpecificOutput; return [out?.permissionDecision || null, out?.permissionDecisionReason || '']; };
  // No turn is running: nothing to approve, nothing runs.
  assert.deepEqual((await decide('mcp__SynaBun__computer'))[0], 'deny');
  assert.match((await decide('mcp__SynaBun__computer'))[1], /runs only inside the task that asked for it/);
  // A turn runs: the first call asks; the brain's permission request becomes the turn's ONE request.
  await runtime.submit(session.id, { text: 'use the mac', origin: 'whatsapp', authority: phoneCap });
  for (const tool of ['mcp__SynaBun__computer', 'mcp__SynaBun__computer_apps', 'mcp__SynaBun__computer_ax', 'mcp__SynaBun__computer_status']) assert.equal((await decide(tool))[0], 'ask', tool);
  assert.equal((await decide('mcp__SynaBun__computer_apps', { action: 'open', path: '~/.ssh/id_rsa' }))[0], 'deny', 'its arguments are still checked');
  const ws = await attach(runtime, session.id);
  const brainAsks = (id, tool = 'mcp__SynaBun__computer') => runtime._internals.onBrainPacket(live, { type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input: { action: 'left_click', coordinate: [10, 20] } } });
  brainAsks('perm-1');
  brainAsks('perm-2', 'mcp__SynaBun__computer_ax');
  const cards = ws.packets('control_request');
  assert.deepEqual(cards.map((p) => [p.request_id, p.request.subtype, p.request.tool_name, 'input' in p.request]), [['perm-1', 'computer_use', 'computer_use', false]], 'one request of its own kind: no tool name, no arguments');
  assert.deepEqual(runtime.pendingControls(session.id).map((p) => p.request_id), ['perm-1']);
  // The brain withdraws a waiting call: it was never a card; the request stays.
  runtime._internals.onBrainPacket(live, { type: 'control_cancelled', request_id: 'perm-2' });
  assert.equal(ws.packets('control_cancelled').length, 0);
  brainAsks('perm-3');
  // An "allow" that did not come from the owner's phone (the desktop socket, REST, anything in the process)
  // is refused and leaves the request open: only the bridge's match on a phone message grants it.
  for (const origin of ['ui', 'rest', 'api', 'model', undefined]) {
    const refused = await runtime.answerControl(session.id, 'perm-1', { behavior: 'allow', kind: 'computer', always: true }, origin ? { origin } : {});
    assert.deepEqual([refused.ok, refused.kind, refused.code], [false, 'computer', 'COMPUTER_PHONE_ONLY'], String(origin));
  }
  send(ws, { type: 'control_response', request_id: 'perm-1', response: { behavior: 'allow', kind: 'computer' } });
  await wait(5);
  assert.deepEqual(runtime.pendingControls(session.id).map((p) => p.request_id), ['perm-1'], 'still open');
  assert.equal(log.filter((row) => row[0] === 'brain-control').length, 0, 'the brain heard nothing');
  assert.equal(runtime.getComputerUse(session.id), false);
  assert.ok(ws.sent.some((p) => p.type === 'event' && /approved on the owner's phone only\. It can be denied here\./.test(p.event?.text || '')), 'the panel is told why');
  // The phone approves: every waiting call is allowed, later ones run without asking.
  assert.deepEqual(await runtime.answerControl(session.id, 'perm-1', { behavior: 'allow', kind: 'computer', always: true }, { origin: 'whatsapp', authority: phoneCap }), { ok: true, kind: 'computer', granted: true });
  assert.deepEqual(log.filter((row) => row[0] === 'brain-control').map((row) => [row[1], row[2]]), [['perm-1', { behavior: 'allow' }], ['perm-3', { behavior: 'allow' }]]);
  assert.equal((await decide('mcp__SynaBun__computer'))[0], 'allow');
  assert.equal(runtime.getComputerUse(session.id), true);
  assert.equal(runtime.getSession(session.id).computerRemote.approved, true);
  assert.match(String(runtime.getComputerTurn(session.id)), new RegExp(`^${session.id}#\\d+$`), 'the desktop service binds calls to this turn');
  brainAsks('perm-4'); // a request that raced the approval: answered at once, never shown
  assert.deepEqual(log.filter((row) => row[0] === 'brain-control').at(-1).slice(1), ['perm-4', { behavior: 'allow' }]);
  assert.equal(ws.packets('control_request').length, 1);
  // An answer to it a second time is unknown; the same id in another session is unknown too.
  assert.equal((await runtime.answerControl(session.id, 'perm-1', { behavior: 'allow' }, { origin: 'whatsapp', authority: phoneCap })).code, 'CONTROL_UNKNOWN');
  // The turn ends with a prompt still queued in the CLI: that next turn starts unapproved (it asks).
  live.brain.finish({ queued: true });
  assert.equal(runtime.getComputerUse(session.id), false);
  assert.equal(runtime.getSession(session.id).computerRemote.approved, false);
  assert.equal((await decide('mcp__SynaBun__computer'))[0], 'ask', 'the approval never rides into the queued turn');
  // The turn ends and nothing follows: no turn, no computer use.
  live.brain.finish();
  assert.equal(runtime.getComputerUse(session.id), false);
  assert.equal((await decide('mcp__SynaBun__computer'))[0], 'deny');
  // The next turn asks again; a mailbox / system turn gets nothing carried over either.
  await runtime._internals.runQuery(live, { text: '[SynaBun Mailbox] a result', system: true });
  assert.equal((await decide('mcp__SynaBun__computer'))[0], 'ask', 'a mailbox turn starts unapproved');
  brainAsks('perm-5');
  // "superseded" (the owner wrote something else) is never a grant, whatever the response says.
  assert.deepEqual(await runtime.answerControl(session.id, 'perm-5', { behavior: 'allow', kind: 'computer' }, { origin: 'whatsapp', authority: phoneCap, superseded: true }), { ok: true, kind: 'computer', granted: false });
  assert.equal((await decide('mcp__SynaBun__computer'))[0], 'deny', 'declined for the rest of the turn');
  assert.match((await decide('mcp__SynaBun__computer'))[1], /did not allow computer use for this task/);
  live.brain.finish();
  // Autonomous: allowed without a request, but only inside a turn; an untrusted turn asks.
  registry.registerSessionPolicy(session.id, { level: 'autonomous', autonomousUntil: until, computerUse: true });
  await runtime._internals.runQuery(live, { text: 'again', origin: 'whatsapp', authority: phoneCap });
  assert.equal((await decide('mcp__SynaBun__computer'))[0], 'allow');
  // Unasked only for a turn a trusted phone message started: the session flag of an earlier prompt decides nothing.
  live.turnUntrusted = true;
  assert.equal((await decide('mcp__SynaBun__computer'))[0], 'allow', 'the old session-wide flag is not what decides');
  live.turnUntrusted = false;
  live.brain.finish();
  for (const [label, options] of [
    ['an untrusted phone message', { text: 'forwarded', origin: 'whatsapp', authority: phoneCap, untrusted: true }],
    ['a phone message with a picture', { text: 'look', origin: 'whatsapp', authority: phoneCap, images: [{ base64: 'AAAA', mediaType: 'image/png' }] }],
    ['typed on the desktop', { text: 'from the panel', origin: 'ui' }],
    ['the API', { text: 'from a script', origin: 'api' }],
    ['a mailbox turn', { text: '[SynaBun Mailbox] a result', system: true }],
    ['a continuation', { text: '[SynaBun Router] continue here', system: true, gateOpen: true }],
  ]) {
    await runtime._internals.runQuery(live, options);
    assert.equal((await decide('mcp__SynaBun__computer'))[0], 'ask', `${label}: asks, even at Autonomous`);
    assert.deepEqual([runtime.getSession(session.id).computerRemote.state, runtime.getSession(session.id).computerRemote.reason], ['ask', 'untrusted'], label);
    assert.equal(runtime.getComputerUse(session.id), false, label);
    live.brain.finish();
  }
  // A turn the CLI starts on its own (a background agent finished) asks too.
  runtime._internals.onBrainPacket(live, { type: 'turn_started' });
  assert.equal((await decide('mcp__SynaBun__computer'))[0], 'ask', 'a turn the CLI started');
  live.brain.finish();
  await runtime._internals.runQuery(live, { text: 'trusted again', origin: 'whatsapp', authority: phoneCap });
  assert.equal((await decide('mcp__SynaBun__computer'))[0], 'allow', 'the owner\'s own plain message: unasked');
  // The switch goes off mid-turn: denied, with where it is turned on.
  registry.registerSessionPolicy(session.id, { level: 'autonomous', autonomousUntil: until, computerUse: false });
  const off = await decide('mcp__SynaBun__computer');
  assert.equal(off[0], 'deny');
  assert.match(off[1], /Settings → Messages → WhatsApp → Safety/);
  // Codex and OpenCode hosts ask the gate: always refused on this channel, switch on and Autonomous included.
  for (const provider of ['codex', 'opencode']) {
    const other = await runtime.createSession({ brain: { provider }, channel: 'whatsapp' }, REMOTE('autonomous', { autonomousUntil: until, computerUse: true }));
    const otherLive = runtime._internals.sessions.get(other.id);
    runtime._internals.ensureGate(otherLive);
    const verdict = runtime.gateCheck({ session: other.id, token: otherLive.gateToken, tool: 'SynaBun_computer', input: { action: 'screenshot' }, inputComplete: true, host: provider });
    assert.equal(verdict.allow, false, provider);
    assert.match(verdict.reason, /its brain is not Claude, so it runs read-only/, provider);
  }
});

// ── The phone's authority is a capability only the bridge holds, never an origin string ──

test('granting computer use, the Mac part of a route and an unasked turn all need the bridge\'s capability, whatever origin is passed', async (t) => {
  const desktop = { isSupported: () => true, isReady: () => true, setupState: () => 'ready', defaultSessionOn: () => true, onSessionToggle: () => {}, mintGrant: () => 'grant', setGrantActive: () => true, revokeFor: () => {}, releaseOwner: () => {} };
  const manual = (rows) => ({ session, sink, hooks }) => {
    let busy = false;
    rows.push(['create', session.brain.provider, { hooks }]);
    return {
      kind: session.brain.provider, async start() {}, async sendUserTurn({ text }) { rows.push(['turn', text]); busy = true; },
      finish() { busy = false; sink.send({ type: 'done', code: 0 }); }, async abort() { busy = false; sink.send({ type: 'aborted' }); },
      async setPermissionMode() {}, respondControl(id, response) { rows.push(['brain-control', id, response]); }, isBusy: () => busy, identity: () => ({}), async dispose() {},
    };
  };
  const { runtime, log, registry, authority } = harness(t, { desktop, brain: manual });
  const until = Date.now() + 3600_000;
  const session = await runtime.createSession({ brain: { provider: 'claude-code' }, channel: 'whatsapp' }, REMOTE('ask', { computerUse: true }));
  const live = runtime._internals.sessions.get(session.id);
  await runtime._internals.ensureBrain(live);
  const hook = log.find((row) => row[0] === 'create')[2].hooks.PreToolUse.at(-1).hooks[0];
  const decide = async () => (await hook({ tool_name: 'mcp__SynaBun__computer', tool_input: { action: 'screenshot' } }))?.hookSpecificOutput?.permissionDecision || null;
  const cap = authority.issue(); // what the composition root hands the one bridge
  const forged = [undefined, null, 'whatsapp', 'synabun.phone-authority', Symbol('synabun.phone-authority'), {}, authority.verify, true];
  const ORIGINS = ['whatsapp', 'ui', 'rest', 'api', undefined];

  // 1. Granting the turn's computer request.
  await runtime.submit(session.id, { text: 'use the mac', origin: 'whatsapp', authority: cap });
  runtime._internals.onBrainPacket(live, { type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'mcp__SynaBun__computer', input: { action: 'screenshot' } } });
  for (const origin of ORIGINS) for (const fake of forged) {
    const out = await runtime.answerControl(session.id, 'perm-1', { behavior: 'allow', kind: 'computer' }, { ...(origin ? { origin } : {}), authority: fake });
    assert.deepEqual([out.ok, out.code], [false, 'COMPUTER_PHONE_ONLY'], `origin ${String(origin)}, authority ${String(fake)}`);
  }
  assert.equal(runtime.getComputerUse(session.id), false);
  assert.deepEqual(runtime.pendingControls(session.id).map((p) => p.request_id), ['perm-1'], 'still open');
  // The capability grants it; `origin` is only what the audit records.
  assert.deepEqual(await runtime.answerControl(session.id, 'perm-1', { behavior: 'allow', kind: 'computer' }, { origin: 'whatsapp', authority: cap }), { ok: true, kind: 'computer', granted: true });
  assert.equal(runtime.getComputerUse(session.id), true);
  live.brain.finish();

  // 2. The Mac part of a marked route card (the router's computerApproved sink).
  await runtime.submit(session.id, { text: 'route a mac task', origin: 'whatsapp', authority: cap });
  const card = (routeId) => ({ type: 'control_request', request_id: routeId, request: { subtype: 'route', kind: 'route', routeId, computer: { optionId: 's1' } } });
  let n = 0;
  for (const origin of ORIGINS) for (const fake of forged) {
    const routeId = `route-${++n}`;
    runtime.routerSend(session.id, card(routeId));
    assert.equal(runtime.routerComputerApproved(session.id, { routeId, origin, viaMailbox: false, authority: fake }), false, `in-turn: origin ${String(origin)}, authority ${String(fake)}`);
    runtime.routerSend(session.id, card(`${routeId}-m`));
    assert.equal(runtime.routerComputerApproved(session.id, { routeId: `${routeId}-m`, origin, viaMailbox: true, authority: fake }), false, `mailbox: origin ${String(origin)}`);
    assert.equal(live.computerRouteGrant, null);
    assert.equal(live.computerTurn.approved, false);
  }
  runtime.routerSend(session.id, card('route-ok'));
  assert.equal(runtime.routerComputerApproved(session.id, { routeId: 'route-ok', origin: 'whatsapp', viaMailbox: false, authority: cap }), true);
  assert.equal(live.computerTurn.approved, true);
  live.brain.finish();

  // 3. A turn that counts as started by a trusted plain message from the owner's phone (unasked at Autonomous).
  registry.registerSessionPolicy(session.id, { level: 'autonomous', autonomousUntil: until, computerUse: true });
  for (const origin of ['whatsapp', 'ui', 'api']) for (const fake of forged.slice(0, 5)) {
    await runtime.submit(session.id, { text: 'again', origin, authority: fake });
    assert.equal(await decide(), 'ask', `submit origin ${origin}, authority ${String(fake)}: not the phone, so it asks`);
    assert.equal(runtime.getComputerUse(session.id), false);
    live.brain.finish();
  }
  await runtime._internals.runQuery(live, { text: 'straight into the runtime', origin: 'whatsapp' });
  assert.equal(await decide(), 'ask', 'runQuery with the phone\'s origin string');
  live.brain.finish();
  await runtime.submit(session.id, { text: 'from the bridge', origin: 'whatsapp', authority: cap });
  assert.equal(await decide(), 'allow', 'the bridge\'s own submit');
  live.brain.finish();
  // …and never with untrusted content or a picture, capability or not.
  await runtime.submit(session.id, { text: 'forwarded', origin: 'whatsapp', authority: cap, untrusted: true });
  assert.equal(await decide(), 'ask');
  live.brain.finish();

  // A rebuilt bridge gets a fresh capability; the old one stops working at once. Revoked: nobody holds one.
  const next = authority.issue();
  assert.notEqual(next, cap);
  await runtime.submit(session.id, { text: 'old bridge', origin: 'whatsapp', authority: cap });
  assert.equal(await decide(), 'ask', 'the old capability is dead');
  live.brain.finish();
  await runtime.submit(session.id, { text: 'new bridge', origin: 'whatsapp', authority: next });
  assert.equal(await decide(), 'allow');
  live.brain.finish();
  authority.revoke();
  await runtime.submit(session.id, { text: 'no bridge', origin: 'whatsapp', authority: next });
  assert.equal(await decide(), 'ask');
  live.brain.finish();
  // Not serializable, and not reachable from the runtime's public object.
  assert.equal(typeof cap, 'symbol');
  assert.equal(JSON.stringify({ authority: cap }), '{}');
  assert.throws(() => structuredClone(cap));
  const reachable = [...Object.values(runtime), ...Object.values(runtime._internals), ...Object.values(runtime._internals.settings)];
  assert.equal(reachable.includes(authority.verify) || reachable.includes(authority.issue) || reachable.some((v) => typeof v === 'symbol'), false);
  assert.equal(JSON.stringify(live.record).includes('authority'), false);
});

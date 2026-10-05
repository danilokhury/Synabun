import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { createAssistantRuntime, normalizeBrain, DEFAULT_SESSION_TITLE, isDefaultSessionTitle, limitNotice } from '../lib/assistant-runtime.js';
import { createVirtualSocket } from '../lib/virtual-socket.js';
import { formatMailbox, buildAssistantPersona } from '../lib/assistant-persona.js';
import { createCodexMeter, createUsageLedger, usageLedgerPath } from '../lib/assistant-usage.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeBrainFactory(log) {
  return ({ session, sink, persona, hooks }) => {
    let busy = false;
    log.push(['create', session.brain.provider, persona.length > 100, !!hooks]);
    sink.send({ type: 'engine', engine: 'fake', brain: session.brain.provider });
    return {
      kind: session.brain.provider,
      async start() { log.push(['start']); },
      async sendUserTurn({ text }) {
        log.push(['turn', text]);
        busy = true;
        setTimeout(() => {
          sink.send({ type: 'event', event: { type: 'system', subtype: 'init', session_id: 'prov-1' } });
          sink.send({ type: 'event', event: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${text.slice(0, 40)}` }] } } });
          sink.send({ type: 'event', event: { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0.02 } });
          busy = false;
          sink.send({ type: 'done', code: 0 });
        }, 10);
      },
      async abort() { log.push(['abort']); busy = false; sink.send({ type: 'aborted' }); },
      async setPermissionMode(mode) { log.push(['mode', mode]); },
      respondControl(id, response) { log.push(['control', id, response]); },
      async compact() { log.push(['compact']); },
      isBusy: () => busy,
      identity: () => ({ providerSessionId: 'prov-1', accountId: session.brain.accountId }),
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

function harness(t, { dispatcher = null, memory = null, config = {}, metered = false, brainFactory = null, clarifier = null, now = null } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-assistant-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = [];
  const broadcasts = [];
  const factory = fakeBrainFactory(log);
  const usage = metered ? createUsageLedger({ dataDir: root }) : null;
  const runtime = createAssistantRuntime({
    dispatcher, dataDir: root, memory, usage, clarifier, broadcastSync: (m) => broadcasts.push(m), detectProject: () => 'proj', ...(now ? { now } : {}),
    buildCatalog: async () => ({ models: { codex: [{ id: 'gpt-5.4-mini' }] }, projects: [{ label: 'Synabun', path: '/tmp' }] }),
    brainFactories: { 'claude-code': brainFactory || factory, codex: brainFactory || factory, opencode: brainFactory || factory }, config: { mailboxBatchMs: 20, ...config },
  });
  t.after(() => runtime.shutdown());
  return { root, runtime, log, broadcasts, usage };
}

test('normalizeBrain applies provider defaults', () => {
  assert.equal(normalizeBrain({ provider: 'nope' }).provider, 'claude-code');
  assert.equal(normalizeBrain({ provider: 'claude-code' }).mcpProfile, 'full');
  assert.equal(normalizeBrain({ provider: 'opencode' }).accountId, null);
  assert.equal(normalizeBrain({ provider: 'codex', accountId: 'work', model: 'gpt-5.5' }).model, 'gpt-5.5');
});

test('persona and mailbox formatting include session id, tools and rails', () => {
  const persona = buildAssistantPersona({ assistantSessionId: 'assistant-x', brain: { provider: 'codex', model: 'gpt-5.5' }, toolPrefix: 'SynaBun_', hasAskUserQuestion: false, limits: { perProvider: { codex: 4 } } });
  assert.match(persona, /ASSISTANT_SESSION_ID: assistant-x/);
  assert.match(persona, /SynaBun_agent_dispatch/);
  assert.match(persona, /SynaBun_choice/);
  assert.match(persona, /codex=4/);
  const text = formatMailbox([{ kind: 'result', run: { runId: 'abcdef123456', provider: 'codex', title: 'Docs', outcome: 'done', costUsd: 0.5 }, summary: 'wrote docs', files: ['a.md'] }]);
  assert.match(text, /\[SynaBun Mailbox\] 1 event/);
  assert.match(text, /result · run abcdef12/);
  assert.match(text, /cost: \$0.50/);
});

test('sessions persist, brains start lazily, and packets flow to sockets with transcript logging', async (t) => {
  const { root, runtime, log, broadcasts } = harness(t);
  const session = await runtime.createSession({ brain: { provider: 'codex', model: 'gpt-5.4-mini' }, label: 'Ops', cwd: '/tmp' });
  assert.match(session.id, /^assistant-/);
  assert.equal(session.project, 'proj');
  assert.ok(existsSync(resolve(root, 'assistant-sessions.json')));
  assert.ok(broadcasts.some((m) => m.type === 'assistant:session-created'));
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` });
  assert.equal(ws.packets('reattach_result')[0].ok, true);
  assert.equal(log.length, 0, 'brain not created until the first query');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'Hello there assistant' })));
  await wait(60);
  assert.deepEqual(log[0].slice(0, 3), ['create', 'codex', true]);
  assert.ok(log.some((row) => row[0] === 'turn' && row[1] === 'Hello there assistant'));
  assert.ok(ws.packets('done').length === 1);
  assert.equal(ws.packets('engine')[0].brain, 'codex');
  assert.equal(runtime.getSession(session.id).providerSessionId, null, 'non-Claude brains keep provider ids from identity()');
  const stored = runtime.getSession(session.id);
  assert.equal(stored.costUsd, 0.02);
  assert.equal(stored.title, 'Ops', 'explicit labels are never overwritten by the first prompt');
  assert.ok(stored.transcript.some((entry) => entry.packet.event?.type === 'synabun.user_prompt'));
  assert.ok(stored.transcript.some((entry) => entry.packet.event?.type === 'assistant'));
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'set_permission_mode', mode: 'bypassPermissions' })));
  await wait(5);
  assert.ok(log.some((row) => row[0] === 'mode' && row[1] === 'bypassPermissions'));
  assert.equal(runtime.getSession(session.id).brain.permissionMode, 'bypassPermissions');
  // Detached period buffers packets and replays them on reattach.
  ws.close();
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'ignored after close' })));
  const internals = runtime._internals.sessions.get(session.id);
  await internals.brain.sendUserTurn({ text: 'background turn' });
  await wait(40);
  assert.ok(internals.buffer.length > 0);
  const ws2 = new FakeWs();
  await runtime.handleWebSocket(ws2, { pathname: `/ws/assistant/${session.id}` });
  assert.ok(ws2.packets('reattach_result')[0].replayed > 0);
  assert.ok(ws2.packets('done').length >= 1);
  // Brain switch disposes the current brain and resets provider ids.
  ws2.emit('message', Buffer.from(JSON.stringify({ type: 'switch_brain', brain: 'opencode' })));
  await wait(10);
  assert.ok(log.some((row) => row[0] === 'dispose'));
  assert.equal(runtime.getSession(session.id).brain.provider, 'opencode');
  await runtime.closeSession(session.id);
  assert.equal(runtime.getSession(session.id).status, 'ended');
  const index = JSON.parse(readFileSync(resolve(root, 'assistant-sessions.json'), 'utf8'));
  assert.equal(index[0].id, session.id);
});

test('recall prefixes non-Claude turns and the mailbox delivers dispatch events as a synthetic turn', async (t) => {
  const listeners = new Set();
  const dispatcher = {
    limits: {},
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    totals: () => ({ costUsd: 0.1 }),
    get: (runId) => ({ runId, provider: 'codex', title: 'Docs' }),
    respondPermission(runId, requestId, response, opts) { listeners.__last = [runId, requestId, response, opts]; return {}; },
  };
  const recalls = [];
  const memory = { recallForPrompt: async (args) => { recalls.push(args); return { block: '=== SynaBun: Related Memories ===\n[m1] X\n=== End Memories ===', results: [{ id: 'm1' }], alreadyPresent: false }; } };
  const { runtime, log } = harness(t, { dispatcher, memory });
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` });
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'How do the hooks work in this repo?' })));
  await wait(60);
  assert.equal(recalls[0].session, session.id);
  const turn = log.find((row) => row[0] === 'turn');
  assert.match(turn[1], /^=== SynaBun: Related Memories ===/);
  assert.ok(ws.sent.some((p) => p.type === 'event' && p.event.type === 'synabun.memories'));
  const run = { runId: 'run-9', assistantSessionId: session.id, provider: 'codex', title: 'Docs', outcome: 'done', memoryStored: false, lastResult: { summary: 'wrote docs', files: ['a.md'], follow_ups: [] }, costUsd: 0.01 };
  for (const listener of listeners) listener({ type: 'assistant:dispatch', reason: 'turn_completed', run });
  await wait(80);
  const mailboxTurn = log.filter((row) => row[0] === 'turn').at(-1);
  assert.match(mailboxTurn[1], /\[SynaBun Mailbox\] 1 event/);
  assert.ok(ws.sent.some((p) => p.type === 'assistant:dispatch' && p.run.runId === 'run-9'));
  assert.ok(ws.sent.some((p) => p.type === 'event' && p.event.type === 'synabun.mailbox'));
  await wait(60);
  const nudge = log.filter((row) => row[0] === 'turn').at(-1);
  assert.match(nudge[1], /memory_due/, 'non-Claude brains get one memory nudge for an unstored run');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'dispatch_control_response', runId: 'run-9', request_id: 'perm-1', response: { behavior: 'allow' } })));
  await wait(5);
  assert.deepEqual(listeners.__last.slice(0, 2), ['run-9', 'perm-1']);
  assert.equal(listeners.__last[3].origin, 'user');
});

test('removing a finished run clears its queued mailbox items and memory reminder', async (t) => {
  const listeners = new Set();
  const dispatcher = {
    limits: {},
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    totals: () => ({ costUsd: 0 }),
  };
  const { runtime, log } = harness(t, { dispatcher });
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const live = runtime._internals.sessions.get(session.id);
  runtime.noteDispatch(session.id, 'old-run');
  live.obligations.add('old-run');
  live.obligations.add('other-run');
  live.nudgedRuns.add('old-run');
  live.mailbox.push({ kind: 'result', run: { runId: 'old-run' } });
  live.mailbox.push({ kind: 'memory_due', run: { runId: 'old-run' } });
  live.mailbox.push({ kind: 'result', run: { runId: 'other-run' } });
  for (const listener of listeners) listener({ type: 'assistant:run-removed', assistantSessionId: session.id, runIds: ['old-run'] });
  assert.deepEqual(live.mailbox.map((item) => item.run.runId), ['other-run']);
  assert.deepEqual([...live.obligations], ['other-run']);
  assert.equal(live.nudgedRuns.has('old-run'), false);
  assert.deepEqual(runtime.getSession(session.id).dispatchRunIds, ['old-run'], 'history remains for accounting');

  live.mailbox.length = 0;
  runtime._internals.enqueueMailbox(live, { kind: 'memory_due', run: { runId: 'old-run' } });
  assert.ok(live.mailboxTimer);
  for (const listener of listeners) listener({ type: 'assistant:run-removed', assistantSessionId: session.id, runIds: ['old-run'] });
  assert.equal(live.mailboxTimer, null);
  await wait(40);
  assert.equal(log.some((row) => row[0] === 'turn'), false, 'a removed reminder does not start a brain turn');
});

test('an ended session reopens after a restart: transcript kept, attaching revives it, the next turn resumes its own conversation', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-assistant-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = [];
  const base = fakeBrainFactory(log);
  const started = [];
  // Codex brains report their thread through identity(); Claude brains through the init event.
  const factory = (args) => {
    const { brain, providerSessionId, providerThreadId } = args.session;
    started.push({ provider: brain.provider, model: brain.model, providerSessionId, providerThreadId });
    const created = base(args);
    if (brain.provider === 'codex') created.identity = () => ({ providerSessionId: 'thread-1', providerThreadId: 'thread-1' });
    return created;
  };
  const make = () => {
    const runtime = createAssistantRuntime({ dataDir: root, detectProject: () => 'proj', brainFactories: { 'claude-code': factory, codex: factory, opencode: factory }, config: { mailboxBatchMs: 20 } });
    t.after(() => runtime.shutdown());
    return runtime;
  };
  const first = make();
  const brains = [{ provider: 'claude-code', model: 'claude-fable-5-1[1m]' }, { provider: 'codex', model: 'gpt-6-sol[extended]' }];
  const ids = [];
  for (const brain of brains) {
    const session = await first.createSession({ brain, cwd: '/tmp' });
    const ws = new FakeWs();
    await first.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` });
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: `First question for ${brain.provider}` })));
    await wait(60);
    ws.close();
    await first.closeSession(session.id);
    ids.push(session.id);
  }
  // A restart: the index still lists them (Sessions → Recent), ended, with their resume ids.
  const second = make();
  const [claude, codex] = ids.map((id) => second.getSession(id));
  assert.deepEqual([claude.status, codex.status], ['ended', 'ended']);
  assert.equal(claude.providerSessionId, 'prov-1');
  assert.equal(codex.providerThreadId, 'thread-1');
  started.length = 0;
  for (const [i, id] of ids.entries()) {
    assert.ok(second.getSession(id).transcript.some((entry) => entry.packet.event?.text === `First question for ${brains[i].provider}`), 'the transcript is still there');
    const ws = new FakeWs();
    await second.handleWebSocket(ws, { pathname: `/ws/assistant/${id}` });
    assert.equal(second.getSession(id).status, 'idle', 'attaching revives it');
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'And a follow-up' })));
    await wait(60);
    assert.equal(ws.packets('done').length, 1, 'the follow-up ran');
  }
  assert.deepEqual(started, [
    { provider: 'claude-code', model: 'claude-fable-5-1[1m]', providerSessionId: 'prov-1', providerThreadId: null },
    { provider: 'codex', model: 'gpt-6-sol[extended]', providerSessionId: 'thread-1', providerThreadId: 'thread-1' },
  ], 'each brain restarts on its own model with the stored Claude session / Codex thread');
});

test('virtual socket round-trips messages and close events', () => {
  const sent = [];
  const socket = createVirtualSocket({ onSend: (packet) => sent.push(packet) });
  const received = [];
  socket.on('message', (raw) => received.push(JSON.parse(raw.toString())));
  socket.send(JSON.stringify({ type: 'hello' }));
  socket.receive({ type: 'query', prompt: 'x' });
  let closed = false;
  socket.on('close', () => { closed = true; });
  socket.close();
  assert.deepEqual(sent, [{ type: 'hello' }]);
  assert.deepEqual(received, [{ type: 'query', prompt: 'x' }]);
  assert.equal(closed, true);
  assert.equal(socket.readyState, 3);
});

test('sessions are called SynaBun; the first prompt names them (legacy "Assistant N" too)', async (t) => {
  assert.equal(DEFAULT_SESSION_TITLE, 'SynaBun');
  for (const title of ['', 'SynaBun', 'Assistant', 'Assistant 12']) assert.equal(isDefaultSessionTitle(title), true, title);
  for (const title of ['SynaBun notes', 'Ops', 'assistant 3']) assert.equal(isDefaultSessionTitle(title), false, title);
  const { runtime, broadcasts } = harness(t);
  const a = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const b = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  assert.equal(a.title, 'SynaBun');
  assert.equal(b.title, 'SynaBun', 'no running number');
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${a.id}` });
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'Fix the login test\nwith details' })));
  await wait(60);
  assert.equal(runtime.getSession(a.id).title, 'Fix the login test', 'the history list shows the first prompt');
  assert.ok(broadcasts.some((m) => m.type === 'assistant:session-updated' && m.session?.title === 'Fix the login test'));
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'Second question' })));
  await wait(60);
  assert.equal(runtime.getSession(a.id).title, 'Fix the login test', 'only the first prompt names it');
  await runtime.updateSession(b.id, { title: 'Assistant 7' });
  const ws2 = new FakeWs();
  await runtime.handleWebSocket(ws2, { pathname: `/ws/assistant/${b.id}` });
  ws2.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'Legacy prompt' })));
  await wait(60);
  assert.equal(runtime.getSession(b.id).title, 'Legacy prompt', 'legacy numbered titles are retitled too');
});

// Mailbox dedupe: a result the brain already read (agent_wait / agent_read / agent_status) is not delivered again.
function deliveryHarness(t) {
  const listeners = new Set();
  const marks = new Map();
  const dispatcher = {
    limits: {},
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    totals: () => ({ costUsd: 0 }),
    get: (runId) => ({ runId, provider: 'codex', title: 'Docs' }),
    deliveryState: (runId) => marks.get(runId) || null,
  };
  const log = [];
  const gates = [];
  const factory = ({ session, sink }) => {
    let busy = false;
    return {
      kind: session.brain.provider,
      async start() {},
      async sendUserTurn({ text }) {
        log.push(['turn', text]);
        busy = true;
        // Held until the test releases it: the brain is mid-turn meanwhile.
        gates.push(() => { busy = false; sink.send({ type: 'done', code: 0 }); });
      },
      isBusy: () => busy,
      identity: () => ({}),
      async dispose() {},
    };
  };
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-assistant-delivery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = createAssistantRuntime({
    dispatcher, dataDir: root, detectProject: () => 'proj', buildCatalog: async () => ({}),
    brainFactories: { 'claude-code': factory, codex: factory, opencode: factory }, config: { mailboxBatchMs: 40 },
  });
  t.after(() => runtime.shutdown());
  const emit = (payload) => { for (const listener of listeners) listener({ type: 'assistant:dispatch', ...payload }); };
  const release = () => { const gate = gates.shift(); gate?.(); };
  return { runtime, log, marks, emit, release, gates };
}
const resultRun = (sessionId, extra = {}) => ({ runId: 'run-d1', assistantSessionId: sessionId, provider: 'codex', title: 'Docs', outcome: 'done', memoryStored: true, lastResult: { status: 'done', summary: 'wrote docs', files: [], follow_ups: [] }, ...extra });
const mailboxTurns = (log) => log.filter((row) => row[0] === 'turn' && /\[SynaBun Mailbox\]/.test(row[1]));

test('mailbox dedupe: a result read inside the batch window, or before it was queued, is never a second turn', async (t) => {
  const { runtime, log, marks, emit } = deliveryHarness(t);
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const internals = runtime._internals.sessions.get(session.id);
  await runtime._internals.ensureBrain(internals);
  // Read inside the 40 ms batch window (agent_wait answered right after the event).
  emit({ reason: 'turn_completed', turn: 1, run: resultRun(session.id) });
  assert.equal(internals.mailbox.length, 1);
  marks.set('run-d1', { turn: 1, state: 'idle', via: 'agent_wait' });
  await wait(90);
  assert.equal(mailboxTurns(log).length, 0, 'no mailbox turn for a result the brain already read');
  assert.equal(internals.mailbox.length, 0);
  // Read before the event reached the runtime: dropped at queue time.
  emit({ reason: 'needs_input', turn: 1, run: resultRun(session.id, { lastResult: { status: 'needs_input', question: 'which?' } }) });
  assert.equal(internals.mailbox.length, 0, 'dropped at queue time');
  // A follow-up turn is news even after the first turn was read.
  emit({ reason: 'turn_completed', turn: 2, run: resultRun(session.id) });
  await wait(90);
  assert.equal(mailboxTurns(log).length, 1, 'turn 2 is delivered after a turn-1 read');
  assert.match(mailboxTurns(log)[0][1], /result · run run-d1/);
  // Kinds other than result / needs_input are always delivered.
  emit({ reason: 'stalled', turn: 1, run: resultRun(session.id) });
  assert.equal(internals.mailbox.length, 1);
});

test('mailbox dedupe: a result read while the brain was busy is dropped when the turn ends', async (t) => {
  const { runtime, log, marks, emit, release } = deliveryHarness(t);
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` });
  // The brain's own turn dispatches, then blocks in agent_wait.
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'Dispatch the docs task and wait for it' })));
  await wait(20);
  assert.equal(log.length, 1);
  emit({ reason: 'turn_completed', turn: 1, run: resultRun(session.id) });
  await wait(90);
  assert.equal(mailboxTurns(log).length, 0, 'held while the brain is busy');
  marks.set('run-d1', { turn: 1, state: 'idle', via: 'agent_wait' });
  release();
  await wait(90);
  assert.equal(mailboxTurns(log).length, 0, 'the wait already delivered it');
  assert.equal(ws.sent.filter((p) => p.type === 'event' && p.event?.type === 'synabun.mailbox').length, 0, 'no synabun.mailbox event either');
});

test('Claude brains record each turn for the in-process recall hook: describeTurn matches once, capped at 8', async (t) => {
  let hookCtx = null;
  const memory = { claudeHooks: (ctx) => { hookCtx = ctx; return {}; } };
  const { runtime } = harness(t, { memory });
  const session = await runtime.createSession({ brain: { provider: 'claude-code' }, cwd: '/tmp' });
  const internals = runtime._internals.sessions.get(session.id);
  await runtime._internals.runQuery(internals, { text: 'How do the hooks load?' });
  assert.equal(typeof hookCtx?.describeTurn, 'function');
  assert.deepEqual(hookCtx.describeTurn('How do the hooks load?'), { system: false, prompt: 'How do the hooks load?' });
  assert.equal(hookCtx.describeTurn('How do the hooks load?'), null, 'used once');
  await runtime._internals.runQuery(internals, { text: '[SynaBun Mailbox] 1 event', system: true });
  assert.deepEqual(hookCtx.describeTurn('[SynaBun Mailbox] 1 event'), { system: true, prompt: null });
  // One pending turn whose prompt the hook's text contains (wrappers added on the way).
  await runtime._internals.runQuery(internals, { text: 'Fix the login test' });
  assert.deepEqual(hookCtx.describeTurn('<system-reminder>x</system-reminder>\nFix the login test'), { system: false, prompt: 'Fix the login test' });
  assert.equal(hookCtx.describeTurn('Something the CLI started itself'), null);
  for (let i = 0; i < 12; i += 1) await runtime._internals.runQuery(internals, { text: `Prompt number ${i}` });
  assert.equal(internals.turnMeta.size, 8);
  assert.equal(hookCtx.describeTurn('Prompt number 0'), null, 'the oldest were dropped');
  assert.deepEqual(hookCtx.describeTurn('Prompt number 11'), { system: false, prompt: 'Prompt number 11' });
});

test('mailbox lines: retry, no escalation, escalate with its cause, unverified claim and a status read by Jev; the persona says how to act', async (t) => {
  const run = (escalation, extra = {}) => ({ runId: 'abcdef123456', provider: 'codex', model: 'gpt-5.4-mini', title: 'Docs', outcome: 'blocked', escalation, ...extra });
  const text = formatMailbox([
    { kind: 'failed', run: run({ reason: 'failed', cause: 'transient', kind: 'retry', to: { provider: 'codex', model: 'gpt-5.4-mini' } }) },
    { kind: 'result', run: run({ reason: 'blocked', cause: 'access', kind: 'none', to: null, needs: 'an npm token with publish rights' }) },
    { kind: 'result', run: run({ reason: 'blocked', cause: 'needs_user', kind: 'none', to: null, needs: null }) },
    { kind: 'result', run: run({ reason: 'blocked', cause: 'capability', kind: 'escalate', to: { provider: 'codex', model: 'gpt-5.5', tier: 'large' } }) },
    { kind: 'result', run: run(null, { outcome: 'done' }), unverified: 'the last `npm test` exited with an error', resultSource: 'jev' },
    { kind: 'failed', run: run({ reason: 'failed', from: {}, to: { provider: 'claude-code', model: 'opus' }, depth: 1 }) },
  ]);
  assert.match(text, /retry → codex\/gpt-5\.4-mini \[transient\]/);
  assert.match(text, /no escalation \(needs access\): an npm token with publish rights/);
  assert.match(text, /no escalation \(needs the user\)(?!:)/);
  assert.match(text, /escalate → codex\/gpt-5\.5 \(large\) \[blocked · capability\]/);
  assert.match(text, /unverified claim: the last `npm test` exited with an error — verify before reporting success/);
  assert.match(text, /status read by Jev \(no ## Result block\)/);
  assert.match(text, /escalate → claude-code\/opus \[failed\]/, 'an escalation from before causes reads as before');
  const persona = buildAssistantPersona({ assistantSessionId: 'assistant-x', brain: { provider: 'codex' }, toolPrefix: 'SynaBun_' });
  assert.match(persona, /"retry → provider\/model \[transient\]" means the run hit a temporary failure/);
  assert.match(persona, /"no escalation \(needs access \| needs the user\): …" means a stronger model would hit the same wall/);
  assert.match(persona, /"unverified claim: … — verify before reporting success" means the worker said done/);

  // The runtime copies the judged fields onto result items.
  const { runtime, log, emit } = deliveryHarness(t);
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  await runtime._internals.ensureBrain(runtime._internals.sessions.get(session.id));
  emit({ reason: 'turn_completed', turn: 3, run: resultRun(session.id, { lastResult: { status: 'done', summary: 'tests pass', found: false, source: 'jev', unverifiedClaim: { probability: 0.96, evidence: 'no test/build command ran this turn' } } }) });
  const [item] = runtime._internals.sessions.get(session.id).mailbox;
  assert.equal(item.turn, 3);
  assert.equal(item.unverified, 'no test/build command ran this turn');
  assert.equal(item.resultSource, 'jev');
  await wait(90);
  assert.match(mailboxTurns(log)[0][1], /unverified claim: no test\/build command ran this turn — verify before reporting success · status read by Jev/);
});

// ── 2026-09-27 stall: bounded approval waits, memory reminders for stored runs ──
test('an unanswered brain approval is declined after its timeout and the card closes; answered ones never are', async (t) => {
  // 30 ms for approvals, 150 ms for questions.
  const { runtime, log } = harness(t, { config: { approvalTimeoutMinutes: 0.0005, questionTimeoutMinutes: 0.0025 } });
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` });
  const live = runtime._internals.sessions.get(session.id);
  await runtime._internals.ensureBrain(live);
  const approval = (id, extra = {}) => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', provider: 'codex', kind: 'permission', tool_name: 'Bash', method: 'item/commandExecution/requestApproval', input: { command: 'node --test tests/assistant-api.test.mjs' }, ...extra } });
  runtime._internals.onBrainPacket(live, approval('0'));
  runtime._internals.onBrainPacket(live, approval('1'));
  runtime._internals.onBrainPacket(live, approval('2', { kind: 'question', tool_name: 'AskUserQuestion' }));
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'control_response', request_id: '1', response: { behavior: 'allow' } })));
  await wait(80);
  const controls = log.filter((row) => row[0] === 'control');
  assert.deepEqual(controls.map((row) => [row[1], row[2].behavior]), [['1', 'allow'], ['0', 'deny']], 'the unanswered approval is declined once; the answered one is left alone');
  assert.match(controls[1][2].message, /No decision within 1 minute/);
  assert.deepEqual(ws.packets('control_cancelled').map((p) => [p.request_id, p.reason]), [['0', 'timeout']]);
  assert.ok(live.pendingControls.has('2'), 'a question waits longer than an approval');
  await wait(150);
  assert.deepEqual(log.filter((row) => row[0] === 'control').map((row) => row[1]), ['1', '0', '2']);
  assert.equal(live.pendingControls.size, 0);
  assert.equal(live.controlTimers.size, 0);
});

test('a run whose memory exists by the time the turn ends gets no memory_due (worker or Codex brain remember)', async (t) => {
  const listeners = new Set();
  const stored = new Set();
  const dispatcher = {
    limits: {},
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    totals: () => ({ costUsd: 0 }),
    // dispatcher.get re-reads the run's memory (source_ref = run id).
    get: (runId) => ({ runId, provider: 'claude-code', title: 'Fix', memoryStored: stored.has(runId) }),
  };
  const { runtime, log } = harness(t, { dispatcher });
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` });
  const run = { runId: 'run-7', assistantSessionId: session.id, provider: 'claude-code', title: 'Fix', outcome: 'done', memoryStored: false, lastResult: { summary: 'fixed', files: [], follow_ups: [] }, costUsd: 1 };
  for (const listener of listeners) listener({ type: 'assistant:dispatch', reason: 'turn_completed', run });
  stored.add('run-7');
  await wait(150);
  const turns = log.filter((row) => row[0] === 'turn').map((row) => row[1]);
  assert.ok(turns.some((text) => /\[SynaBun Mailbox\] 1 event/.test(text)), 'the result is still delivered');
  assert.ok(!turns.some((text) => /memory_due/.test(text)), 'no reminder for a run whose memory exists');
  assert.equal(runtime._internals.sessions.get(session.id).obligations.size, 0);
});

test('runQuery reports every refusal as a result, with the error packet the panel always got', async (t) => {
  const { runtime } = harness(t);
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` });
  const live = runtime._internals.sessions.get(session.id);
  assert.deepEqual(await runtime._internals.runQuery(live, { text: '' }), { ok: false, code: 'EMPTY_PROMPT', message: 'No prompt provided' });
  assert.deepEqual(ws.packets('error').at(-1), { type: 'error', message: 'No prompt provided' });
  assert.deepEqual(await runtime._internals.runQuery(live, { text: 'go' }), { ok: true });
  assert.equal(live.turnPending, 0, 'the busy counter is released');
  await wait(40);
  // The panel path passes origin 'ui': nothing is echoed back live.
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'from the panel' })));
  await wait(40);
  assert.equal(ws.sent.filter((p) => p.type === 'event' && p.event?.type === 'synabun.user_prompt').length, 0);
});

test('an answer from one window closes the card in the others (control_resolved)', async (t) => {
  const { runtime, log } = harness(t);
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const first = new FakeWs();
  const second = new FakeWs();
  await runtime.handleWebSocket(first, { pathname: `/ws/assistant/${session.id}` });
  await runtime.handleWebSocket(second, { pathname: `/ws/assistant/${session.id}` });
  const live = runtime._internals.sessions.get(session.id);
  await runtime._internals.ensureBrain(live);
  runtime._internals.onBrainPacket(live, { type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  first.emit('message', Buffer.from(JSON.stringify({ type: 'control_response', request_id: 'req-1', response: { behavior: 'allow' } })));
  await wait(5);
  assert.deepEqual(log.filter((row) => row[0] === 'control').map((row) => row[1]), ['req-1']);
  assert.deepEqual(second.packets('control_resolved'), [{ type: 'control_resolved', request_id: 'req-1', origin: 'ui' }]);
  // Answered twice: the second never reaches the brain.
  second.emit('message', Buffer.from(JSON.stringify({ type: 'control_response', request_id: 'req-1', response: { behavior: 'deny' } })));
  await wait(5);
  assert.equal(log.filter((row) => row[0] === 'control').length, 1);
});

test('Claude brain usage follows prompt tasks and resumes its saved model baseline', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-brain-meter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const usage = createUsageLedger({ dataDir: root });
  let results = 0;
  let prompts = 0;
  const factory = ({ sink }) => ({
    async start() {},
    async sendUserTurn() {
      results += 1;
      const modelUsage = { 'claude-test': { inputTokens: results * 15, outputTokens: results * 15, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: results * 0.03 } };
      sink.send({ type: 'event', event: { type: 'system', subtype: 'init', session_id: 'provider-1' } });
      sink.send({ type: 'event', event: { type: 'result', uuid: `r${results}`, session_id: 'provider-1', usage: { input_tokens: 10, output_tokens: 10 }, modelUsage, total_cost_usd: results * 0.03 } });
      sink.send({ type: 'done', code: 0 });
    },
    identity: () => ({ providerSessionId: 'provider-1' }),
    async dispose() {},
  });
  const options = { dataDir: root, usage, brainFactories: { 'claude-code': factory }, clarifier: { onUserPrompt() { prompts += 1; return prompts === 2 ? { note: 'answer recorded' } : null; } } };
  const first = createAssistantRuntime(options);
  const session = await first.createSession({ cwd: '/tmp' });
  await first.submit(session.id, { text: 'Build this\nwith context' });
  assert.equal(first.currentTask(session.id), 'task-1');
  await first.submit(session.id, { text: 'Clarifying answer' });
  assert.equal(first.currentTask(session.id), 'task-1');
  assert.equal(first.usageView(session.id).task.tokens.total, 60);
  assert.equal(first.usageView(session.id).task.agents[0].subagents.total, 20);
  assert.equal(first.usageView(session.id).task.title, 'Build this');
  first._internals.onBrainPacket(first._internals.sessions.get(session.id), { type: 'event', event: { type: 'result', brain: 'codex', usage: { input_tokens: 999 }, uuid: 'foreign' } });
  assert.equal(first.usageView(session.id).task.tokens.total, 60, 'a synthetic result cannot reach the Claude meter');
  assert.equal(first.getSession(session.id).usageState, undefined);
  await first.shutdown();
  const saved = JSON.parse(readFileSync(resolve(root, 'assistant-sessions.json'), 'utf8'))[0];
  assert.equal(saved.taskId, 'task-1');
  assert.ok(saved.usageState.claude.snapshot);
  const second = createAssistantRuntime({ dataDir: root, usage: createUsageLedger({ dataDir: root }), brainFactories: { 'claude-code': factory } });
  t.after(() => second.shutdown());
  await second.submit(session.id, { text: 'Next job' });
  assert.equal(second.currentTask(session.id), 'task-2');
  assert.equal(second.usageView(session.id).task.tokens.total, 30);
  assert.equal(second.usageView(session.id).session.tokens.total, 90);
});

test('a mailbox turn names only its own turn task; usage packets decorate agents and throttle', async (t) => {
  let runtime;
  const seen = [];
  const factory = ({ sink }) => ({
    async start() {},
    async sendUserTurn({ text }) {
      const turnTask = runtime.currentTask(session.id);
      seen.push([text, turnTask, runtime.usageView(session.id, turnTask).task.live, runtime.usageView(session.id).task.id]);
      sink.send({ type: 'done', code: 0 });
    },
    async dispose() {},
  });
  const dispatcher = { totals: () => ({ costUsd: 0 }), get: (id) => ({ runId: id, title: 'Worker', state: 'completed' }) };
  const bundle = harness(t, { dispatcher, metered: true, brainFactory: factory });
  runtime = bundle.runtime;
  const { usage } = bundle;
  const session = await runtime.createSession({ cwd: '/tmp' });
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` });
  assert.equal(ws.packets('assistant:usage').length, 1);
  await runtime.submit(session.id, { text: 'First' });
  await runtime.submit(session.id, { text: 'Second' });
  usage.settle({ sessionId: session.id, taskId: 'task-1', scope: 'run', runId: 'run-1', provider: 'codex', model: 'gpt', tokens: { input: 3 } });
  const live = runtime._internals.sessions.get(session.id);
  runtime._internals.enqueueMailbox(live, { kind: 'result', run: { runId: 'run-1', turns: [{ n: 1, taskId: 'task-1' }] }, turn: 1 });
  await runtime._internals.deliverMailbox(live);
  assert.match(seen.at(-1)[0], /SynaBun Mailbox/);
  assert.equal(seen.at(-1)[1], 'task-1', 'while it runs, the mailbox turn works for its run\'s task');
  assert.equal(seen.at(-1)[2], true);
  assert.equal(seen.at(-1)[3], 'task-2', 'the current view stays on the latest human task');
  // The system turn is over: the session's task is the latest human one again.
  assert.equal(runtime.currentTask(session.id), 'task-2');
  assert.equal(live.record.taskId, 'task-2');
  assert.equal(runtime.usageView(session.id).task.id, 'task-2');
  const agent = runtime.usageView(session.id, 'task-1').task.agents.find((row) => row.key === 'run-1');
  assert.equal(agent.title, 'Worker');
  assert.equal(agent.state, 'done');
  const before = ws.packets('assistant:usage').length;
  usage.setPending(session.id, 'brain', { taskId: 'task-1', scope: 'brain', provider: 'claude-code', tokens: { input: 1 } });
  usage.setPending(session.id, 'brain', { taskId: 'task-1', scope: 'brain', provider: 'claude-code', tokens: { input: 2 } });
  assert.equal(ws.packets('assistant:usage').length, before);
  await wait(280);
  assert.equal(ws.packets('assistant:usage').length, before + 1);
  const file = usageLedgerPath(bundle.root, session.id);
  assert.ok(existsSync(file));
  await runtime.destroySession(session.id);
  assert.equal(existsSync(file), false);
});

test('a saved Claude session without a meter baseline records a partial turn', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-no-baseline-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const factory = ({ sink }) => ({
    async start() {},
    async sendUserTurn() {
      sink.send({ type: 'event', event: { type: 'system', subtype: 'init', session_id: 'old-provider' } });
      sink.send({ type: 'event', event: { type: 'result', uuid: 'new-result', session_id: 'old-provider', usage: { input_tokens: 4, output_tokens: 6 }, modelUsage: { 'claude-test': { inputTokens: 104, outputTokens: 106, costUSD: 1 } } } });
      sink.send({ type: 'done', code: 0 });
    },
    async dispose() {},
  });
  const old = createAssistantRuntime({ dataDir: root, brainFactories: { 'claude-code': factory } });
  const session = await old.createSession({ cwd: '/tmp' });
  await old.submit(session.id, { text: 'Old turn' });
  await old.shutdown();
  const runtime = createAssistantRuntime({ dataDir: root, usage: createUsageLedger({ dataDir: root }), brainFactories: { 'claude-code': factory } });
  t.after(() => runtime.shutdown());
  await runtime.submit(session.id, { text: 'New turn' });
  const task = runtime.usageView(session.id).task;
  assert.equal(task.tokens.total, 10);
  assert.equal(task.fidelity, 'partial');
  assert.equal(task.agents[0].partialReason, 'no-baseline');
});

test('Codex brain polls a temp rollout and prices raw usage', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-codex-brain-meter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = resolve(root, 'codex-home');
  const threadId = '01a00000-0000-7000-8000-000000000011';
  const stamp = new Date();
  const day = resolve(home, 'sessions', String(stamp.getFullYear()), String(stamp.getMonth() + 1).padStart(2, '0'), String(stamp.getDate()).padStart(2, '0'));
  mkdirSync(day, { recursive: true });
  const factory = ({ sink, deps }) => ({
    async start() {},
    async sendUserTurn() { deps.onCodexThread(threadId); sink.send({ type: 'event', event: { type: 'result', brain: 'codex' } }); sink.send({ type: 'done', code: 0 }); },
    identity: () => ({ providerThreadId: threadId }),
    async dispose() {},
  });
  const runtime = createAssistantRuntime({ dataDir: root, usage: createUsageLedger({ dataDir: root }), codexHomeForAccount: () => home, pricing: { codexPrice: () => ({ input: 1, cacheRead: 0.5, output: 2 }) }, brainFactories: { codex: factory } });
  t.after(() => runtime.shutdown());
  const session = await runtime.createSession({ brain: { provider: 'codex', model: 'gpt-test' }, cwd: '/tmp' });
  const usage = { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 110 };
  const lines = [
    { type: 'session_meta', payload: { id: threadId, session_id: threadId } },
    { type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-test' } },
    { type: 'token_usage_record', payload: { thread_id: threadId, session_id: threadId, turn_id: 'turn-1', root_turn_id: 'turn-1', response_id: 'response-1', usage } },
  ].map((row) => JSON.stringify({ timestamp: new Date().toISOString(), ...row })).join('\n') + '\n';
  writeFileSync(resolve(day, `rollout-${stamp.toISOString().replace(/[:.]/g, '-')}-${threadId}.jsonl`), lines);
  await runtime.submit(session.id, { text: 'Count rollout' });
  const task = runtime.usageView(session.id).task;
  assert.equal(task.tokens.total, 110);
  assert.equal(task.agents[0].provider, 'codex');
  assert.ok(task.costUsd > 0);
});

test('OpenCode brain settles root and child session tokens after reconciliation', async (t) => {
  const factory = ({ sink, deps }) => ({
    async start() { deps.onOpenCodeRoot('root'); },
    async sendUserTurn() {
      deps.onOpenCodeEvent('message.updated', { info: { id: 'main-1', sessionID: 'root', role: 'assistant', modelID: 'model', tokens: { input: 4, output: 2 }, cost: 0.01 } });
      deps.onOpenCodeEvent('session.created', { info: { id: 'child' } });
      deps.onOpenCodeEvent('message.updated', { info: { id: 'child-1', sessionID: 'child', role: 'assistant', modelID: 'model', tokens: { input: 8, output: 3 }, cost: 0.02 } });
      sink.send({ type: 'event', event: { type: 'result', brain: 'opencode' } });
      sink.send({ type: 'done', code: 0 });
    },
    async reconcileUsage(meter) { await meter.reconcile({ children: async (id) => id === 'root' ? ['child'] : [], messages: async () => [] }); return true; },
    async dispose() {},
  });
  const { runtime } = harness(t, { metered: true, brainFactory: factory });
  const session = await runtime.createSession({ brain: { provider: 'opencode' }, cwd: '/tmp' });
  await runtime.submit(session.id, { text: 'Use child' });
  await runtime._internals.sessions.get(session.id).openCodeFinalizing;
  const task = runtime.usageView(session.id).task;
  assert.equal(task.tokens.total, 17);
  assert.equal(task.agents[0].subagents.total, 11);
  assert.equal(task.costUsd, 0.03);
  assert.equal(task.fidelity, 'exact');
});

// ── exact token accounting: review fixes ─────────────────────────────────────

/** A metered runtime on a temp dir; `usage` and `log` are the ledger and the log lines it wrote. */
function meteredRuntime(t, { usage, ...options } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-assistant-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = [];
  const ledger = usage === undefined ? createUsageLedger({ dataDir: root }) : typeof usage === 'function' ? usage(root) : usage;
  const runtime = createAssistantRuntime({ dataDir: root, usage: ledger, log: (tag, message) => log.push([tag, message]), config: { mailboxBatchMs: 20 }, ...options });
  t.after(() => runtime.shutdown());
  return { root, runtime, usage: ledger, log };
}

/** A brain of any provider: every turn feeds its provider's usage hooks, reports a running dollar total and ends. */
function scriptedBrain({ sink, deps, session }) {
  const provider = session.brain.provider;
  let turns = 0;
  return {
    async start() { if (provider === 'opencode') deps.onOpenCodeRoot('root'); },
    async sendUserTurn() {
      turns += 1;
      if (provider === 'claude-code') sink.send({ type: 'event', event: { type: 'assistant', message: { id: `msg-${turns}`, model: 'claude-test', usage: { input_tokens: 5, output_tokens: 1 } } } });
      if (provider === 'codex') { deps.onCodexThread('thread-1'); deps.onCodexUsage(); }
      if (provider === 'opencode') deps.onOpenCodeEvent('message.updated', { info: { id: `msg-${turns}`, sessionID: 'root', role: 'assistant', modelID: 'model', tokens: { input: 4, output: 2 }, cost: 0.01 } });
      sink.send({ type: 'event', event: {
        type: 'result', subtype: 'success', uuid: `result-${turns}`, usage: { input_tokens: 5, output_tokens: 5 },
        modelUsage: { 'claude-test': { inputTokens: turns * 5, outputTokens: turns * 5, costUSD: turns * 0.02 } },
        total_cost_usd: Number((turns * 0.02).toFixed(2)), ...(provider === 'claude-code' ? {} : { brain: provider }),
      } });
      sink.send({ type: 'done', code: 0 });
    },
    identity: () => ({ providerThreadId: provider === 'codex' ? 'thread-1' : null }),
    async dispose() {},
  };
}
const scriptedBrains = { 'claude-code': scriptedBrain, codex: scriptedBrain, opencode: scriptedBrain };
/** Every method throws (a meter or a ledger that broke). */
const throwing = (label, target = {}) => new Proxy(target, {
  get: (object, name) => (name === 'then' || typeof name === 'symbol' ? undefined : () => { throw new Error(`${label}.${name} failed`); }),
});

test('usage packets go to open sockets only: never buffered, replayed or shown to packet observers', async (t) => {
  const { runtime } = harness(t, { metered: true });
  const session = await runtime.createSession({ cwd: '/tmp' });
  const observed = [];
  runtime.observe(({ packet }) => observed.push(packet.type));
  await runtime.submit(session.id, { text: 'Nobody is watching' });
  await wait(330);
  const live = runtime._internals.sessions.get(session.id);
  assert.ok(live.buffer.some((packet) => packet.type === 'done'), 'the turn itself waits in the replay buffer');
  assert.equal(live.buffer.filter((packet) => packet.type === 'assistant:usage').length, 0);
  assert.ok(observed.includes('done'));
  assert.equal(observed.includes('assistant:usage'), false);
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` });
  assert.equal(ws.packets('assistant:usage').length, 1, 'attach sends one fresh view, the replay none');
  assert.equal(ws.packets('assistant:usage')[0].task.id, 'task-1');
  assert.ok(ws.packets('reattach_result')[0].replayed > 0);
  await runtime.submit(session.id, { text: 'Somebody is' });
  await wait(330);
  assert.ok(ws.packets('assistant:usage').length > 1, 'an open socket gets the live packets');
  assert.equal(observed.includes('assistant:usage'), false);
  assert.equal(live.buffer.length, 0);
});

test('limitNotice reads a provider limit report: warning or rejected with its reset time in ms, null once it is over', () => {
  const at = Date.parse('2026-10-02T12:00:00Z');
  assert.deepEqual(limitNotice({ status: 'allowed_warning', resetsAt: at / 1000 + 3600, rateLimitType: 'five_hour', utilization: 0.93 }, at), { status: 'allowed_warning', resetsAt: at + 3_600_000, rateLimitType: 'five_hour' });
  assert.deepEqual(limitNotice({ status: 'rejected', resetsAt: at + 3_600_000 }, at), { status: 'rejected', resetsAt: at + 3_600_000, rateLimitType: null }, 'a time already in ms is kept');
  assert.deepEqual(limitNotice({ status: 'rejected' }, at), { status: 'rejected', resetsAt: null, rateLimitType: null });
  assert.equal(limitNotice({ status: 'allowed', resetsAt: at / 1000 + 3600 }, at), null, 'back to normal clears');
  assert.equal(limitNotice({ status: 'allowed_warning', resetsAt: at / 1000 - 1 }, at), null, 'a reset time that passed clears');
  assert.equal(limitNotice({}, at), undefined, 'a report without a status says nothing');
  assert.equal(limitNotice(null, at), undefined);
});

test('a provider usage limit is one sticky notice: repeated reports are one packet, a change updates it, normal clears it', async (t) => {
  const { runtime } = harness(t);
  const session = await runtime.createSession({ cwd: '/tmp' });
  const live = runtime._internals.sessions.get(session.id);
  const observed = [];
  runtime.observe(({ packet }) => observed.push(packet.event?.type || packet.type));
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` });
  const limits = (socket = ws) => socket.packets('assistant:limit');
  assert.deepEqual(limits().map((p) => p.limit), [null], 'attach says there is no notice');
  const soon = Math.floor(Date.now() / 1000) + 3600; // the SDK reports seconds
  const report = (rate_limit_info, uuid = 'u') => runtime._internals.onBrainPacket(live, { type: 'event', event: { type: 'rate_limit_event', rate_limit_info, uuid, session_id: 'prov-1' } });
  // One report per API response, the utilization moving each time: still the same notice.
  for (let i = 0; i < 6; i += 1) report({ status: 'allowed_warning', resetsAt: soon, rateLimitType: 'five_hour', utilization: 0.9 + i / 100 }, `u-${i}`);
  assert.equal(limits().length, 2, 'six identical reports are one packet');
  assert.equal(limits()[1].sessionId, session.id);
  assert.deepEqual([limits()[1].limit.status, limits()[1].limit.resetsAt, limits()[1].limit.rateLimitType, limits()[1].limit.provider], ['allowed_warning', soon * 1000, 'five_hour', 'claude-code']);
  assert.equal(ws.sent.some((p) => p.type === 'event' && p.event?.type === 'rate_limit_event'), false, 'the report itself is not forwarded');
  // A new reset time, then a new status: the same notice, updated. A repeat of either is nothing.
  report({ status: 'allowed_warning', resetsAt: soon + 600 });
  report({ status: 'allowed_warning', resetsAt: soon + 600 });
  report({ status: 'rejected', resetsAt: soon + 600 });
  report({ status: 'rejected', resetsAt: soon + 600 });
  report({}); // no status: says nothing
  assert.deepEqual(limits().slice(2).map((p) => [p.limit.status, p.limit.resetsAt]), [['allowed_warning', (soon + 600) * 1000], ['rejected', (soon + 600) * 1000]]);
  // Nobody attached: the change is kept as state, not buffered; the next attach gets the notice as it is now.
  ws.close();
  report({ status: 'rejected', resetsAt: soon + 1200 });
  assert.equal(live.buffer.some((p) => p.type === 'assistant:limit' || p.event?.type === 'rate_limit_event'), false);
  const ws2 = new FakeWs();
  await runtime.handleWebSocket(ws2, { pathname: `/ws/assistant/${session.id}` });
  assert.deepEqual(limits(ws2).map((p) => [p.limit.status, p.limit.resetsAt]), [['rejected', (soon + 1200) * 1000]]);
  const order = ws2.sent.map((p) => p.type);
  assert.ok(order.indexOf('assistant:limit') < order.indexOf('reattach_result'), 'the notice is a view, not part of the replay');
  // Back to normal: cleared once.
  report({ status: 'allowed' });
  report({ status: 'allowed' });
  assert.deepEqual(limits(ws2).slice(1).map((p) => p.limit), [null]);
  // A report whose reset time already passed shows nothing.
  report({ status: 'allowed_warning', resetsAt: Math.floor(Date.now() / 1000) - 5 });
  assert.equal(limits(ws2).length, 2);
  assert.equal(observed.includes('rate_limit_event'), false, 'packet observers never see the reports');
  assert.equal(observed.includes('assistant:limit'), false);
  assert.equal(JSON.stringify(runtime.getSession(session.id).transcript).includes('limit'), false, 'nothing of it is journaled');
});

test('a limit notice whose reset time passed is gone on attach, and another provider starts without it', async (t) => {
  let clock = Date.parse('2026-10-02T12:00:00Z');
  const { runtime } = harness(t, { now: () => clock });
  const session = await runtime.createSession({ cwd: '/tmp' });
  const live = runtime._internals.sessions.get(session.id);
  const report = (rate_limit_info) => runtime._internals.onBrainPacket(live, { type: 'event', event: { type: 'rate_limit_event', rate_limit_info } });
  const attach = async () => { const ws = new FakeWs(); await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` }); return ws; };
  report({ status: 'allowed_warning', resetsAt: clock / 1000 + 60 });
  const first = await attach();
  assert.deepEqual(first.packets('assistant:limit').map((p) => p.limit?.resetsAt), [clock + 60_000]);
  clock += 61_000;
  const second = await attach();
  assert.deepEqual(second.packets('assistant:limit').map((p) => p.limit), [null], 'the reset time passed while nothing was reported');
  assert.equal(live.limit, null);
  report({ status: 'rejected', resetsAt: clock / 1000 + 3600 });
  assert.equal(second.packets('assistant:limit').at(-1).limit.status, 'rejected');
  second.emit('message', Buffer.from(JSON.stringify({ type: 'switch_brain', brain: 'opencode' })));
  await wait(20);
  assert.equal(runtime.getSession(session.id).brain.provider, 'opencode');
  assert.equal(second.packets('assistant:limit').at(-1).limit, null, 'the limit was the other account\'s');
});

for (const provider of ['claude-code', 'codex', 'opencode']) {
  test(`a throwing ${provider} meter does not break the turn or the dollar booking`, async (t) => {
    const { runtime, log } = meteredRuntime(t, { brainFactories: scriptedBrains, meterFactories: { [provider]: () => throwing('meter') } });
    const session = await runtime.createSession({ brain: { provider }, cwd: '/tmp' });
    const live = runtime._internals.sessions.get(session.id);
    assert.deepEqual(await runtime.submit(session.id, { text: 'One' }), { ok: true });
    assert.equal(live.running, false, 'the turn ended');
    assert.equal(live.record.costUsd, 0.02);
    assert.deepEqual(await runtime.submit(session.id, { text: 'Two' }), { ok: true }, 'and the next one starts');
    assert.equal(live.running, false);
    assert.equal(live.record.costUsd, 0.04);
    assert.equal(live.record.lastReportedCost, 0.04);
    const kinds = log.filter(([tag]) => tag === 'assistant:usage-error').map(([, message]) => message.split(':')[0]);
    assert.ok(kinds.length > 0, 'the failure is logged');
    assert.equal(new Set(kinds).size, kinds.length, 'once per kind');
  });

  test(`a throwing ledger does not break a ${provider} turn or the dollar booking`, async (t) => {
    // Codex settles rows only from a rollout: hand it one so settle() is reached.
    const row = { model: 'gpt-test', part: 'main', tokens: { input: 1 }, usage: { input_tokens: 1 }, fidelity: 'exact', reason: null, source: 'codex-records' };
    const { runtime, log } = meteredRuntime(t, {
      usage: (root) => throwing('ledger', createUsageLedger({ dataDir: root })),
      brainFactories: scriptedBrains, meterFactories: { codex: () => ({ poll: () => [row], state: () => ({}) }) },
    });
    const session = await runtime.createSession({ brain: { provider }, cwd: '/tmp' });
    const live = runtime._internals.sessions.get(session.id);
    const ws = new FakeWs();
    await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` });
    assert.deepEqual(await runtime.submit(session.id, { text: 'One' }), { ok: true });
    assert.deepEqual(await runtime.submit(session.id, { text: 'Two' }), { ok: true });
    await wait(300); // the usage timer fires on a ledger that throws
    assert.equal(live.running, false);
    assert.equal(live.record.costUsd, 0.04);
    assert.equal(live.record.lastReportedCost, 0.04);
    assert.equal(ws.packets('done').length, 2);
    assert.equal(runtime.currentTask(session.id), null);
    const kinds = log.filter(([tag]) => tag === 'assistant:usage-error').map(([, message]) => message.split(':')[0]);
    assert.ok(kinds.length > 0);
    assert.equal(new Set(kinds).size, kinds.length, 'once per kind');
    await runtime.destroySession(session.id);
  });
}

test('the dollar path is the same with and without metering', async (t) => {
  const books = [];
  for (const metered of [false, true]) {
    const { runtime } = harness(t, { metered });
    const session = await runtime.createSession({ cwd: '/tmp' });
    await runtime.submit(session.id, { text: 'Go' }); // the fake brain reports a running total of 0.02
    await wait(40);
    const live = runtime._internals.sessions.get(session.id);
    // A growing total books its delta; a smaller one is a restarted provider session and counts in full.
    for (const total of [0.05, 0.09, 0.03]) runtime._internals.onBrainPacket(live, { type: 'event', event: { type: 'result', subtype: 'success', uuid: `r-${total}`, total_cost_usd: total } });
    books.push({ costUsd: live.record.costUsd, lastReportedCost: live.record.lastReportedCost, brainSpend: runtime.brainSpend(session.id) });
  }
  assert.deepEqual(books[0], { costUsd: 0.12, lastReportedCost: 0.03, brainSpend: 0.12 });
  assert.deepEqual(books[1], books[0]);
});

test('a prompt sent while a Claude turn runs gets its own task and leaves the turn in flight on its own', async (t) => {
  let sink = null;
  let busy = false;
  const factory = ({ sink: brainSink }) => { sink = brainSink; return { async start() {}, async sendUserTurn() { busy = true; }, isBusy: () => busy, async dispose() {} }; };
  const { runtime, usage } = meteredRuntime(t, { brainFactories: { 'claude-code': factory } });
  const session = await runtime.createSession({ cwd: '/tmp' });
  const result = (uuid, input) => ({ type: 'event', event: { type: 'result', subtype: 'success', uuid, usage: { input_tokens: 1, output_tokens: 0 }, modelUsage: { 'claude-test': { inputTokens: input, outputTokens: 0, costUSD: 0 } } } });
  const total = (taskId, key = 'tokens') => usage.taskView(session.id, taskId).task[key].total;
  await runtime.submit(session.id, { text: 'First' });
  await runtime.submit(session.id, { text: 'Second', requireIdle: false }); // the CLI queues it behind the turn in flight
  assert.equal(runtime.currentTask(session.id), 'task-1', 'the turn in flight keeps its task');
  assert.equal(runtime.usageView(session.id).task.id, 'task-2', 'the view follows the latest human prompt');
  sink.send({ type: 'event', event: { type: 'assistant', message: { id: 'msg-1', model: 'claude-test', usage: { input_tokens: 7, output_tokens: 0 } } } });
  assert.equal(total('task-1', 'pending'), 7, 'pending goes to the turn in flight');
  assert.equal(total('task-2', 'pending'), 0);
  sink.send(result('r1', 10));
  sink.send({ type: 'done', code: 0 });
  assert.equal(total('task-1'), 10);
  assert.equal(total('task-2'), 0);
  assert.equal(runtime.currentTask(session.id), 'task-2', 'the queued prompt is the turn in flight now');
  sink.send({ type: 'event', event: { type: 'assistant', message: { id: 'msg-2', model: 'claude-test', usage: { input_tokens: 3, output_tokens: 0 } } } });
  assert.equal(total('task-2', 'pending'), 3);
  busy = false;
  sink.send(result('r2', 30));
  sink.send({ type: 'done', code: 0 });
  assert.equal(total('task-1'), 10, 'the second result never lands in the first task');
  assert.equal(total('task-2'), 20);
  assert.equal(runtime._internals.sessions.get(session.id).turnTasks.length, 0);
  assert.equal(runtime.currentTask(session.id), 'task-2');
});

test('Codex rows are priced from row.usage at the brain model\'s extended tier, polled once at the turn end', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-codex-brain-price-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = resolve(root, 'codex-home');
  const threadId = '01a00000-0000-7000-8000-000000000022';
  const stamp = new Date();
  const day = resolve(home, 'sessions', String(stamp.getFullYear()), String(stamp.getMonth() + 1).padStart(2, '0'), String(stamp.getDate()).padStart(2, '0'));
  mkdirSync(day, { recursive: true });
  const factory = ({ sink }) => ({
    async start() {},
    async sendUserTurn() { sink.send({ type: 'event', event: { type: 'result', brain: 'codex' } }); sink.send({ type: 'done', code: 0 }); },
    identity: () => ({ providerThreadId: threadId }),
    async dispose() {},
  });
  let polls = 0;
  const priced = [];
  const price = { input: 1, cacheRead: 0.5, output: 2, long: { input: 2, cacheRead: 1, output: 4, size: 200_000 } };
  const runtime = createAssistantRuntime({
    dataDir: root, usage: createUsageLedger({ dataDir: root }), codexHomeForAccount: () => home, brainFactories: { codex: factory },
    pricing: { codexPrice: (model) => { priced.push(model); return price; } },
    catalog: { brainInfo: () => ({ id: 'gpt-test[extended]', contextWindow: 1_000_000 }) },
    meterFactories: { codex: (options) => { const meter = createCodexMeter(options); return { ...meter, poll: (...args) => { polls += 1; return meter.poll(...args); } }; } },
  });
  t.after(() => runtime.shutdown());
  const session = await runtime.createSession({ brain: { provider: 'codex', model: 'gpt-test[extended]' }, cwd: '/tmp' });
  assert.equal(runtime._internals.sessions.get(session.id).record.brain.model, 'gpt-test[extended]');
  // Raw keys: input includes the cached tokens. The five classes are 80 / 20 / 8 / 2.
  const usage = { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 110 };
  // A second response whose prompt is over the model's long-context size (200k here).
  const longUsage = { input_tokens: 300_000, cached_input_tokens: 100_000, output_tokens: 1_000, reasoning_output_tokens: 0, total_tokens: 301_000 };
  const lines = [
    { type: 'session_meta', payload: { id: threadId, session_id: threadId } },
    { type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-test' } },
    { type: 'token_usage_record', payload: { thread_id: threadId, session_id: threadId, turn_id: 'turn-1', root_turn_id: 'turn-1', response_id: 'response-1', usage } },
    { type: 'token_usage_record', payload: { thread_id: threadId, session_id: threadId, turn_id: 'turn-1', root_turn_id: 'turn-1', response_id: 'response-2', usage: longUsage } },
  ].map((row) => JSON.stringify({ timestamp: new Date().toISOString(), ...row })).join('\n') + '\n';
  writeFileSync(resolve(day, `rollout-${stamp.toISOString().replace(/[:.]/g, '-')}-${threadId}.jsonl`), lines);
  await runtime.submit(session.id, { text: 'Count rollout' });
  assert.equal(polls, 1, 'not at both `result` and `done`');
  const task = runtime.usageView(session.id).task;
  assert.equal(task.tokens.total, 301_110);
  // The long rates are per request, not per window: the 100-token prompt is priced at the base
  // rates even on an extended window, (80 fresh × 1 + 20 cached × 0.5 + 10 output × 2) / 1e6 =
  // 0.00011; the 300k prompt at the long ones, (200k × 2 + 100k × 1 + 1k × 4) / 1e6 = 0.504.
  // Pricing the five classes (no input_tokens key) would give 0.
  assert.equal(task.costUsd, 0.50411);
  assert.deepEqual([task.tokens.inputTotal, task.tokens.outputTotal], [300_100, 1_010], 'input includes the cached tokens, output the reasoning ones');
  assert.equal(task.agents[0].model, 'gpt-test', 'the rollout names the model that ran');
  assert.ok(priced.includes('gpt-test'));
});

test('a Codex row without a model takes the brain\'s', async (t) => {
  const row = { model: null, part: 'main', tokens: { input: 3 }, usage: { input_tokens: 3 }, fidelity: 'exact', reason: null, source: 'codex-records' };
  let polled = false;
  const { runtime } = meteredRuntime(t, {
    brainFactories: scriptedBrains,
    meterFactories: { codex: () => ({ poll: () => { if (polled) return []; polled = true; return [row]; }, state: () => ({}) }) },
  });
  const session = await runtime.createSession({ brain: { provider: 'codex', model: 'gpt-brain' }, cwd: '/tmp' });
  await runtime.submit(session.id, { text: 'Go' });
  assert.equal(runtime.usageView(session.id).task.agents[0].model, 'gpt-brain');
});

test('OpenCode pending tokens go with the brain; two turn ends never reconcile at once and the next turn waits', async (t) => {
  let sink = null;
  let hooks = null;
  let active = 0;
  let overlap = false;
  const releases = [];
  // Registered before the runtime's own shutdown hook: a failed assertion must not leave a reconcile open.
  t.after(() => { for (const done of releases.splice(0)) done(); });
  const turns = [];
  const factory = ({ sink: brainSink, deps }) => {
    sink = brainSink;
    hooks = deps;
    return {
      async start() { deps.onOpenCodeRoot('root'); },
      async sendUserTurn({ text }) { turns.push(text); },
      async reconcileUsage() {
        active += 1;
        if (active > 1) overlap = true;
        await new Promise((done) => { releases.push(done); });
        active -= 1;
        return true;
      },
      async dispose() {},
    };
  };
  const { runtime, usage } = meteredRuntime(t, { brainFactories: { opencode: factory } });
  const session = await runtime.createSession({ brain: { provider: 'opencode' }, cwd: '/tmp' });
  const live = runtime._internals.sessions.get(session.id);
  const message = (id, input) => hooks.onOpenCodeEvent('message.updated', { info: { id, sessionID: 'root', role: 'assistant', modelID: 'model', tokens: { input, output: 0 }, cost: 0.01 } });
  await runtime.submit(session.id, { text: 'First' });
  message('msg-1', 9);
  assert.equal(usage.taskView(session.id).task.pending.total, 9);
  // session.error ends the turn twice (error, then done): two finishes, one after the other.
  sink.send({ type: 'error', message: 'provider error' });
  sink.send({ type: 'done', code: 1 });
  assert.equal(live.running, false);
  const next = runtime.submit(session.id, { text: 'Second' });
  await wait(20);
  assert.deepEqual(turns, ['First'], 'the next turn waits for the reconcile');
  assert.equal(active, 1, 'one reconcile at a time');
  releases.shift()();
  await wait(5);
  assert.equal(active, 1, 'the second finish starts after the first');
  releases.shift()();
  assert.deepEqual(await next, { ok: true });
  assert.equal(overlap, false);
  assert.deepEqual(turns, ['First', 'Second']);
  assert.equal(usage.taskView(session.id, 'task-1').task.tokens.total, 9, 'the turn is booked once');
  assert.equal(usage.taskView(session.id, 'task-1').task.pending.total, 0);
  // A brain that goes mid-turn takes its provisional tokens with it.
  message('msg-2', 5);
  assert.equal(usage.taskView(session.id, 'task-2').task.pending.total, 5);
  await runtime._internals.disposeBrain(live, 'switched');
  assert.equal(usage.taskView(session.id, 'task-2').task.pending.total, 0);
});

test('an OpenCode reconcile that hangs is cut off at the limit: the turn settles as not reconciled, the next turn starts, and a late answer is booked once', async (t) => {
  let sink = null;
  let hooks = null;
  let release = null;
  let reconciles = 0;
  // Registered before the runtime's own shutdown hook: a failed assertion must not leave the reconcile open.
  t.after(() => release?.());
  const turns = [];
  const message = (id, input) => ({ info: { id, sessionID: 'root', role: 'assistant', modelID: 'model', tokens: { input, output: 0 }, cost: 0.01 } });
  const factory = ({ sink: brainSink, deps }) => {
    sink = brainSink;
    hooks = deps;
    return {
      async start() { deps.onOpenCodeRoot('root'); },
      async sendUserTurn({ text }) { turns.push(text); },
      async reconcileUsage(meter) {
        reconciles += 1;
        if (reconciles > 1) return true;
        // The first read answers long after the limit: on the serve msg-1 had grown to 12 tokens.
        await new Promise((done) => { release = done; });
        await meter.reconcile({ messages: async () => [message('msg-1', 12)] });
        return true;
      },
      async dispose() {},
    };
  };
  const { runtime, usage } = meteredRuntime(t, { brainFactories: { opencode: factory }, config: { mailboxBatchMs: 20, openCodeReconcileMs: 30 } });
  const session = await runtime.createSession({ brain: { provider: 'opencode' }, cwd: '/tmp' });
  const live = runtime._internals.sessions.get(session.id);
  const endTurn = () => { sink.send({ type: 'event', event: { type: 'result', brain: 'opencode' } }); sink.send({ type: 'done', code: 0 }); };
  await runtime.submit(session.id, { text: 'First' });
  hooks.onOpenCodeEvent('message.updated', message('msg-1', 9));
  endTurn();
  // Without the limit this turn waited on the reconcile for good.
  await Promise.race([runtime.submit(session.id, { text: 'Second' }), wait(1000)]);
  assert.deepEqual(turns, ['First', 'Second']);
  let first = usage.taskView(session.id, 'task-1').task;
  assert.deepEqual([first.tokens.total, first.pending.total, first.agents[0].fidelity, first.agents[0].partialReason], [9, 0, 'partial', 'opencode-not-reconciled']);

  // The late answer raises msg-1 in the meter, above the mark the settled turn left.
  release();
  await wait(10);
  assert.equal(usage.taskView(session.id, 'task-1').task.tokens.total, 9, 'nothing is settled from a late answer');
  hooks.onOpenCodeEvent('message.updated', message('msg-2', 5));
  endTurn();
  while (live.openCodeFinalizing) await live.openCodeFinalizing;
  first = usage.taskView(session.id, 'task-1').task;
  const second = usage.taskView(session.id, 'task-2').task;
  assert.deepEqual([first.tokens.total, second.tokens.total, second.pending.total], [9, 8, 0], 'msg-1\'s late 3 tokens ride with the next finish');
  assert.equal(usage.sessionView(session.id).tokens.total, 17, '12 + 5: nothing twice');
});

test('a resume into another provider session drops the Claude baseline and moves the OpenCode root', async (t) => {
  let turns = 0;
  const claude = ({ sink }) => ({
    async start() {},
    async sendUserTurn() {
      turns += 1;
      // The second turn runs in another provider session: its counters are that session's, not a delta.
      const modelUsage = { 'claude-test': turns === 1 ? { inputTokens: 15, outputTokens: 15, costUSD: 0.01 } : { inputTokens: 500, outputTokens: 500, costUSD: 1 } };
      sink.send({ type: 'event', event: { type: 'result', uuid: `r${turns}`, usage: { input_tokens: 5, output_tokens: 5 }, modelUsage } });
      sink.send({ type: 'done', code: 0 });
    },
    async resume() {},
    async dispose() {},
  });
  const opencode = ({ deps }) => ({ async start() { deps.onOpenCodeRoot('first'); }, async sendUserTurn() {}, async resume(id) { deps.onOpenCodeRoot(id); }, async dispose() {} });
  const { runtime } = meteredRuntime(t, { brainFactories: { 'claude-code': claude, opencode } });
  const session = await runtime.createSession({ cwd: '/tmp' });
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` });
  await runtime.submit(session.id, { text: 'First' });
  assert.equal(runtime.usageView(session.id).task.tokens.total, 30);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'resume', providerSessionId: 'another-session' })));
  await wait(5);
  await runtime.submit(session.id, { text: 'Second' });
  const task = runtime.usageView(session.id).task;
  assert.equal(task.tokens.total, 10, 'the main loop only, not 1000 - 30');
  assert.equal(task.agents[0].partialReason, 'no-baseline');

  const other = await runtime.createSession({ brain: { provider: 'opencode' }, cwd: '/tmp' });
  const socket = new FakeWs();
  await runtime.handleWebSocket(socket, { pathname: `/ws/assistant/${other.id}` });
  await runtime.submit(other.id, { text: 'Start' });
  const live = runtime._internals.sessions.get(other.id);
  assert.equal(live.brainMeter.state().root, 'first');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'resume', providerSessionId: 'second' })));
  await wait(5);
  assert.equal(live.brainMeter.state().root, 'second');
  assert.equal(live.record.usageState.opencode.root, 'second');
});

test('usage view: a run the dispatcher dropped reads done under a short name; awaiting_permission reads running', async (t) => {
  const runs = { 'run-waiting-1': { runId: 'run-waiting-1', title: 'Waiting worker', state: 'awaiting_permission' } };
  const dispatcher = { totals: () => ({ costUsd: 0 }), get: (id) => runs[id] || null, list: () => [{ runId: 'run-asking-22', taskId: 'task-1', title: 'Asking worker', state: 'awaiting_permission' }] };
  const { runtime, usage } = harness(t, { dispatcher, metered: true });
  const session = await runtime.createSession({ cwd: '/tmp' });
  await runtime.submit(session.id, { text: 'Go' });
  await wait(40);
  for (const runId of ['run-gone-1234567890', 'run-waiting-1']) usage.settle({ sessionId: session.id, taskId: 'task-1', scope: 'run', runId, provider: 'codex', model: 'gpt', tokens: { input: 3 } });
  const agents = runtime.usageView(session.id).task.agents;
  const gone = agents.find((row) => row.key === 'run-gone-1234567890');
  assert.equal(gone.state, 'done');
  assert.equal(gone.title, 'Run run-gone');
  assert.equal(agents.find((row) => row.key === 'run-waiting-1').state, 'running');
  assert.equal(agents.find((row) => row.key === 'run-asking-22').state, 'running', 'an active run with no rows yet');
  assert.equal(runtime.usageView(session.id).task.live, true);
});

test('usage view: a run agent is read with the dispatcher\'s peek, not its full get (which looks the run\'s memory up)', async (t) => {
  const calls = { peek: 0, get: 0 };
  const run = { runId: 'run-peek-1', title: 'Peeked worker', state: 'idle', taskId: 'task-1' };
  const dispatcher = { totals: () => ({ costUsd: 0 }), list: () => [], peek: (id) => { calls.peek += 1; return id === run.runId ? run : null; }, get: () => { calls.get += 1; return run; } };
  const { runtime, usage } = harness(t, { dispatcher, metered: true });
  const session = await runtime.createSession({ cwd: '/tmp' });
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` });
  await runtime.submit(session.id, { text: 'Go' });
  usage.settle({ sessionId: session.id, taskId: 'task-1', scope: 'run', runId: run.runId, provider: 'codex', model: 'gpt', tokens: { input: 3 } });
  await wait(330);
  const packet = ws.packets('assistant:usage').at(-1);
  assert.deepEqual(packet.task.agents.filter((row) => row.key === run.runId).map((row) => [row.title, row.state]), [['Peeked worker', 'idle']]);
  assert.ok(calls.peek > 0);
  assert.equal(calls.get, 0, 'every usage packet called get() for every run of the task');
});

test('usage view: a warm run on a follow-up for a later task shows under that task before its first tokens land', async (t) => {
  // The run was dispatched for task-1; its turn in progress was sent during task-2 (the dispatcher's turnTaskId).
  const run = { runId: 'run-warm-1', taskId: 'task-1', turnTaskId: 'task-2', turns: [{ n: 1, taskId: 'task-1' }], title: 'Warm worker', state: 'running' };
  const dispatcher = { totals: () => ({ costUsd: 0 }), get: (id) => (id === run.runId ? run : null), list: () => [run] };
  const { runtime, usage } = harness(t, { dispatcher, metered: true });
  const session = await runtime.createSession({ cwd: '/tmp' });
  await runtime.submit(session.id, { text: 'First' });
  await wait(40);
  usage.settle({ sessionId: session.id, taskId: 'task-1', scope: 'run', runId: run.runId, provider: 'codex', model: 'gpt', tokens: { input: 3 } });
  await runtime.submit(session.id, { text: 'Second' });
  await wait(40);
  const current = runtime.usageView(session.id).task;
  assert.equal(current.id, 'task-2');
  assert.deepEqual(current.agents.filter((row) => row.key === run.runId).map((row) => [row.title, row.state, row.tokens.total]), [['Warm worker', 'running', 0]], 'it was missing until its first tokens were settled');
  assert.equal(runtime.usageView(session.id, 'task-1').task.agents.filter((row) => row.key === run.runId).length, 1, 'and it stays under the task it already spent tokens for');
});

test('a turn the CLI starts and a turn that fails to start both send a usage packet', async (t) => {
  let sink = null;
  let fail = false;
  const factory = ({ sink: brainSink }) => { sink = brainSink; return { async start() {}, async sendUserTurn() { if (fail) { await wait(300); throw new Error('send failed'); } sink.send({ type: 'done', code: 0 }); }, async dispose() {} }; };
  const { runtime } = meteredRuntime(t, { brainFactories: { 'claude-code': factory } });
  const session = await runtime.createSession({ cwd: '/tmp' });
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` });
  await runtime.submit(session.id, { text: 'First' });
  await wait(300);
  const brainState = () => ws.packets('assistant:usage').at(-1).task.agents.find((row) => row.key === 'brain')?.state;
  let count = ws.packets('assistant:usage').length;
  // A background agent finished: the CLI began a turn on its own.
  sink.send({ type: 'turn_started' });
  await wait(300);
  assert.equal(ws.packets('assistant:usage').length, count + 1);
  assert.equal(brainState(), 'running');
  assert.equal(runtime.currentTask(session.id), 'task-1');
  sink.send({ type: 'event', event: { type: 'result', uuid: 'cli-turn', usage: { input_tokens: 2, output_tokens: 2 }, modelUsage: { 'claude-test': { inputTokens: 2, outputTokens: 2, costUSD: 0 } } } });
  sink.send({ type: 'done', code: 0 });
  await wait(300);
  assert.equal(runtime.usageView(session.id, 'task-1').task.tokens.total, 4, 'its tokens go to the latest human task');
  count = ws.packets('assistant:usage').length;
  fail = true;
  // The send takes long enough for the turn's first packet (brain running) to go out, then fails.
  const failed = await runtime.submit(session.id, { text: 'Second' });
  assert.equal(failed.code, 'TURN_FAILED');
  assert.equal(ws.packets('assistant:usage').length, count + 1);
  assert.equal(brainState(), 'running');
  await wait(300);
  assert.equal(ws.packets('assistant:usage').length, count + 2, 'the failure sends the view that takes it back');
  assert.notEqual(brainState(), 'running');
  assert.equal(runtime._internals.sessions.get(session.id).turnTasks.length, 0);
});

test('settled rows put the meter state on disk at once, and shutdown flushes the ledger', async (t) => {
  let flushed = 0;
  const { runtime, root } = meteredRuntime(t, {
    brainFactories: scriptedBrains,
    usage: (dir) => { const ledger = createUsageLedger({ dataDir: dir }); return { ...ledger, flush: (...args) => { flushed += 1; return ledger.flush(...args); } }; },
  });
  const session = await runtime.createSession({ cwd: '/tmp' });
  await runtime.submit(session.id, { text: 'Go' });
  // No waiting for the 300 ms debounce: a kill right now must not leave the baseline behind the ledger.
  const saved = JSON.parse(readFileSync(resolve(root, 'assistant-sessions.json'), 'utf8')).find((row) => row.id === session.id);
  assert.ok(saved.usageState.claude.snapshot['claude-test']);
  assert.equal(saved.taskId, 'task-1');
  await runtime.shutdown();
  assert.equal(flushed, 1);
});

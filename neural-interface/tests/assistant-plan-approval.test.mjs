// Accepting a plan ends plan mode on the approval itself: the record (persisted,
// broadcast to every host), the plan gate, the dispatch refusal. Claude continues
// in the same turn; Codex and OpenCode, whose plan turn ends with the plan, get
// the same "Plan ready" card from the runtime and start the work when it is
// approved. Declining, keeping planning and an expired card leave plan mode on.
process.env.SYNABUN_TYPESAFE = 'off';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAssistantRuntime, planTurnText } from '../lib/assistant-runtime.js';
import { createAssistantRouter } from '../lib/assistant-router.js';
import { createRemotePolicyRegistry } from '../lib/remote-policy.js';
import { createComposer } from '../public/shared/assistant/asst-composer.js';
import { createAssistantApi } from '../lib/assistant-api.js';
import { createCodexEnvelopeTranslator, createOpenCodeEnvelopeTranslator, proposedPlanText } from '../lib/assistant-envelope.js';
import { createOpenCodeBrain, OPENCODE_PLAN_INSTRUCTIONS } from '../lib/assistant-brains/opencode.js';
import { ClaudeSession, configureClaudeBridge } from '../lib/claude-agent-bridge.js';
import { claudePlanPermission, planDenyMessage } from '../lib/assistant-plan-permissions.js';
import { buildControlResponse, closedControlState, normalizeControlRequest, renderControlCard } from '../public/shared/assistant/asst-control.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Lets queued microtasks and immediates run: the work scheduler pumps on microtasks, so nothing is left pending after it. */
const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i += 1) await new Promise((done) => setImmediate(done)); };
async function waitFor(fn, { timeout = 2000, step = 5 } = {}) {
  const start = Date.now();
  for (;;) { const value = fn(); if (value) return value; if (Date.now() - start > timeout) throw new Error('waitFor timed out'); await wait(step); }
}
class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
  packets(type) { return this.sent.filter((p) => p.type === type); }
}
const PLAN = '# Move the cache\n\n1. Add the store\n2. Switch the readers to it\n3. Drop the old table';

/**
 * Brains that record their turns; `reply(turn)` is the `result` a turn ends with
 * (null: none), `busy(index)` what brain `index` (in creation order) reports as
 * busy, `start(index)` / `compact(index, sink)` / `dispose(index)` what its
 * start() / compact() / dispose() await (a controllable promise, or null). A
 * disposed brain says nothing more. `persona(call)`: what the persona of the
 * call-th brain start awaits (its catalog build; a controllable promise, or
 * null). `real`: runtime deps that run the real brains instead (a fake Codex
 * app-server, a fake OpenCode serve). `routing`: the real router, wired to the
 * runtime the way server.js does.
 */
function harness(t, { config = {}, reply = () => null, busy = () => false, start = () => null, compact = () => null, dispose = () => null, persona = null, real = null, memory = null, delay = 5, remotePolicy = undefined, routing = false } = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'asst-plan-approval-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const turns = [];
  const answered = [];
  const modes = [];
  const created = [];
  const broadcasts = [];
  let runtime = null;
  const factory = ({ session, sink, deps, hooks }) => {
    const index = created.length;
    let disposed = false;
    const brain = {
      kind: session.brain.provider, gateMode: null, index,
      async start() { await start(index); },
      async compact() { await compact(index, sink); },
      async sendUserTurn(turn) {
        turns.push({ ...turn, brain: index });
        setTimeout(() => {
          if (disposed) return;
          const result = reply(turn);
          if (result) sink.send({ type: 'event', event: { type: 'result', subtype: 'success', ...result } });
          sink.send({ type: 'done', code: 0 });
        }, delay);
      },
      // What the brain hears, and whether the session was still planning when it did.
      respondControl(id, response) { answered.push({ id, response, planning: runtime.isPlanning(session.id) }); },
      async setPermissionMode(mode, opts = {}) { modes.push([mode, opts.planMode]); },
      async abort() {}, isBusy: () => busy(index), identity: () => ({ providerSessionId: 'p-main' }),
      async dispose() { disposed = true; await dispose(index); },
      get disposed() { return disposed; },
    };
    created.push({ deps, hooks, brain, sink });
    return brain;
  };
  const router = routing
    ? createAssistantRouter({
      catalog: { peek: () => ({ models: {} }), brainInfo: () => null }, getSession: (id) => runtime.routerSession(id),
      sinks: {
        sendCard: (id, packet) => runtime.routerSend(id, packet),
        cancelCard: (id, requestId, reason) => runtime.routerSend(id, { type: 'control_cancelled', request_id: requestId, reason }),
        routeEvent: (id, phase, route) => runtime.routerEvent(id, phase, route),
        mailbox: (id, item) => runtime.routerMailbox(id, item),
        continueDirect: (id, payload) => runtime.routerContinue(id, payload),
      },
    })
    : { owns: () => false, pendingCards: () => [], cancelForSession() {}, stamp: () => ({ text: '', changed: false, commit() {} }) };
  if (routing) t.after(() => router.shutdown());
  let personaCalls = 0;
  const buildCatalog = persona ? async () => { await persona(personaCalls++); return null; } : null;
  runtime = createAssistantRuntime({
    dataDir: dir, ...(real || { brainFactories: { 'claude-code': factory, codex: factory, opencode: factory } }), router, broadcastSync: (message) => broadcasts.push(message),
    catalog: { peek: () => ({ models: {} }), brainInfo: () => null, hiddenId: () => null }, gateUrl: 'http://127.0.0.1:1/api/assistant/route-gate/check',
    codexGateBootstrap: async () => null, config: { mailboxBatchMs: 20, ...config }, memory, ...(remotePolicy ? { remotePolicy } : {}), ...(buildCatalog ? { buildCatalog } : {}),
  });
  t.after(() => runtime.shutdown());
  const open = async (brain) => {
    const session = await runtime.createSession({ brain });
    const live = runtime._internals.sessions.get(session.id);
    const ws = new FakeWs();
    await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` });
    return { session, live, ws };
  };
  return { runtime, router, dir, turns, answered, modes, created, broadcasts, open };
}
const planOff = (broadcasts, id) => broadcasts.some((m) => m.type === 'assistant:session-updated' && m.session.id === id && m.session.brain.planMode === false);
const cardOf = (ws) => ws.packets('control_request').filter((p) => p.request?.tool_name === 'ExitPlanMode').at(-1);
const events = (ws, type) => ws.sent.filter((p) => p.type === 'event' && p.event?.type === type).map((p) => p.event);
const finalText = (ws) => events(ws, 'assistant').at(-1)?.message.content.find((b) => b.type === 'text')?.text;

/**
 * A fake Codex app-server behind the real Codex brain and its translator:
 * `script(query)` → the notifications of that turn, between turn/started and
 * turn/completed; `hold(query)` → a promise the turn waits for first (or null);
 * `reject(query)` → a message: the query is refused before any turn starts, the
 * way the skin handler answers a rejected turn/start (an `error` for its
 * requestId, nothing else). `queries`: what the brain sent.
 */
function codexAppServer(script, { hold = () => null, reject = () => null } = {}) {
  const queries = [];
  const handle = (ws) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'bootstrap') { ws.send({ type: 'ready', threadId: 'thread-1' }); return; }
      if (m.type !== 'query') return;
      queries.push(m);
      const turn = { id: `turn-${queries.length}` };
      Promise.resolve(hold(m)).then(() => setTimeout(() => {
        const refusal = reject(m);
        if (refusal) { ws.send({ type: 'error', requestId: m.requestId, message: refusal }); return; }
        ws.send({ type: 'notify', method: 'turn/started', params: { turn } });
        for (const [method, params] of script(m)) ws.send({ type: 'notify', method, params: { turnId: turn.id, ...params } });
        ws.send({ type: 'notify', method: 'turn/completed', params: { turn: { ...turn, status: 'completed' } } });
      }, 5));
    });
  };
  return { handle, queries };
}
const codexSays = (text, id = 'm1') => [['item/agentMessage/delta', { itemId: id, delta: text }], ['item/completed', { item: { id, type: 'agentMessage', text } }]];
const codexProposes = (plan) => [...codexSays('Here is the plan.'), ['item/plan/delta', { itemId: 'p1', delta: plan }], ['item/completed', { item: { id: 'p1', type: 'plan', text: plan } }]];
// update_plan's checklist: task progress, never a proposed plan.
const codexChecklist = ['turn/plan/updated', { explanation: 'Working through it', plan: [{ step: 'Add the store', status: 'completed' }, { step: 'Switch the readers', status: 'inProgress' }] }];

/**
 * A fake OpenCode serve behind the real OpenCode brain and its translator:
 * `reply(request)` is the text the turn's assistant message ends with.
 * `prompts`: the promptAsync requests.
 */
function openCodeServe(reply) {
  const prompts = [];
  let listener = null;
  const client = {
    waitUntilConnected: async () => {},
    session: {
      create: async () => ({ data: { id: 'oc-1' } }),
      promptAsync: async (request) => {
        prompts.push(request);
        const id = `msg-${prompts.length}`;
        const text = reply(request);
        setTimeout(() => {
          listener?.({ eventType: 'message.updated', event: { info: { id, role: 'assistant', sessionID: 'oc-1' } } });
          listener?.({ eventType: 'message.part.updated', event: { part: { id: `${id}-text`, messageID: id, sessionID: 'oc-1', type: 'text', text } } });
          listener?.({ eventType: 'session.idle', event: { sessionID: 'oc-1' } });
        }, 5);
        return { status: 200, data: {} };
      },
      abort: async () => {},
    },
    mcp: { status: async () => ({ data: [] }) },
    onEvent: (fn) => { listener = fn; return () => { listener = null; }; },
  };
  // No config file there: the brain reads it, finds none and writes nothing.
  const deps = { ensureIsolatedServe: async () => ({ client, sessions: new Set() }), stopIsolatedServe: () => {}, setupOpencodeSidepanelConfig: () => join(tmpdir(), `no-opencode-config-${randomUUID()}`) };
  return { prompts, deps };
}

// ── Claude: the approval path itself ends plan mode ──────────────────────────

test('Claude: approving ExitPlanMode clears plan mode before the brain hears it, persists it and tells every host', async (t) => {
  const h = harness(t);
  const { session, live, ws } = await h.open({ provider: 'claude-code', planMode: true });
  await h.runtime._internals.ensureBrain(live);
  h.runtime._internals.onBrainPacket(live, { type: 'control_request', request_id: 'perm-plan', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: PLAN } } });
  assert.equal(h.runtime.isPlanning(session.id), true);
  const answer = await h.runtime.answerControl(session.id, 'perm-plan', { behavior: 'allow', planDecision: 'default' }, { origin: 'ui' });
  assert.equal(answer.ok, true);
  assert.deepEqual(h.answered.map((a) => [a.id, a.planning]), [['perm-plan', false]], 'the brain continues with plan mode already off');
  assert.equal(h.runtime.isPlanning(session.id), false);
  assert.deepEqual([h.runtime.getSession(session.id).brain.planMode, h.runtime.getSession(session.id).brain.permissionMode], [false, 'default']);
  assert.ok(planOff(h.broadcasts, session.id), 'every open host hears it (sidepanel and terminal tab)');
  assert.equal(ws.packets('assistant:session').at(-1).session.brain.planMode, false);
  assert.ok(ws.sent.some((p) => p.event?.subtype === 'status' && /Plan approved/.test(p.event.text)));
  assert.equal(live.gate.snapshot().state, 'unrouted', 'the approved work is routed first');
  // The hint after ExitPlanMode says so; nothing while planning.
  const hint = h.created[0].hooks.PostToolUse.find((m) => m.matcher === 'ExitPlanMode').hooks[0];
  assert.match((await hint({ tool_name: 'ExitPlanMode' })).hookSpecificOutput.additionalContext, /agent_route/);
  // The SDK's own report lands later and changes nothing.
  h.runtime._internals.onBrainPacket(live, { type: 'event', event: { type: 'mode_changed', mode: 'default' } });
  assert.equal(h.runtime.getSession(session.id).brain.planMode, false);
  // Persisted: a reload (and History) read it off (once the debounced write lands).
  const persisted = () => { try { return JSON.parse(readFileSync(resolve(h.dir, 'assistant-sessions.json'), 'utf8')).find((row) => row.id === session.id); } catch { return null; } };
  await waitFor(() => persisted()?.brain.planMode === false);
});

test('Claude: "Approve & auto-accept edits" switches the approval mode; decline and expiry keep planning', async (t) => {
  const h = harness(t, { config: { questionTimeoutMinutes: 0.001 } });
  const edits = await h.open({ provider: 'claude-code', planMode: true });
  await h.runtime._internals.ensureBrain(edits.live);
  h.runtime._internals.onBrainPacket(edits.live, { type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: PLAN } } });
  await h.runtime.answerControl(edits.session.id, 'p1', { behavior: 'allow', planDecision: 'acceptEdits' }, { origin: 'ui' });
  assert.deepEqual([h.runtime.getSession(edits.session.id).brain.planMode, h.runtime.getSession(edits.session.id).brain.permissionMode], [false, 'acceptEdits']);

  const keep = await h.open({ provider: 'claude-code', planMode: true });
  await h.runtime._internals.ensureBrain(keep.live);
  h.runtime._internals.onBrainPacket(keep.live, { type: 'control_request', request_id: 'p2', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: PLAN } } });
  await h.runtime.answerControl(keep.session.id, 'p2', { behavior: 'deny', message: 'Keep planning — revise the plan.' }, { origin: 'ui' });
  assert.equal(h.runtime.isPlanning(keep.session.id), true, 'keep planning: still planning');
  assert.equal(h.answered.at(-1).response.behavior, 'deny');

  h.runtime._internals.onBrainPacket(keep.live, { type: 'control_request', request_id: 'p3', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: PLAN } } });
  await waitFor(() => h.answered.some((a) => a.id === 'p3'));
  assert.match(h.answered.find((a) => a.id === 'p3').response.message, /No decision within/);
  assert.equal(h.runtime.isPlanning(keep.session.id), true, 'an expired card declines: still planning');
});

test('API: after the approval a brain dispatches and steers workers at their own capability again', async (t) => {
  const h = harness(t);
  const { session, live } = await h.open({ provider: 'claude-code', planMode: true });
  await h.runtime._internals.ensureBrain(live);
  const dispatched = [];
  const dispatcher = {
    limits: {}, list: () => [], totals: () => ({}),
    get: (id) => (id === 'run-1' ? { runId: 'run-1', assistantSessionId: session.id, capability: 'full' } : null),
    dispatch: async (spec, meta) => { dispatched.push([meta.assistantSessionId, spec.capability]); return { ok: true, run: { runId: 'run-2' } }; },
    sendTurn: () => ({ ok: true }),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', createAssistantApi({ dispatcher, runtime: h.runtime, isGuestRequest: () => false, broadcastSync() {} }));
  const server = await new Promise((done) => { const s = app.listen(0, '127.0.0.1', () => done(s)); });
  t.after(() => new Promise((done) => server.close(done)));
  const call = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/assistant${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Synabun-Terminal': session.id }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };
  const task = { provider: 'claude-code', task: 'apply the plan', cwd: process.cwd() };
  // Planning: the worker runs read-only, and a run that can change code is not steered.
  const planned = await call('/dispatch', task);
  assert.equal(planned.status, 200);
  assert.equal(planned.json.planMode.capability, 'read-only');
  assert.equal((await call('/runs/run-1/send', { text: 'go' })).json.code, 'PLAN_MODE_CODE_CHANGE');
  h.runtime._internals.onBrainPacket(live, { type: 'control_request', request_id: 'perm-plan', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: PLAN } } });
  await h.runtime.answerControl(session.id, 'perm-plan', { behavior: 'allow' }, { origin: 'ui' });
  const approved = await call('/dispatch', task);
  assert.equal(approved.status, 200);
  assert.equal(approved.json.planMode, undefined);
  assert.equal((await call('/runs/run-1/send', { text: 'go' })).status, 200);
  assert.deepEqual(dispatched, [[session.id, 'read-only'], [session.id, undefined]]);
});

test('Claude session: an approved plan continues in the approval mode (edits are no longer refused)', async () => {
  configureClaudeBridge({ PACKAGE_ROOT: process.cwd(), writePlanFile: () => ({ ok: false }) });
  const sent = [];
  const session = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send: (data) => sent.push(JSON.parse(data)) }, { permissionMode: 'plan', planExitMode: 'default', planPermission: claudePlanPermission, planDenyMessage });
  assert.match((await session._onCanUseTool('Edit', { file_path: '/tmp/a' }, {})).message, /Plan mode blocks code changes only/);
  const exit = session._onCanUseTool('ExitPlanMode', { plan: PLAN }, {});
  const card = await waitFor(() => sent.find((p) => p.type === 'control_request' && p.request.tool_name === 'ExitPlanMode'));
  session._resolvePermission(card.request_id, { behavior: 'allow', planDecision: 'acceptEdits' });
  assert.equal((await exit).behavior, 'allow');
  assert.equal(session.permissionMode, 'acceptEdits');
  // An edit is asked like in any approval mode (its card), never refused as read-only.
  let edit = null;
  session._onCanUseTool('Edit', { file_path: '/tmp/a' }, {}).then((value) => { edit = value; });
  await waitFor(() => sent.some((p) => p.type === 'control_request' && p.request.tool_name === 'Edit'));
  assert.notEqual(edit?.behavior, 'deny', 'no plan refusal once approved');
});

// ── Codex / OpenCode: the runtime's "Plan ready" card ─────────────────────────

test('Codex: a plan turn ends with the Plan ready card; approving it turns plan off and starts the work out of plan', async (t) => {
  const h = harness(t, { reply: (turn) => (turn.planMode ? { result: 'Here is the plan.', plan: PLAN } : { result: 'Done.' }) });
  const { session, live, ws } = await h.open({ provider: 'codex', planMode: true });
  await h.runtime._internals.runQuery(live, { text: 'plan the cache move', origin: 'ui' });
  const card = await waitFor(() => cardOf(ws));
  assert.equal(card.request.input.plan, PLAN);
  assert.equal(h.runtime.pendingControls(session.id).length, 1);
  // A host attached later gets it replayed.
  const later = new FakeWs();
  await h.runtime.handleWebSocket(later, { pathname: `/ws/assistant/${session.id}` });
  assert.equal(cardOf(later)?.request_id, card.request_id);
  // The open card holds the mailbox, like a pending Claude card.
  h.runtime._internals.enqueueMailbox(live, { kind: 'stalled', run: { runId: 'r-old' } });
  await waitFor(() => !live.mailboxTimer); // its batch window closed: the scheduler looked, and held it
  await settle();
  assert.equal(h.turns.length, 1);
  const answer = await h.runtime.answerControl(session.id, card.request_id, { behavior: 'allow', planDecision: 'acceptEdits' }, { origin: 'ui' });
  assert.deepEqual([answer.ok, answer.kind], [true, 'plan']);
  assert.equal(h.answered.length, 0, 'never reaches the brain');
  assert.equal(h.runtime.isPlanning(session.id), false);
  assert.equal(h.runtime.getSession(session.id).brain.permissionMode, 'auto', 'auto-accept edits → Codex auto-accept');
  assert.ok(planOff(h.broadcasts, session.id));
  assert.ok(ws.packets('control_resolved').some((p) => p.request_id === card.request_id));
  const work = await waitFor(() => h.turns[1]);
  assert.deepEqual([work.planMode, work.permissionMode], [false, 'auto']);
  assert.match(work.text, /approved your plan/);
  assert.equal(live.gate.snapshot().state, 'unrouted', 'the work is routed first');
  await waitFor(() => h.turns.length === 3, { timeout: 3000 });
  assert.match(h.turns[2].text, /r-old|stalled/i, 'then the held mailbox');
});

test('Codex / OpenCode: keep planning with a note revises the plan in plan mode; without one nothing runs; expiry and a new prompt close the card', async (t) => {
  const h = harness(t, { config: { questionTimeoutMinutes: 0.001 }, reply: (turn) => (turn.planMode ? { result: `Revised:\n<proposed_plan>\n${PLAN}\n4. Verify it\n</proposed_plan>` } : { result: 'ok' }) });
  const { session, live, ws } = await h.open({ provider: 'opencode', planMode: true });
  await h.runtime._internals.runQuery(live, { text: 'plan it', origin: 'ui' });
  const first = await waitFor(() => cardOf(ws));
  await h.runtime.answerControl(session.id, first.request_id, { behavior: 'deny', message: 'Use Postgres, not Redis' }, { origin: 'ui' });
  const revise = await waitFor(() => h.turns[1]);
  assert.deepEqual([revise.planMode, /Use Postgres, not Redis/.test(revise.text)], [true, true]);
  const second = await waitFor(() => { const c = cardOf(ws); return c && c.request_id !== first.request_id ? c : null; });
  // "Keep planning" without a note: plan stays on, no turn, the panel stops "working".
  await h.runtime.answerControl(session.id, second.request_id, { behavior: 'deny', message: 'Keep planning — revise the plan.' }, { origin: 'ui' });
  await quiet(h, live);
  assert.equal(h.turns.length, 2);
  assert.equal(h.runtime.isPlanning(session.id), true);
  assert.equal(ws.packets('reattach_result').at(-1).running, false);
  // A new prompt replaces an open card (it is the feedback).
  await h.runtime._internals.runQuery(live, { text: 'plan it again', origin: 'ui' });
  const third = await waitFor(() => { const c = cardOf(ws); return c && ![first.request_id, second.request_id].includes(c.request_id) ? c : null; });
  await h.runtime._internals.runQuery(live, { text: 'one more thing', origin: 'ui' });
  assert.ok(ws.packets('control_cancelled').some((p) => p.request_id === third.request_id && p.reason === 'superseded'));
  // Unanswered: declined after the timeout, plan mode stays on, nothing runs.
  const fourth = await waitFor(() => { const c = cardOf(ws); return c && c.request_id !== third.request_id && c.request_id !== second.request_id && c.request_id !== first.request_id ? c : null; });
  await waitFor(() => ws.packets('control_cancelled').some((p) => p.request_id === fourth.request_id && p.reason === 'timeout'), { timeout: 3000 });
  const count = h.turns.length;
  await quiet(h, live);
  assert.equal(h.turns.length, count);
  assert.equal(h.runtime.isPlanning(session.id), true);
  assert.equal(h.answered.length, 0);
});

test('No card when the plan turn did not end with a plan, outside plan mode, or for a Claude brain', async (t) => {
  const h = harness(t, { reply: (turn) => ({ result: turn.text.includes('ask') ? 'Which database do you use?' : PLAN }) });
  const codex = await h.open({ provider: 'codex', planMode: true });
  await h.runtime._internals.runQuery(codex.live, { text: 'plan it', origin: 'ui' });
  await waitFor(() => !codex.live.running);
  await settle();
  assert.equal(cardOf(codex.ws), undefined, 'Codex marks its plans: plain text is not one');
  const oc = await h.open({ provider: 'opencode', planMode: true });
  await h.runtime._internals.runQuery(oc.live, { text: 'ask me first', origin: 'ui' });
  await waitFor(() => !oc.live.running);
  await settle();
  assert.equal(cardOf(oc.ws), undefined, 'a question is not a plan');
  const building = await h.open({ provider: 'opencode', planMode: false });
  await h.runtime._internals.runQuery(building.live, { text: 'do it', origin: 'ui' });
  await waitFor(() => !building.live.running);
  await settle();
  assert.equal(cardOf(building.ws), undefined);
  const claude = await h.open({ provider: 'claude-code', planMode: true });
  await h.runtime._internals.runQuery(claude.live, { text: 'plan it', origin: 'ui' });
  await waitFor(() => !claude.live.running);
  await settle();
  assert.equal(cardOf(claude.ws), undefined, 'Claude asks with ExitPlanMode itself');
});

// ── A newer turn supersedes the card (real runQuery, real Codex brain) ────────

test('A new prompt closes the plan card before it awaits anything: an approval from another host is refused and shows expired; plan mode stays on and the old plan never runs', async (t) => {
  const server = codexAppServer((query) => (query.planMode ? codexProposes(PLAN) : codexSays('Done.')));
  const memory = { recallForPrompt: async () => ({ results: [] }) };
  const h = harness(t, { real: { handleCodexSkinWebSocket: server.handle }, memory });
  const { session, live, ws } = await h.open({ provider: 'codex', planMode: true });
  await h.runtime._internals.runQuery(live, { text: 'plan the cache move', origin: 'ui' });
  const card = await waitFor(() => cardOf(ws));
  assert.equal(card.request.input.plan, PLAN);
  // The terminal tab shows the same card.
  const other = new FakeWs();
  await h.runtime.handleWebSocket(other, { pathname: `/ws/assistant/${session.id}` });
  assert.equal(cardOf(other)?.request_id, card.request_id);
  // The next prompt waits on a slow recall; the card it replaces is closed already.
  let release = null;
  memory.recallForPrompt = () => new Promise((done) => { release = () => done({ results: [] }); });
  const next = h.runtime._internals.runQuery(live, { text: 'actually, keep Redis and add a TTL', origin: 'ui' });
  assert.ok(ws.packets('control_cancelled').some((p) => p.request_id === card.request_id && p.reason === 'superseded'));
  assert.equal(h.runtime.pendingControls(session.id).length, 0);
  // The terminal tab approves it meanwhile: refused, and its card says expired.
  other.emit('message', Buffer.from(JSON.stringify({ type: 'control_response', request_id: card.request_id, response: { behavior: 'allow', planDecision: 'default' } })));
  await waitFor(() => other.packets('control_cancelled').filter((p) => p.request_id === card.request_id).length === 2);
  assert.match(events(other, 'system').filter((e) => e.subtype === 'status').at(-1).text, /expired/);
  assert.equal(other.packets('reattach_result').at(-1).running, true, 'the new prompt is on its way');
  const late = await h.runtime.answerControl(session.id, card.request_id, { behavior: 'allow' }, { origin: 'whatsapp' });
  assert.deepEqual([late.ok, late.code, late.reason], [false, 'PLAN_CARD_CLOSED', 'superseded']);
  assert.equal(h.runtime.isPlanning(session.id), true, 'nothing was approved');
  await waitFor(() => release);
  release();
  assert.deepEqual(await next, { ok: true });
  // The prompt is feedback on the plan: it runs in plan mode and ends with its own card.
  assert.equal(server.queries[1].planMode, true);
  await waitFor(() => { const c = cardOf(ws); return c && c.request_id !== card.request_id ? c : null; });
  // The replaced plan's implementation never runs, now or after a retry.
  await quiet(h, live);
  assert.equal(server.queries.length, 2);
  assert.ok(!server.queries.some((q) => /approved your plan/.test(q.prompt)));
});

const PLAN_REPLY = (turn) => (turn.planMode ? { result: `<proposed_plan>\n${PLAN}\n</proposed_plan>` } : { result: 'ok' });
const TIDY = { target: { kind: 'direct', provider: 'opencode', model: 'openai/gpt-x' }, route: { summary: 'tidy the docs', routeId: 'r1' } };
const say = (ws, msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)));

test('A plan approved while the brain is busy is the next turn: a held "do it here" continuation, the mailbox and a prompt all wait, and nothing drops it', async (t) => {
  let busy = false;
  const h = harness(t, { busy: () => busy, reply: PLAN_REPLY, delay: 30 });
  const { session, live, ws } = await h.open({ provider: 'opencode', planMode: true });
  await h.runtime._internals.runQuery(live, { text: 'plan it', origin: 'ui' });
  h.runtime.routerSinks().continueDirect(session.id, TIDY); // the route card answered during the plan turn
  const card = await waitFor(() => cardOf(ws));
  busy = true; // e.g. a compact still running
  say(ws, { type: 'control_response', request_id: card.request_id, response: { behavior: 'allow' } });
  await waitFor(() => !h.runtime.isPlanning(session.id));
  h.runtime._internals.enqueueMailbox(live, { kind: 'stalled', run: { runId: 'r-held' } });
  say(ws, { type: 'query', prompt: 'first, rename the table' });
  await waitFor(() => ws.packets('error').some((p) => p.code === 'ASSISTANT_BUSY'));
  await waitFor(() => !live.mailboxTimer && live.workTimer); // the scheduler looked, found the brain busy, and waits
  await settle();
  assert.equal(h.turns.length, 1, 'nothing runs while the brain is busy');
  busy = false;
  h.created[0].sink.send({ type: 'done', code: 0 }); // the brain frees up
  await waitFor(() => h.turns.length === 4, { timeout: 3000 });
  assert.match(h.turns[1].text, /approved your plan/, 'the approved plan first');
  const after = h.turns.slice(2).map((turn) => turn.text).join('\n');
  assert.ok(/chose to run "tidy the docs" here/.test(after) && /r-held/.test(after), 'then the held continuation and the mailbox');
  assert.ok(!h.turns.some((turn) => turn.text === 'first, rename the table'), 'the prompt was refused, not run out of order');
});

test('A user Stop closes the open plan card: a late approval is refused, the mailbox is released and a held continuation is dropped', async (t) => {
  const h = harness(t, { config: { questionTimeoutMinutes: 0 }, reply: PLAN_REPLY, delay: 30 });
  const { session, live, ws } = await h.open({ provider: 'opencode', planMode: true });
  await h.runtime._internals.runQuery(live, { text: 'plan it', origin: 'ui' });
  h.runtime.routerSinks().continueDirect(session.id, TIDY);
  const card = await waitFor(() => cardOf(ws));
  h.runtime._internals.enqueueMailbox(live, { kind: 'stalled', run: { runId: 'r-held' } });
  await waitFor(() => !live.mailboxTimer);
  await settle();
  assert.equal(h.turns.length, 1, 'the open card holds the mailbox (no timeout)');
  say(ws, { type: 'abort' });
  await waitFor(() => ws.packets('control_cancelled').some((p) => p.request_id === card.request_id && p.reason === 'stopped'));
  assert.equal(closedControlState('stopped', 'plan'), 'cancelled');
  say(ws, { type: 'control_response', request_id: card.request_id, response: { behavior: 'allow' } });
  await waitFor(() => ws.packets('control_cancelled').filter((p) => p.request_id === card.request_id).length === 2);
  assert.match(events(ws, 'system').filter((e) => e.subtype === 'status').at(-1).text, /closed by Stop/);
  assert.equal(h.runtime.isPlanning(session.id), true, 'nothing was approved');
  await waitFor(() => h.turns.length === 2, { timeout: 3000 });
  assert.match(h.turns[1].text, /r-held|stalled/i, 'the mailbox goes on');
  await quiet(h, live);
  assert.equal(h.turns.length, 2, 'the continuation was dropped');
});

test('A new prompt drops the "do it here" continuation of the turn it supersedes: after its own card is declined, the old task does not run', async (t) => {
  const h = harness(t, { reply: PLAN_REPLY, delay: 30 });
  const { session, live, ws } = await h.open({ provider: 'opencode', planMode: true });
  await h.runtime._internals.runQuery(live, { text: 'plan it', origin: 'ui' });
  h.runtime.routerSinks().continueDirect(session.id, TIDY);
  const first = await waitFor(() => cardOf(ws));
  say(ws, { type: 'query', prompt: 'plan the billing change instead' });
  const second = await waitFor(() => { const c = cardOf(ws); return c && c.request_id !== first.request_id ? c : null; });
  say(ws, { type: 'control_response', request_id: second.request_id, response: { behavior: 'deny', message: 'Keep planning — revise the plan.' } });
  await waitFor(() => ws.packets('control_resolved').some((p) => p.request_id === second.request_id));
  await quiet(h, live);
  assert.deepEqual(h.turns.map((turn) => turn.text), ['plan it', 'plan the billing change instead'], 'the old task\'s continuation never ran');
});

// ── The work scheduler: one queue per session, cancellation by generation ─────

/** A deferred the test settles: open() resolves it, fail(error) rejects it. */
function gate() {
  let open = null;
  let fail = null;
  const promise = new Promise((done, reject) => { open = done; fail = reject; });
  return { promise, open: () => open(), fail: (error) => fail(error) };
}
/**
 * The session at rest: nothing queued, active, on its way to the brain or timed
 * (no retry, no mailbox window) and the brain idle. Nothing starts from here
 * without new input, so "nothing else ran" needs no wall-clock wait.
 */
async function quiet(h, live) {
  await waitFor(() => !h.runtime.isBusy(live.record.id) && !live.work.size && !live.workActive && !live.workTimer && !live.mailboxTimer);
  await settle();
}
const approvedTurns = (h) => h.turns.filter((turn) => /approved your plan/.test(turn.text));
/** An open plan card on an OpenCode session, answered "allow" while brain 0 reports busy: the approved turn is reserved. */
async function reservedApproval(h, { busyFlag, provider = 'opencode' } = {}) {
  const opened = await h.open({ provider, planMode: true });
  say(opened.ws, { type: 'query', prompt: 'plan it' });
  const card = await waitFor(() => cardOf(opened.ws));
  busyFlag.value = true; // a background turn of the brain
  say(opened.ws, { type: 'control_response', request_id: card.request_id, response: { behavior: 'allow' } });
  await waitFor(() => !h.runtime.isPlanning(opened.session.id));
  await settle();
  return { ...opened, card };
}

test('Stop while the approved turn waits for a slow brain start: the turn is cancelled right before it would be sent (finding 1, I3)', async (t) => {
  const busyFlag = { value: false };
  const slow = gate();
  const h = harness(t, { busy: (index) => index === 0 && busyFlag.value, reply: PLAN_REPLY, start: (index) => (index === 1 ? slow.promise : null) });
  const { session, live, ws } = await reservedApproval(h, { busyFlag });
  assert.equal(approvedTurns(h).length, 0, 'reserved while the brain is busy');
  // Another MCP profile: the busy brain goes, and the reserved turn starts the next one, which is slow to start.
  say(ws, { type: 'switch_brain', brain: 'opencode', mcpProfile: 'minimal' });
  await waitFor(() => h.created.length === 2);
  assert.equal(h.runtime.isBusy(session.id), true, 'the approved turn is on its way');
  const mark = ws.sent.length;
  say(ws, { type: 'abort' }); // the Stop's new generation is synchronous, before its brain.abort() awaits
  slow.open(); // the brain is ready only after the Stop
  await waitFor(() => ws.sent.slice(mark).some((p) => p.type === 'reattach_result' && p.running === false));
  await settle();
  assert.deepEqual(h.turns.map((turn) => turn.text), ['plan it'], 'the approved turn never reached the new brain');
  assert.equal(h.runtime.isBusy(session.id), false);
  assert.equal(live.workActive, null);
  // Nothing is left behind: the next prompt runs on the new brain.
  say(ws, { type: 'query', prompt: 'status?', request_id: 'q-after-stop' });
  await waitFor(() => h.turns.length === 2);
  assert.deepEqual([h.turns[1].text, h.turns[1].brain], ['status?', 1]);
});

test('Stop drops an approved turn still queued behind a busy brain; the mailbox goes on once (I3)', async (t) => {
  const busyFlag = { value: false };
  const h = harness(t, { busy: (index) => index === 0 && busyFlag.value, reply: PLAN_REPLY });
  const { session, ws } = await reservedApproval(h, { busyFlag });
  h.runtime._internals.enqueueMailbox(h.runtime._internals.sessions.get(session.id), { kind: 'stalled', run: { runId: 'r-held' } });
  say(ws, { type: 'abort' });
  await settle();
  busyFlag.value = false;
  h.created[0].sink.send({ type: 'aborted' }); // the brain's own turn ends on the Stop
  await waitFor(() => h.turns.length === 2);
  assert.match(h.turns[1].text, /r-held/, 'the mailbox goes on');
  await waitFor(() => !h.runtime.isBusy(session.id));
  await settle();
  assert.equal(approvedTurns(h).length, 0, 'the Stop dropped the reserved turn');
  assert.equal(h.turns.length, 2);
});

test('A user Stop closes the card, drops held continuations and releases the mailbox hold exactly once; a late answer changes nothing (I3)', async (t) => {
  const h = harness(t, { config: { questionTimeoutMinutes: 0 }, reply: PLAN_REPLY });
  const { session, live, ws } = await h.open({ provider: 'opencode', planMode: true });
  say(ws, { type: 'query', prompt: 'plan it' });
  h.runtime.routerSinks().continueDirect(session.id, TIDY);
  const card = await waitFor(() => cardOf(ws));
  h.runtime._internals.enqueueMailbox(live, { kind: 'stalled', run: { runId: 'r-held' } });
  await waitFor(() => !live.mailboxTimer);
  await settle();
  assert.equal(h.turns.length, 1, 'the card holds the mailbox and the continuation (no timeout)');
  say(ws, { type: 'abort' });
  await waitFor(() => h.turns.length === 2);
  assert.match(h.turns[1].text, /r-held/);
  assert.ok(ws.packets('control_cancelled').some((p) => p.request_id === card.request_id && p.reason === 'stopped'));
  // A late approval, and the mailbox turn's end: no second release, no continuation, no plan.
  say(ws, { type: 'control_response', request_id: card.request_id, response: { behavior: 'allow' } });
  await waitFor(() => ws.packets('control_cancelled').filter((p) => p.request_id === card.request_id).length === 2);
  assert.equal(closedControlState(ws.packets('control_cancelled').at(-1).reason, 'plan'), 'cancelled', 'the UI shows Cancelled');
  await waitFor(() => !h.runtime.isBusy(session.id));
  await settle();
  assert.equal(h.turns.length, 2);
  assert.equal(events(ws, 'synabun.mailbox').length, 1, 'the mailbox was delivered once');
  assert.equal(h.runtime.isPlanning(session.id), true, 'nothing was approved');
});

test('A plan turn that still ends with its plan after a Stop raises no card: its generation is stale (I3)', async (t) => {
  const h = harness(t, { reply: PLAN_REPLY, delay: 40 });
  const { session, ws } = await h.open({ provider: 'opencode', planMode: true });
  say(ws, { type: 'query', prompt: 'plan it' });
  await waitFor(() => h.turns.length === 1);
  say(ws, { type: 'abort' }); // too late for the brain: it still finishes the reply with its plan
  await waitFor(() => ws.packets('done').length === 1);
  await settle();
  assert.equal(cardOf(ws), undefined, 'no plan card after the Stop');
  assert.deepEqual([h.runtime.pendingControls(session.id).length, h.runtime.isPlanning(session.id), h.runtime.isBusy(session.id)], [0, true, false]);
});

test('Closing a session clears its pending work: after a reattach the old plan never starts and prompts run (finding 2, I4)', async (t) => {
  const busyFlag = { value: false };
  const h = harness(t, { busy: (index) => index === 0 && busyFlag.value, reply: PLAN_REPLY });
  const { session, live } = await reservedApproval(h, { busyFlag });
  h.runtime.routerSinks().continueDirect(session.id, TIDY);
  assert.equal(h.runtime.isBusy(session.id), true, 'the approved turn is reserved');
  await h.runtime.closeSession(session.id);
  assert.equal(h.runtime.isBusy(session.id), false, 'nothing reserved outlives the session');
  // Reattach: the session is idle again, and the old busy brain's work ends meanwhile.
  const again = new FakeWs();
  await h.runtime.handleWebSocket(again, { pathname: `/ws/assistant/${session.id}` });
  busyFlag.value = false;
  h.created[0].sink.send({ type: 'done', code: 0 });
  await settle();
  say(again, { type: 'query', prompt: 'hello again', request_id: 'q-reattached' });
  await waitFor(() => h.turns.length === 2);
  assert.equal(h.turns[1].text, 'hello again');
  await waitFor(() => !h.runtime.isBusy(session.id));
  await settle();
  assert.ok(!again.packets('error').some((p) => p.code === 'ASSISTANT_BUSY'), 'no stale refusal');
  assert.deepEqual(h.turns.map((turn) => turn.text), ['plan it', 'hello again'], 'neither the old plan nor its continuation ran');
  assert.deepEqual([live.work.size, live.workActive, live.planCard], [0, null, null]);
});

test('A compact call that never returns holds the session only until a Stop or the session closing (I3, I4)', async (t) => {
  const compacts = [];
  const h = harness(t, { compact: (index) => { compacts.push(index); return new Promise(() => {}); } });
  const { session, ws } = await h.open({ provider: 'opencode' });
  say(ws, { type: 'query', prompt: 'hello' }); // a brain to compact
  await waitFor(() => ws.packets('done').length === 1);
  say(ws, { type: 'compact' });
  await waitFor(() => compacts.length === 1);
  assert.equal(h.runtime.isBusy(session.id), true, 'the compact holds the session');
  say(ws, { type: 'query', prompt: 'too early', request_id: 'q-early' });
  await waitFor(() => ws.packets('error').some((p) => p.request_id === 'q-early' && p.code === 'ASSISTANT_BUSY'));
  say(ws, { type: 'abort' });
  await settle();
  assert.equal(h.runtime.isBusy(session.id), false, 'the Stop cancelled it');
  say(ws, { type: 'compact' });
  await waitFor(() => compacts.length === 2);
  assert.equal(h.runtime.isBusy(session.id), true);
  await h.runtime.closeSession(session.id);
  const again = new FakeWs();
  await h.runtime.handleWebSocket(again, { pathname: `/ws/assistant/${session.id}` });
  assert.equal(h.runtime.isBusy(session.id), false, 'nothing of the closed session holds the reattached one');
  say(again, { type: 'query', prompt: 'after the reattach', request_id: 'q-after' });
  await waitFor(() => h.turns.some((turn) => turn.text === 'after the reattach'));
  assert.ok(!again.packets('error').length);
});

test('A "do it here" pick that arrives after a newer prompt (the router awaited the catalog) is refused: the old task never runs (finding 3, I5)', async (t) => {
  const h = harness(t, { reply: PLAN_REPLY, delay: 30 });
  const { session, ws } = await h.open({ provider: 'opencode', planMode: true });
  const sinks = h.runtime.routerSinks();
  say(ws, { type: 'query', prompt: 'plan it' });
  await waitFor(() => h.turns.length === 1);
  // During the plan turn the brain raised a route card.
  const routeCard = { type: 'control_request', request_id: 'route-r9', request: { subtype: 'route', kind: 'route', provider: 'synabun', routeId: 'route-r9', origin: 'agent_route', runIds: [], sessionId: session.id, mode: 'always-ask' } };
  sinks.sendCard(session.id, routeCard);
  const first = await waitFor(() => cardOf(ws));
  say(ws, { type: 'query', prompt: 'plan the billing change instead' });
  const second = await waitFor(() => { const c = cardOf(ws); return c && c.request_id !== first.request_id ? c : null; });
  // The user picked "do it here" on the old card; the router's callback arrives only now.
  assert.equal(sinks.continueDirect(session.id, { target: TIDY.target, route: { summary: 'tidy the docs', routeId: 'route-r9' } }), false);
  say(ws, { type: 'control_response', request_id: second.request_id, response: { behavior: 'deny', message: 'Keep planning — revise the plan.' } });
  await waitFor(() => ws.packets('reattach_result').at(-1)?.running === false);
  await settle();
  assert.deepEqual(h.turns.map((turn) => turn.text), ['plan it', 'plan the billing change instead'], 'the old task\'s continuation never ran');
  // A pick for a card of the current turn still runs.
  sinks.sendCard(session.id, { ...routeCard, request_id: 'route-r10', request: { ...routeCard.request, routeId: 'route-r10' } });
  assert.equal(sinks.continueDirect(session.id, { target: TIDY.target, route: { summary: 'tidy the docs', routeId: 'route-r10' } }), true);
  await waitFor(() => h.turns.length === 3);
  assert.match(h.turns[2].text, /chose to run "tidy the docs" here/);
});

test('/compact is session work: an approval during OpenCode\'s compact waits for it, a prompt from another host is refused to that host, the card survives (finding 4, I6)', async (t) => {
  const compacting = gate();
  const h = harness(t, { reply: PLAN_REPLY, compact: () => compacting.promise });
  const { session, ws } = await h.open({ provider: 'opencode', planMode: true });
  const other = new FakeWs();
  await h.runtime.handleWebSocket(other, { pathname: `/ws/assistant/${session.id}` });
  say(ws, { type: 'query', prompt: 'plan it' });
  const card = await waitFor(() => cardOf(ws));
  say(ws, { type: 'compact' });
  await waitFor(() => h.runtime.isBusy(session.id));
  assert.deepEqual(h.runtime.pendingControls(session.id).map((p) => p.request_id), [card.request_id], 'the card survives the compact');
  say(other, { type: 'query', prompt: 'and rename the table', request_id: 'q-other' });
  const refusal = await waitFor(() => other.packets('error').find((p) => p.request_id === 'q-other'));
  assert.deepEqual([refusal.code, /compacting/.test(refusal.message)], ['ASSISTANT_BUSY', true]);
  say(ws, { type: 'control_response', request_id: card.request_id, response: { behavior: 'allow' } });
  await waitFor(() => !h.runtime.isPlanning(session.id));
  await settle();
  assert.equal(h.turns.length, 1, 'nothing starts while the compact runs');
  compacting.open();
  const work = await waitFor(() => h.turns[1]);
  assert.match(work.text, /approved your plan/, 'then the approved turn, first');
  assert.ok(!ws.packets('error').some((p) => p.request_id === 'q-other' || p.code === 'ASSISTANT_BUSY'), 'the other host\'s refusal never reached this one');
});

test('/compact on a Codex brain is a turn of its own: an approval during it waits for its end (finding 4, I6)', async (t) => {
  const compacting = gate();
  const server = codexAppServer((query) => (query.planMode ? codexProposes(PLAN) : codexSays('Done.')), { hold: (query) => (query.prompt === '/compact' ? compacting.promise : null) });
  const h = harness(t, { real: { handleCodexSkinWebSocket: server.handle } });
  const { session, ws } = await h.open({ provider: 'codex', planMode: true });
  say(ws, { type: 'query', prompt: 'plan the cache move' });
  const card = await waitFor(() => cardOf(ws));
  say(ws, { type: 'compact' });
  await waitFor(() => server.queries.length === 2);
  assert.equal(server.queries[1].prompt, '/compact');
  say(ws, { type: 'control_response', request_id: card.request_id, response: { behavior: 'allow' } });
  await waitFor(() => !h.runtime.isPlanning(session.id));
  await settle();
  assert.equal(server.queries.length, 2, 'the brain reports its compaction turn busy: nothing is sent during it');
  compacting.open();
  await waitFor(() => server.queries.length === 3);
  assert.match(server.queries[2].prompt, /approved your plan/);
  assert.equal(server.queries[2].planMode, false);
});

test('The approved turn is the next turn: a gate nudge, a held continuation, a late pick and the mailbox all go after it (I2)', async (t) => {
  const busyFlag = { value: false };
  const h = harness(t, { busy: (index) => index === 0 && busyFlag.value, reply: PLAN_REPLY });
  const { session, live, ws } = await h.open({ provider: 'opencode', planMode: true });
  say(ws, { type: 'query', prompt: 'plan it' });
  h.runtime.routerSinks().continueDirect(session.id, TIDY);
  const card = await waitFor(() => cardOf(ws));
  busyFlag.value = true;
  say(ws, { type: 'control_response', request_id: card.request_id, response: { behavior: 'allow' } });
  await waitFor(() => !h.runtime.isPlanning(session.id));
  // The brain's own busy turn: the reactive gate refuses a tool in it (a nudge follows its end), a result
  // arrives for the mailbox, and a second pick arrives late for the current turn.
  h.created[0].sink.send({ type: 'event', event: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }] } } });
  assert.ok(live.gateNudge, 'the reactive gate refused the tool');
  h.runtime._internals.enqueueMailbox(live, { kind: 'stalled', run: { runId: 'r-held' } });
  assert.equal(h.runtime.routerSinks().continueDirect(session.id, { ...TIDY, route: { summary: 'tidy the docs', routeId: 'r2' } }), true);
  await waitFor(() => !live.mailboxTimer);
  await settle();
  assert.equal(h.turns.length, 1, 'nothing starts while the brain is busy');
  busyFlag.value = false;
  h.created[0].sink.send({ type: 'done', code: 0 });
  await waitFor(() => h.turns.length === 5, { timeout: 3000 });
  const kinds = h.turns.slice(1).map((turn) => (/approved your plan/.test(turn.text) ? 'plan' : /last tool call was stopped/.test(turn.text) ? 'nudge' : /chose to run/.test(turn.text) ? 'continuation' : /r-held/.test(turn.text) ? 'mailbox' : turn.text));
  assert.deepEqual(kinds, ['plan', 'nudge', 'continuation', 'mailbox']);
});

test('A prompt sent while the approved turn is reserved is refused to its sender alone, with its request id; WhatsApp gets the result only (finding 5, I7)', async (t) => {
  const busyFlag = { value: false };
  const h = harness(t, { busy: (index) => index === 0 && busyFlag.value, reply: PLAN_REPLY });
  const { session, ws } = await reservedApproval(h, { busyFlag });
  const other = new FakeWs();
  await h.runtime.handleWebSocket(other, { pathname: `/ws/assistant/${session.id}` });
  const mark = ws.sent.length;
  say(other, { type: 'query', prompt: 'first, rename the table', request_id: 'q-rename' });
  const refusal = await waitFor(() => other.packets('error').find((p) => p.request_id === 'q-rename'));
  assert.deepEqual([refusal.code, refusal.message], ['ASSISTANT_BUSY', 'The approved plan runs first; send this after it.']);
  await waitFor(() => other.packets('reattach_result').at(-1)?.running === true);
  const phone = await h.runtime.submit(session.id, { text: 'from the phone', origin: 'whatsapp', requireIdle: false });
  assert.equal(phone.code, 'ASSISTANT_BUSY', 'the API caller gets the result');
  await settle();
  assert.ok(!ws.sent.slice(mark).some((p) => p.type === 'error'), 'the host that did not send it hears no error');
  assert.ok(!other.sent.some((p) => p.type === 'error' && p.request_id !== 'q-rename'));
  assert.ok(!h.turns.some((turn) => /rename the table|from the phone/.test(turn.text)), 'refused, never run out of order');
  // The approved turn runs as soon as the brain is free; then the same prompt goes through.
  busyFlag.value = false;
  h.created[0].sink.send({ type: 'done', code: 0 });
  await waitFor(() => approvedTurns(h).length === 1);
  await waitFor(() => !h.runtime.isBusy(session.id));
  say(other, { type: 'query', prompt: 'first, rename the table', request_id: 'q-rename-2' });
  await waitFor(() => h.turns.at(-1).text === 'first, rename the table');
});

// ── Overlaps: Close during a brain start, prompt order, a late pick, a refused Codex query ──

test('Close while a prompt waits for its brain to start: that prompt never reaches the brain and its sender gets the text back; nothing is taken during the close; the reattached session runs prompts (finding 1, I4)', async (t) => {
  const starting = gate();
  const disposing = gate();
  t.after(() => { starting.open(); disposing.open(); }); // before the harness's shutdown, which disposes brain 0
  const h = harness(t, { start: (index) => (index === 0 ? starting.promise : null), dispose: (index) => (index === 0 ? disposing.promise : null) });
  const { session, live, ws } = await h.open({ provider: 'opencode' });
  say(ws, { type: 'query', prompt: 'before the close', request_id: 'q-before' });
  await waitFor(() => h.created.length === 1); // brain 0 is starting
  const closing = h.runtime.closeSession(session.id);
  // Closing is marked before anything awaits: nothing counts as busy, and no prompt is taken.
  assert.equal(h.runtime.isBusy(session.id), false);
  assert.equal((await h.runtime.submit(session.id, { text: 'from the phone', origin: 'whatsapp', requireIdle: false })).code, 'SESSION_ENDED');
  assert.equal(ws.packets('error').length, 0, 'the phone\'s refusal reaches no window');
  say(ws, { type: 'query', prompt: 'during the close', request_id: 'q-during' });
  assert.equal((await waitFor(() => ws.packets('error').find((p) => p.request_id === 'q-during'))).code, 'SESSION_ENDED');
  // The brain is ready only now, while it is still being disposed: the prompt is dropped, not sent.
  starting.open();
  assert.equal((await waitFor(() => ws.packets('error').find((p) => p.request_id === 'q-before'))).code, 'TURN_CANCELLED');
  disposing.open();
  await closing;
  const again = new FakeWs();
  await h.runtime.handleWebSocket(again, { pathname: `/ws/assistant/${session.id}` });
  assert.equal(again.packets('reattach_result')[0].running, false);
  say(again, { type: 'query', prompt: 'after the reattach', request_id: 'q-after' });
  await waitFor(() => h.turns.length === 1);
  assert.deepEqual([h.turns[0].text, h.turns[0].brain], ['after the reattach', 1], 'on a new brain');
  await quiet(h, live);
  assert.ok(!again.packets('error').length, 'no ASSISTANT_BUSY after the reattach');
  assert.deepEqual(h.turns.map((turn) => turn.text), ['after the reattach'], 'nothing from before the close reached a brain');
});

test('A socket that reattaches while Close disposes the brain waits for it: nothing starts or revives early, nothing of the old brain stays busy, and its start failing later touches nothing (finding 1, I4)', async (t) => {
  const starting = gate();
  const disposing = gate();
  const startingNext = gate();
  t.after(() => { starting.open(); disposing.open(); startingNext.open(); }); // before the harness's shutdown, which disposes the brains
  const h = harness(t, { start: (index) => (index === 0 ? starting.promise : startingNext.promise), dispose: (index) => (index === 0 ? disposing.promise : null) });
  const { session, live, ws } = await h.open({ provider: 'opencode' });
  say(ws, { type: 'query', prompt: 'before the close', request_id: 'q-before' });
  await waitFor(() => h.created.length === 1);
  const closing = h.runtime.closeSession(session.id);
  const again = new FakeWs();
  const attaching = h.runtime.handleWebSocket(again, { pathname: `/ws/assistant/${session.id}` });
  say(again, { type: 'query', prompt: 'sent while it closes', request_id: 'q-early' });
  // While it closes nothing starts: not a batch of worker results, not a late "do it here" pick.
  h.runtime._internals.enqueueMailbox(live, { kind: 'stalled', run: { runId: 'r-closing' } });
  assert.equal(h.runtime.routerSinks().continueDirect(session.id, TIDY), false);
  await waitFor(() => !live.mailboxTimer);
  await settle();
  assert.deepEqual(again.sent, [], 'not attached while the brain is disposed: nothing revived it');
  assert.equal(h.created.length, 1, 'no brain started for anything meanwhile');
  disposing.open();
  await closing;
  await attaching;
  assert.equal(again.packets('reattach_result')[0].running, false);
  // The message it sent meanwhile goes now, on a new brain; the old prompt still waits for brain 0.
  await waitFor(() => h.created.length === 2);
  assert.deepEqual([live.turnPending, h.runtime.isBusy(session.id)], [1, true], 'only the new prompt counts');
  // Brain 0 fails to start only now: its prompt is dropped and counted off nothing; the new brain stays.
  starting.fail(new Error('Codex app-server did not become ready'));
  await waitFor(() => ws.packets('error').some((p) => p.request_id === 'q-before'));
  await settle();
  assert.equal(live.turnPending, 1, 'the new prompt still counts');
  assert.equal(h.created[1].brain.disposed, false, 'the new brain was not disposed');
  startingNext.open();
  await waitFor(() => h.turns.length === 2); // the new prompt, then the worker results that waited
  await quiet(h, live);
  assert.deepEqual(h.turns.map((turn) => turn.brain), [1, 1]);
  assert.deepEqual([h.turns[0].text, /\[SynaBun Mailbox\][\s\S]*stalled/.test(h.turns[1].text)], ['sent while it closes', true]);
  assert.ok(!again.packets('error').length, 'the reattached window hears nothing of the old brain');
  say(again, { type: 'query', prompt: 'next', request_id: 'q-next' });
  await waitFor(() => h.turns.length === 3);
  assert.equal(h.turns[2].text, 'next');
  assert.ok(!h.turns.some((turn) => /before the close|tidy the docs/.test(turn.text)), 'nothing from before the close, or during it, ran');
});

test('Close while a brain start builds its persona: after a reattach the brain a newer prompt started stays the session\'s; the old start creates none and its prompt is dropped (finding 1, I4)', async (t) => {
  const building = gate();
  const builds = [];
  t.after(() => building.open());
  const h = harness(t, { persona: (call) => { builds.push(call); return call === 0 ? building.promise : null; } });
  const { session, live, ws } = await h.open({ provider: 'opencode' });
  say(ws, { type: 'query', prompt: 'before the close', request_id: 'q-before' });
  await waitFor(() => builds.length === 1); // its start waits in personaFor, before any brain exists
  await h.runtime.closeSession(session.id);
  const again = new FakeWs();
  await h.runtime.handleWebSocket(again, { pathname: `/ws/assistant/${session.id}` });
  say(again, { type: 'query', prompt: 'after the reattach', request_id: 'q-after' });
  await waitFor(() => h.turns.length === 1);
  assert.deepEqual([h.turns[0].text, h.turns[0].brain], ['after the reattach', 0]);
  // The old start resumes only now, while brain 0 runs the new turn.
  building.open();
  assert.equal((await waitFor(() => ws.packets('error').find((p) => p.request_id === 'q-before'))).code, 'TURN_CANCELLED');
  await quiet(h, live);
  assert.equal(h.created.length, 1, 'the stale start created no brain');
  assert.equal(live.brain, h.created[0].brain, 'brain 0 is still the session\'s');
  assert.equal(h.created[0].brain.disposed, false);
  say(again, { type: 'query', prompt: 'next', request_id: 'q-next' });
  await waitFor(() => h.turns.length === 2);
  assert.deepEqual(h.turns.map((turn) => [turn.text, turn.brain]), [['after the reattach', 0], ['next', 0]], 'the next prompt goes to brain 0; the old one reached none');
  assert.ok(!again.packets('error').length, 'the reattached window hears nothing of the old prompt');
});

test('A brain start overtaken by a Close nobody reattached to, or by the shutdown, leaves nothing: no brain assigned, no turn sent, its prompt dropped (finding 1, I4)', async (t) => {
  for (const [end, held] of [['close', 'persona'], ['shutdown', 'persona'], ['shutdown', 'start']]) {
    const holding = gate();
    const holds = [];
    t.after(() => holding.open());
    const hold = (index) => { holds.push(index); return holding.promise; };
    const h = harness(t, held === 'persona' ? { persona: hold } : { start: hold });
    const { session, live, ws } = await h.open({ provider: 'opencode' });
    say(ws, { type: 'query', prompt: 'hello', request_id: 'q-hello' });
    await waitFor(() => holds.length === 1);
    if (end === 'close') await h.runtime.closeSession(session.id); else await h.runtime.shutdown();
    holding.open();
    const label = `${end} during the ${held}`;
    assert.equal((await waitFor(() => ws.packets('error').find((p) => p.request_id === 'q-hello'))).code, 'TURN_CANCELLED', label);
    await settle();
    assert.deepEqual([h.created.length, live.brain, h.turns.length], [held === 'start' ? 1 : 0, null, 0], `${label}: no brain, no turn`);
    assert.ok(h.created.every((c) => c.brain.disposed), `${label}: the brain it made went with the shutdown`);
    if (end === 'close') assert.equal(live.record.status, 'ended', 'the closed session stays ended');
  }
});

test('A brain start that begins while Close disposes the brain gets none, even when its persona is ready only after the close (finding 1, I4)', async (t) => {
  const building = gate();
  const disposing = gate();
  t.after(() => { building.open(); disposing.open(); });
  const h = harness(t, { persona: (call) => (call === 1 ? building.promise : null), dispose: (index) => (index === 0 ? disposing.promise : null) });
  const { session, live } = await h.open({ provider: 'opencode' });
  await h.runtime._internals.ensureBrain(live);
  const closing = h.runtime.closeSession(session.id);
  await waitFor(() => live.brain === null); // the close took brain 0 and waits for its disposal
  const late = h.runtime._internals.ensureBrain(live);
  disposing.open();
  await closing;
  building.open();
  assert.equal(await late, null);
  await settle();
  assert.deepEqual([h.created.length, live.brain, live.record.status], [1, null, 'ended']);
});

test('Two brain starts at once (the mailbox\'s still builds its persona when a prompt starts one): the late start takes the brain the other assigned and never replaces it (finding 1)', async (t) => {
  const building = gate();
  const builds = [];
  t.after(() => building.open());
  const h = harness(t, { persona: (call) => { builds.push(call); return call === 0 ? building.promise : null; } });
  const { live, ws } = await h.open({ provider: 'opencode' });
  h.runtime._internals.enqueueMailbox(live, { kind: 'stalled', run: { runId: 'r-1' } });
  await waitFor(() => builds.length === 1); // the mailbox's turn starts the brain
  say(ws, { type: 'query', prompt: 'hello', request_id: 'q-hello' });
  await waitFor(() => h.turns.length === 1);
  building.open();
  await waitFor(() => h.turns.length === 2);
  await quiet(h, live);
  assert.equal(h.created.length, 1, 'one brain');
  assert.equal(live.brain, h.created[0].brain);
  assert.deepEqual(h.turns.map((turn) => turn.brain), [0, 0]);
  assert.deepEqual([h.turns[0].text, /\[SynaBun Mailbox\][\s\S]*stalled/.test(h.turns[1].text)], ['hello', true]);
});

test('Close while a prompt recalls: when its recall returns it is dropped before it touches the reopened session (its model, its memories) (finding 1, I4)', async (t) => {
  const recalling = gate();
  const recalled = [];
  t.after(() => recalling.open());
  const memory = { recallForPrompt: async ({ prompt }) => { recalled.push(prompt); if (prompt === 'before the close') await recalling.promise; return { results: [{ id: prompt === 'before the close' ? 'm-old' : 'm-new' }] }; } };
  const h = harness(t, { memory });
  const { session, live, ws } = await h.open({ provider: 'opencode' });
  say(ws, { type: 'query', prompt: 'before the close', model: 'model-old', request_id: 'q-before' });
  await waitFor(() => recalled.length === 1);
  await h.runtime.closeSession(session.id);
  const again = new FakeWs();
  await h.runtime.handleWebSocket(again, { pathname: `/ws/assistant/${session.id}` });
  say(again, { type: 'query', prompt: 'after the reattach', model: 'model-new', request_id: 'q-after' });
  await waitFor(() => h.turns.length === 1);
  recalling.open();
  assert.equal((await waitFor(() => ws.packets('error').find((p) => p.request_id === 'q-before'))).code, 'TURN_CANCELLED');
  await quiet(h, live);
  assert.equal(live.record.brain.model, 'model-new', 'the old prompt\'s model never lands on the record');
  assert.deepEqual(events(again, 'synabun.memories').flatMap((event) => event.memories.map((m) => m.id)), ['m-new'], 'nor its memories on the reopened session');
  assert.deepEqual(h.turns.map((turn) => [turn.text, turn.brain]), [['after the reattach', 1]]);
});

test('Prompts reach the brain in the order they came: one sent while another is still on its way is refused to its sender (text back), and a Stop does not cancel the one on its way (finding 2, I5, I7)', async (t) => {
  const recalling = gate();
  const recalled = [];
  const memory = { recallForPrompt: async ({ prompt }) => { recalled.push(prompt); if (prompt === 'older') await recalling.promise; return { results: [] }; } };
  const h = harness(t, { memory });
  const { session, live, ws } = await h.open({ provider: 'opencode' });
  const other = new FakeWs();
  await h.runtime.handleWebSocket(other, { pathname: `/ws/assistant/${session.id}` });
  say(ws, { type: 'query', prompt: 'older', request_id: 'q-older' });
  await waitFor(() => recalled.includes('older')); // its recall is held
  say(other, { type: 'query', prompt: 'newer', request_id: 'q-newer' });
  const refusal = await waitFor(() => other.packets('error').find((p) => p.request_id === 'q-newer'));
  assert.deepEqual([refusal.code, refusal.message], ['ASSISTANT_BUSY', 'Another message is still on its way to the assistant; send this after it.']);
  assert.equal((await h.runtime.submit(session.id, { text: 'from the phone', origin: 'whatsapp', requireIdle: false })).code, 'ASSISTANT_BUSY');
  // A Stop while it is on its way: that prompt still runs (the documented exception).
  say(ws, { type: 'abort' });
  await settle();
  recalling.open();
  await waitFor(() => h.turns.length === 1);
  await quiet(h, live);
  say(other, { type: 'query', prompt: 'newer', request_id: 'q-newer-2' });
  await waitFor(() => h.turns.length === 2);
  assert.deepEqual(h.turns.map((turn) => turn.text), ['older', 'newer']);
  assert.ok(!ws.packets('error').length, 'the window that sent first hears no error');
  assert.deepEqual(recalled, ['older', 'newer'], 'the refused prompt never started its setup');
});

test('A "do it here" pick on a route card whose turn a newer prompt replaced is not approved: the card expires on every host, the turn that asked hears it, nothing continues (finding 3, I5)', async (t) => {
  const h = harness(t, { routing: true });
  const { session, live, ws } = await h.open({ provider: 'claude-code' });
  const other = new FakeWs();
  await h.runtime.handleWebSocket(other, { pathname: `/ws/assistant/${session.id}` });
  say(ws, { type: 'set_route_mode', mode: 'always-ask' });
  say(ws, { type: 'query', prompt: 'tidy the docs', request_id: 'q-1' });
  await waitFor(() => h.turns.length === 1);
  const ask = () => h.router.propose({ sessionId: session.id, body: { task_class: 'quick', confidence: 0.9, summary: 'tidy the docs', proposals: [{ kind: 'direct' }] }, waitMs: 5000 });
  const routeCards = () => ws.packets('control_request').filter((p) => p.request?.subtype === 'route');
  const here = { optionId: 'other', target: { kind: 'direct', provider: 'claude-code', model: 'claude-opus-5-5' } };
  // In that turn the brain asks agent_route twice; both cards wait for the user.
  const asked = [ask(), ask()];
  await waitFor(() => routeCards().length === 2);
  const [stale, staleToo] = routeCards();
  // A newer prompt replaces that turn; the picks arrive only now.
  say(ws, { type: 'query', prompt: 'update the changelog instead', request_id: 'q-2' });
  await waitFor(() => h.turns.length === 2);
  say(ws, { type: 'control_response', request_id: stale.request_id, response: here });
  const cancelled = await waitFor(() => other.packets('control_cancelled').find((p) => p.request_id === stale.request_id));
  assert.equal(closedControlState(cancelled.reason, 'route'), 'expired', 'every host shows the card Expired');
  assert.ok(events(other, 'synabun.route').some((e) => e.phase === 'expired' && e.route.routeId === stale.request.routeId));
  await waitFor(() => events(ws, 'system').some((e) => e.subtype === 'status' && /route card expired/.test(e.text)));
  assert.ok(!ws.packets('control_resolved').some((p) => p.request_id === stale.request_id), 'not reported answered');
  assert.ok(!ws.packets('error').length, 'no error that would end the running turn in the panel');
  // WhatsApp and the API get the refusal as their result.
  const late = await h.runtime.answerControl(session.id, staleToo.request_id, here, { origin: 'whatsapp' });
  assert.deepEqual([late.ok, late.code, late.reason], [false, 'ROUTE_EXPIRED', 'superseded']);
  for (const heard of await Promise.all(asked)) assert.deepEqual([heard.status, heard.continuation, /no longer valid/.test(heard.next)], ['expired', false, true], 'the turn that asked is told not to start it');
  await quiet(h, live);
  assert.ok(!h.turns.some((turn) => /chose to run/.test(turn.text)), 'nothing continued');
  // The same pick on a card of the current turn is approved and continues.
  const current = ask();
  const fresh = await waitFor(() => routeCards().find((p) => ![stale.request_id, staleToo.request_id].includes(p.request_id)));
  assert.deepEqual(await h.runtime.answerControl(session.id, fresh.request_id, here, { origin: 'ui' }), { ok: true, kind: 'route' });
  assert.equal((await current).continuation, true);
  await waitFor(() => h.turns.some((turn) => /chose to run "tidy the docs" here/.test(turn.text)));
});

test('Codex: a query Codex refuses before a turn starts (turn/start rejected, no turn/completed) ends there: the brain is free and scheduled work goes on (finding 4)', async (t) => {
  const refusing = gate();
  const server = codexAppServer(() => codexSays('Done.'), {
    hold: (query) => (query.prompt === 'first' ? refusing.promise : null),
    reject: (query) => (query.prompt === 'first' ? 'turn/start failed: the thread is active in another window' : null),
  });
  const h = harness(t, { real: { handleCodexSkinWebSocket: server.handle } });
  const { session, live, ws } = await h.open({ provider: 'codex' });
  say(ws, { type: 'query', prompt: 'first', request_id: 'q-first' });
  await waitFor(() => server.queries.length === 1);
  // A worker result arrives meanwhile: it waits for the brain.
  h.runtime._internals.enqueueMailbox(live, { kind: 'stalled', run: { runId: 'r-held' } });
  await waitFor(() => !live.mailboxTimer && live.workTimer); // the scheduler saw the brain busy
  assert.equal(server.queries.length, 1);
  refusing.open();
  await waitFor(() => ws.packets('error').some((p) => /active in another window/.test(p.message)));
  assert.equal(ws.packets('done').at(-1).code, 1, 'the refused turn ends');
  await waitFor(() => server.queries.length === 2);
  assert.match(server.queries[1].prompt, /r-held|stalled/i, 'the mailbox reached Codex');
  await quiet(h, live);
  assert.equal(live.brain.isBusy(), false);
});

test('Composer: a refused prompt goes back in (text before anything typed since, attachments too); the panel path is driven in assistant-ui.browser.mjs (finding 5, I7)', (t) => {
  const saved = globalThis.document;
  const made = [];
  globalThis.document = { createElement: (tag) => { const node = new ShimNode(tag); made.push(node); return node; }, activeElement: null };
  t.after(() => { globalThis.document = saved; });
  const drafts = [];
  const composer = createComposer(new ShimNode('div'), { onDraftChange: (text) => drafts.push(text) });
  composer.restore({ text: 'first, rename the table', images: [{ base64: 'AAA', mediaType: 'image/png', name: 'a.png' }], uploads: [{ name: 'spec.pdf', size: 10, mime: 'application/pdf', path: '/tmp/spec.pdf' }] });
  assert.deepEqual([composer.getText(), composer.hasContent(), drafts.at(-1)], ['first, rename the table', true, 'first, rename the table']);
  assert.match(made[0].find('.asst-composer-attachments').innerHTML, /a\.png[\s\S]*spec\.pdf/, 'the attachments come back too');
  composer.setText('and one more thing');
  composer.restore({ text: 'Use the SynaBun recall tool…', display: '/recall cache' });
  assert.equal(composer.getText(), '/recall cache\n\nand one more thing', 'the words the user typed, before what they typed since');
});

test('Remote (WhatsApp) sessions: no runtime plan card, the level clamps the modes, Stop and submit behave as before (I10)', async (t) => {
  const h = harness(t, { reply: PLAN_REPLY, remotePolicy: createRemotePolicyRegistry() });
  const session = await h.runtime.createSession({ brain: { provider: 'codex', planMode: true } }, { remote: { channel: 'whatsapp', level: 'ask' } });
  const ws = new FakeWs();
  await h.runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${session.id}` });
  assert.deepEqual(await h.runtime.submit(session.id, { text: 'plan it', origin: 'whatsapp' }), { ok: true });
  await waitFor(() => !h.runtime.isBusy(session.id));
  await settle();
  assert.equal(cardOf(ws), undefined, 'a remote session gets no runtime-owned plan card');
  say(ws, { type: 'set_permission_mode', mode: 'auto', planMode: false });
  await waitFor(() => ws.packets('assistant:session').some((p) => p.reason === 'remote'));
  assert.deepEqual([h.runtime.getSession(session.id).brain.permissionMode, h.runtime.getSession(session.id).brain.planMode], ['default', true], 'a Codex brain stays read-only');
  assert.deepEqual(await h.runtime.stopTurn(session.id, { origin: 'whatsapp' }), { ok: true });
  assert.deepEqual(await h.runtime.submit(session.id, { text: 'look around', origin: 'whatsapp' }), { ok: true });
  await waitFor(() => h.turns.length === 2);
  assert.deepEqual(h.turns.map((turn) => turn.planMode), [true, true]);
});

/** Just enough DOM for createComposer: every selector gets its own node; innerHTML stays a string. */
class ShimNode {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.nodes = new Map(); this.style = {}; this.dataset = {}; this.value = ''; this.innerHTML = ''; this.hidden = false; this.disabled = false; this.placeholder = ''; this.scrollHeight = 0; this.id = ''; }
  get classList() { return { add() {}, remove() {}, toggle() {}, contains: () => false }; }
  get firstChild() { return this.innerHTML ? {} : null; }
  find(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new ShimNode('div')); return this.nodes.get(selector); }
  querySelector(selector) { return this.find(selector); }
  querySelectorAll() { return []; }
  appendChild(node) { return node; }
  setAttribute() {}
  removeAttribute() {}
  addEventListener() {}
  focus() {}
  setSelectionRange() {}
  scrollIntoView() {}
  remove() {}
}

// ── Codex: a proposed plan only in a plan turn (real brain + translator) ──────

test('Codex, an ordinary turn: task progress and a stray plan item never reach the answer or result.plan; text that mentions the tags is untouched', async (t) => {
  const TODO = '- [x] Add the store\n- [ ] Switch the readers';
  const server = codexAppServer((query) => (/explain/.test(query.prompt)
    ? codexSays('Codex wraps a plan in <proposed_plan>…</proposed_plan> tags.')
    : [codexChecklist, ['item/plan/delta', { itemId: 'p1', delta: TODO }], ['item/completed', { item: { id: 'p1', type: 'plan', text: TODO } }], ...codexSays('Implemented and tested.')]));
  const h = harness(t, { real: { handleCodexSkinWebSocket: server.handle } });
  const { live, ws } = await h.open({ provider: 'codex', planMode: false });
  await h.runtime._internals.runQuery(live, { text: 'do the cache move', origin: 'ui' });
  await waitFor(() => events(ws, 'result').length === 1);
  assert.equal(server.queries[0].planMode, false);
  assert.equal(finalText(ws), 'Implemented and tested.');
  assert.deepEqual([events(ws, 'result')[0].result, events(ws, 'result')[0].plan], ['Implemented and tested.', undefined]);
  const streamed = events(ws, 'stream_event').map((e) => e.event?.delta?.text).filter(Boolean).join('');
  assert.equal(streamed, 'Implemented and tested.', 'only the answer streams');
  await h.runtime._internals.runQuery(live, { text: 'explain the plan format', origin: 'ui' });
  await waitFor(() => events(ws, 'result').length === 2);
  assert.equal(finalText(ws), 'Codex wraps a plan in <proposed_plan>…</proposed_plan> tags.');
  assert.equal(events(ws, 'result')[1].plan, undefined);
  await settle(); // a card would come with the turn's `done`, right after its result
  assert.equal(cardOf(ws), undefined);
});

test('Codex plan mode: a checklist followed by a question is no plan; the proposed plan item is', async (t) => {
  const server = codexAppServer((query) => (/ask/.test(query.prompt)
    ? [codexChecklist, ...codexSays('Which database should it use?\n1. Postgres\n2. SQLite')]
    : [codexChecklist, ...codexProposes(PLAN)]));
  const h = harness(t, { real: { handleCodexSkinWebSocket: server.handle } });
  const { live, ws } = await h.open({ provider: 'codex', planMode: true });
  await h.runtime._internals.runQuery(live, { text: 'ask me first', origin: 'ui' });
  await waitFor(() => events(ws, 'result').length === 1);
  await settle();
  assert.equal(cardOf(ws), undefined);
  assert.equal(events(ws, 'result')[0].plan, undefined);
  await h.runtime._internals.runQuery(live, { text: 'plan it', origin: 'ui' });
  const card = await waitFor(() => cardOf(ws));
  assert.equal(card.request.input.plan, PLAN);
  assert.equal(finalText(ws), `Here is the plan.\n\n${PLAN}`);
  assert.deepEqual(server.queries.map((q) => q.planMode), [true, true]);
});

// ── OpenCode: the <proposed_plan> block is the proposal (real brain + translator) ──

test('OpenCode: a numbered clarifying question gets no card, a prose plan in a <proposed_plan> block does; only plan turns are asked for the block', async (t) => {
  const PROSE = 'Move the cache into the new store first, then switch every reader over to it, and drop the old table once nothing reads it.';
  const serve = openCodeServe((request) => {
    const text = request.parts[0].text;
    if (/ask me/.test(text)) return 'Before I plan this, which database should hold the cache?\n1. Postgres\n2. SQLite\n3. Keep Redis';
    if (/plan it/.test(text)) return `Here is my plan.\n<proposed_plan>\n${PROSE}\n</proposed_plan>\nWant any changes?`;
    return 'Done.';
  });
  const h = harness(t, { real: serve.deps });
  const { session, live, ws } = await h.open({ provider: 'opencode', planMode: true });
  await h.runtime._internals.runQuery(live, { text: 'ask me first', origin: 'ui' });
  await waitFor(() => events(ws, 'result').length === 1);
  await settle();
  assert.equal(cardOf(ws), undefined, 'a question is not a plan, numbered or not');
  assert.equal(serve.prompts[0].agent, 'plan');
  assert.ok(serve.prompts[0].system.includes(OPENCODE_PLAN_INSTRUCTIONS));
  await h.runtime._internals.runQuery(live, { text: 'now plan it', origin: 'ui' });
  const card = await waitFor(() => cardOf(ws));
  assert.equal(card.request.input.plan, PROSE);
  assert.equal(finalText(ws), `Here is my plan.\n\n${PROSE}\n\nWant any changes?`, 'the tags never show');
  // Approved: the work runs on the build agent, not asked for a plan.
  await h.runtime.answerControl(session.id, card.request_id, { behavior: 'allow' }, { origin: 'ui' });
  await waitFor(() => serve.prompts.length === 3);
  assert.notEqual(serve.prompts[2].agent, 'plan');
  assert.ok(!String(serve.prompts[2].system || '').includes('<proposed_plan>'));
  // A remote session's read-only plan agent is not planning: no instructions, no card to offer.
  const remote = openCodeServe(() => 'ok');
  const brain = createOpenCodeBrain({ session: { id: 'remote-1', brain: { provider: 'opencode', planMode: true } }, sink: { send() {} }, persona: 'PERSONA', deps: { ...remote.deps, remoteReadOnly: true } });
  t.after(() => brain.dispose());
  await brain.sendUserTurn({ text: 'look around', planMode: true });
  assert.deepEqual([remote.prompts[0].agent, remote.prompts[0].system], ['plan', 'PERSONA']);
});

test('OpenCode plan turn: <proposed_plan> tags split across deltas never stream, a held "<" goes out at turn end; ordinary turns stream as they are', () => {
  const run = (planning, texts) => {
    const packets = [];
    const tr = createOpenCodeEnvelopeTranslator({ sessionId: 'oc', emit: (p) => packets.push(p), planTurn: () => planning });
    tr.handle('message.updated', { info: { id: 'm1', role: 'assistant', sessionID: 'oc' } });
    for (const text of texts) tr.handle('message.part.updated', { part: { id: 't1', messageID: 'm1', sessionID: 'oc', type: 'text', text } });
    tr.handle('session.idle', { sessionID: 'oc' });
    const streamed = packets.filter((p) => p.event?.type === 'stream_event').map((p) => p.event.event.delta?.text).filter(Boolean);
    return { streamed, final: packets.filter((p) => p.event?.type === 'assistant').at(-1)?.event.message.content[0].text, result: packets.find((p) => p.event?.type === 'result').event };
  };
  const body = 'Plan:\n<proposed_plan>\n# Move\n1. Store\n</proposed_plan>\nIs 2 < 3? <';
  // Cumulative part text, cut mid-tag: "<proposed_" | "plan>", "</pro" | "posed_plan>", and a last "<".
  const texts = [body.indexOf('plan>'), body.indexOf('# Move') + 6, body.indexOf('posed_plan>\nIs'), body.length].map((end) => body.slice(0, end));
  const planned = run(true, texts);
  assert.ok(planned.streamed.every((delta) => !/<\/?p|propos|plan>/.test(delta)), JSON.stringify(planned.streamed));
  assert.equal(planned.streamed.join(''), body.replace(/<\/?proposed_plan>/g, ''), 'the rest streams, held text included');
  assert.equal(planned.streamed.at(-1), '<', 'the held "<" goes out when the turn ends');
  assert.equal(planned.final, body.replace(/<\/?proposed_plan>/g, ''));
  assert.equal(planned.result.plan, '# Move\n1. Store');
  const ordinary = run(false, texts);
  assert.equal(ordinary.streamed.join(''), body);
  assert.equal(ordinary.final, body);
  assert.equal(ordinary.result.plan, undefined);
});

test('A late answer to a plan card that timed out is refused, and that card reads Expired; a turn ending meanwhile does not stop the timeout', async (t) => {
  const h = harness(t, { config: { questionTimeoutMinutes: 0.002 }, reply: (turn) => (turn.planMode ? { result: `<proposed_plan>\n${PLAN}\n</proposed_plan>` } : null) });
  const { session, live, ws } = await h.open({ provider: 'codex', planMode: true });
  await h.runtime._internals.runQuery(live, { text: 'plan it', origin: 'ui' });
  const card = await waitFor(() => cardOf(ws));
  h.runtime._internals.onBrainPacket(live, { type: 'done', code: 0 });
  await waitFor(() => ws.packets('control_cancelled').some((p) => p.request_id === card.request_id && p.reason === 'timeout'), { timeout: 3000 });
  // Approve, a moment too late.
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'control_response', request_id: card.request_id, response: { behavior: 'allow' } })));
  await waitFor(() => ws.packets('control_cancelled').filter((p) => p.request_id === card.request_id).length === 2);
  assert.equal(ws.packets('control_cancelled').at(-1).reason, 'timeout');
  assert.equal(ws.packets('reattach_result').at(-1).running, false);
  assert.deepEqual([h.runtime.isPlanning(session.id), h.turns.length], [true, 1]);
  assert.deepEqual(['timeout', 'superseded'].map((reason) => closedControlState(reason, 'plan')), ['expired', 'expired']);
  assert.equal(closedControlState('timeout', 'permission'), 'cancelled', 'other timed-out cards keep "Cancelled"');
  const panel = readFileSync(new URL('../public/shared/assistant/asst-panel.js', import.meta.url), 'utf8');
  assert.match(panel, /closedControlState\(packet\.reason, kind\) === 'expired'/);
});

test('An open plan card outlives a turn that ends while it is open (a compact, a Stop): still answerable, and it still holds the mailbox', async (t) => {
  const h = harness(t, { reply: (turn) => (turn.planMode ? { result: `<proposed_plan>\n${PLAN}\n</proposed_plan>` } : { result: 'ok' }) });
  const { session, live, ws } = await h.open({ provider: 'opencode', planMode: true });
  await h.runtime._internals.runQuery(live, { text: 'plan it', origin: 'ui' });
  const card = await waitFor(() => cardOf(ws));
  h.runtime._internals.onBrainPacket(live, { type: 'done', code: 0 });
  h.runtime._internals.onBrainPacket(live, { type: 'aborted' });
  assert.deepEqual(h.runtime.pendingControls(session.id).map((p) => p.request_id), [card.request_id]);
  assert.equal(h.runtime.getSession(session.id).status, 'awaiting');
  h.runtime._internals.enqueueMailbox(live, { kind: 'stalled', run: { runId: 'r-held' } });
  await waitFor(() => !live.mailboxTimer);
  await settle();
  assert.equal(h.turns.length, 1, 'the mailbox waits for the card');
  assert.deepEqual(Object.values(await h.runtime.answerControl(session.id, card.request_id, { behavior: 'allow' }, { origin: 'ui' })).slice(0, 2), [true, 'plan']);
  assert.match((await waitFor(() => h.turns[1])).text, /approved your plan/);
});

test('A "do it here" continuation waits while a plan card is open instead of replacing it, and runs after the plan', async (t) => {
  const h = harness(t, { reply: PLAN_REPLY, delay: 30 });
  const { session, live, ws } = await h.open({ provider: 'opencode', planMode: true });
  await h.runtime._internals.runQuery(live, { text: 'plan it', origin: 'ui' });
  // During the plan turn the user picked "do it here" on a route card.
  h.runtime.routerSinks().continueDirect(session.id, TIDY);
  const card = await waitFor(() => cardOf(ws));
  await settle();
  assert.ok(live.work.has('continuation') && !live.workTimer, 'the continuation is held by the card, not retried');
  assert.ok(!ws.packets('control_cancelled').some((p) => p.request_id === card.request_id), 'the card stays open');
  assert.equal(h.turns.length, 1);
  await h.runtime.answerControl(session.id, card.request_id, { behavior: 'allow' }, { origin: 'ui' });
  await waitFor(() => h.turns.length === 3, { timeout: 3000 });
  assert.match(h.turns[1].text, /approved your plan/, 'the plan first');
  assert.match(h.turns[2].text, /chose to run "tidy the docs" here/, 'then the continuation');
});

test('planTurnText: only an explicit proposal (the plan the translator found, or a <proposed_plan> block), never the reply\'s shape', () => {
  assert.equal(planTurnText({ result: 'x', plan: '# P' }), '# P');
  assert.equal(planTurnText({ result: 'Intro\n<proposed_plan>\n# Body\n</proposed_plan>' }), '# Body');
  assert.equal(planTurnText({ result: PLAN }), '', 'a structured reply is not a proposal');
  assert.equal(planTurnText({ result: 'Before I plan it, which database?\n1. Postgres\n2. SQLite\n3. Something else' }), '');
  assert.equal(planTurnText({ result: 'Intro\n<proposed_plan>\nunfinished' }), '', 'an unclosed block is not a proposal');
  assert.equal(proposedPlanText('a <proposed_plan>\none\n</proposed_plan> b <proposed_plan>\ntwo\n</proposed_plan>'), 'two');
});

test('Codex translator: a plan turn\'s plan item streams and joins the final message; <proposed_plan> tags never show', () => {
  const packets = [];
  const tr = createCodexEnvelopeTranslator({ emit: (p) => packets.push(p), planTurn: () => true });
  const notify = (method, params) => tr.handle({ type: 'notify', method, params });
  notify('turn/started', { turn: { id: 't1' } });
  notify('item/agentMessage/delta', { itemId: 'm1', delta: 'Here is the plan.' });
  notify('item/plan/delta', { itemId: 'p1', delta: '# Move' });
  notify('item/plan/delta', { itemId: 'p1', delta: ' the cache' });
  notify('item/completed', { item: { id: 'm1', type: 'agentMessage', text: 'Here is the plan.' } });
  notify('item/completed', { item: { id: 'p1', type: 'plan', text: '# Move the cache\n1. Store' } });
  notify('turn/completed', { turn: { status: 'completed' } });
  const deltas = packets.filter((p) => p.event?.type === 'stream_event').map((p) => p.event.event.delta?.text).filter(Boolean);
  assert.deepEqual(deltas, ['Here is the plan.', '\n\n# Move', ' the cache']);
  const final = packets.filter((p) => p.event?.type === 'assistant').at(-1).event.message.content[0].text;
  assert.equal(final, 'Here is the plan.\n\n# Move the cache\n1. Store');
  const result = packets.find((p) => p.event?.type === 'result').event;
  assert.equal(result.plan, '# Move the cache\n1. Store');
  // Older Codex: the block inside the message itself.
  const older = [];
  const tr2 = createCodexEnvelopeTranslator({ emit: (p) => older.push(p), planTurn: () => true });
  tr2.handle({ type: 'notify', method: 'turn/started', params: { turn: { id: 't2' } } });
  tr2.handle({ type: 'notify', method: 'item/completed', params: { item: { id: 'm', type: 'agentMessage', text: 'Plan:\n<proposed_plan>\n# P\n</proposed_plan>' } } });
  tr2.handle({ type: 'notify', method: 'turn/completed', params: { turn: { status: 'completed' } } });
  assert.equal(older.filter((p) => p.event?.type === 'assistant').at(-1).event.message.content[0].text, 'Plan:\n\n# P');
  assert.equal(older.find((p) => p.event?.type === 'result').event.plan, '# P');
});

test('UI: a plan card is a plan card whichever brain planned, and keeps the approval choice', () => {
  for (const provider of ['codex', 'opencode', 'claude-code']) {
    const n = normalizeControlRequest({ request_id: 'plan-1', provider, request: { subtype: 'can_use_tool', kind: 'plan', tool_name: 'ExitPlanMode', input: { plan: PLAN } } });
    assert.deepEqual([n.kind, n.title, n.plan], ['plan', 'Plan ready', PLAN], provider);
    assert.equal(buildControlResponse(n, { behavior: 'allow', planDecision: 'acceptEdits' }).planDecision, 'acceptEdits', provider);
    assert.equal(buildControlResponse(n, { behavior: 'deny', message: 'use Postgres' }).message, 'use Postgres', provider);
  }
});

/** Just enough DOM for renderControlCard (node has none). */
class FakeNode {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.listeners = {}; this.classes = new Set(); this.textContent = ''; this.innerHTML = ''; this.value = ''; this.hidden = false; this.disabled = false; }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get classList() { const c = this.classes; return { add: (...n) => n.forEach((x) => c.add(x)), remove: (...n) => n.forEach((x) => c.delete(x)), contains: (x) => c.has(x) }; }
  setAttribute() {}
  appendChild(node) { this.children.push(node); return node; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  *walk() { for (const child of this.children) { yield child; yield* child.walk(); } }
  querySelectorAll(selector) { const tags = selector.split(',').map((s) => s.trim().toUpperCase()); return [...this.walk()].filter((n) => tags.includes(n.tagName)); }
  querySelector(selector) { return [...this.walk()].find((n) => n.classes.has(selector.replace(/^\./, ''))) || null; }
}

test('UI: a plan card answered here, then closed by the server before the answer arrived, reads "Expired", not "Allowed"', (t) => {
  const saved = globalThis.document;
  globalThis.document = { createElement: (tag) => new FakeNode(tag) };
  t.after(() => { globalThis.document = saved; });
  const n = normalizeControlRequest({ request_id: 'plan-1', provider: 'codex', request: { subtype: 'can_use_tool', kind: 'plan', tool_name: 'ExitPlanMode', input: { plan: PLAN } } });
  const answers = [];
  const card = renderControlCard(null, n, { onRespond: (_n, decision) => answers.push(decision) });
  const approve = [...card.el.walk()].find((node) => node.dataset.action === 'approve');
  for (const fn of approve.listeners.click) fn({});
  const status = card.el.querySelector('.asst-control-status');
  assert.deepEqual([answers[0].behavior, status.textContent], ['allow', 'Allowed']);
  card.lock('Cancelled');
  assert.equal(status.textContent, 'Allowed', 'lock leaves an answered card as it is');
  card.expire('Expired');
  assert.deepEqual([status.textContent, card.el.classList.contains('expired'), card.resolved], ['Expired', true, true]);
  // The panel keeps the cards it answered, and a control_cancelled after the answer expires them.
  const panel = readFileSync(new URL('../public/shared/assistant/asst-panel.js', import.meta.url), 'utf8');
  assert.match(panel, /case 'control_cancelled': \{[\s\S]{0,600}answeredCards\.get\(id\)[\s\S]{0,400}answered\.expire\(label\)/);
  assert.match(panel, /answeredCards\.set\(n\.requestId, card\)/);
});

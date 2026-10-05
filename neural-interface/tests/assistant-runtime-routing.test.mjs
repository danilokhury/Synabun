import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { createAssistantRuntime } from '../lib/assistant-runtime.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeBrainFactory(log, { cost = () => 0.02 } = {}) {
  return ({ session, sink, deps }) => {
    let busy = false;
    log.push(['create', session.brain.provider, deps.desktopGrant || null]);
    return {
      kind: session.brain.provider,
      termId: session.brain.provider === 'opencode' ? `assistant-oc-${String(session.id).replace(/^assistant-/, '').slice(0, 24)}` : undefined,
      async start() {},
      async sendUserTurn({ text, model, effort }) {
        log.push(['turn', text, model || null, effort || null]);
        busy = true;
        setTimeout(() => {
          sink.send({ type: 'event', event: { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: cost(log) } });
          busy = false;
          sink.send({ type: 'done', code: 0 });
        }, 5);
      },
      async abort() { log.push(['abort']); busy = false; sink.send({ type: 'aborted' }); },
      respondControl(id, response) { log.push(['brain-control', id, response]); },
      isBusy: () => busy,
      identity: () => ({ providerSessionId: 'prov-1' }),
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

function fakeRouter() {
  const answered = [];
  let stampText = '[SynaBun Router] Route mode: never ask.';
  let stamped = null;
  return {
    answered,
    owns: (id) => String(id).startsWith('route-'),
    async answer(id, response) { answered.push([id, response]); return { ok: true }; },
    pendingCards: () => [{ type: 'control_request', request_id: 'route-open', request: { subtype: 'route' } }],
    cancelForSession() {},
    stamp: () => ({ text: stampText, changed: stamped !== stampText, commit: () => { stamped = stampText; } }),
    setStamp: (value) => { stampText = value; },
  };
}

const DEFAULT_CATALOG = { peek: () => ({ models: { opencode: [{ id: 'ollama-cloud/deepseek-v4-pro', label: 'DeepSeek V4 Pro', vision: false }] } }), brainInfo: () => ({ vision: true, label: 'DeepSeek V4.1 Flash' }) };

function harness(t, { router = null, desktop = null, dispatcher = null, cost, catalog = DEFAULT_CATALOG } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-runtime-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = [];
  const factory = fakeBrainFactory(log, { cost });
  const runtime = createAssistantRuntime({
    dispatcher, dataDir: root, detectProject: () => 'proj', buildCatalog: async () => ({ models: {} }),
    brainFactories: { 'claude-code': factory, codex: factory, opencode: factory }, config: { mailboxBatchMs: 20 },
    router, desktop, catalog,
    configStore: { routing: () => ({ defaultMode: 'ask-unsure', askBelow: 0.75, preferences: {} }) },
  });
  t.after(() => runtime.shutdown());
  return { root, runtime, log };
}

async function attach(runtime, id) {
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${id}` });
  return ws;
}

test('route cards are answered by the router (never the brain) and replayed on attach; stamps precede the prompt', async (t) => {
  const router = fakeRouter();
  const { runtime, log } = harness(t, { router });
  const session = await runtime.createSession({ brain: { provider: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash' }, cwd: '/tmp' });
  const ws = await attach(runtime, session.id);
  assert.ok(ws.sent.some((p) => p.type === 'control_request' && p.request_id === 'route-open'), 'open cards replay on attach');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'fix the flaky test' })));
  await wait(40);
  const firstTurn = log.find((row) => row[0] === 'turn');
  assert.match(firstTurn[1], /^\[SynaBun Router\] Route mode: never ask\.\n\nfix the flaky test$/);
  assert.equal(firstTurn[2], 'ollama-cloud/deepseek-v4.1-flash', 'every turn names the effective model');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'again' })));
  await wait(40);
  assert.equal(log.filter((row) => row[0] === 'turn').at(-1)[1], 'again', 'an unchanged stamp is not repeated');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'control_response', request_id: 'route-abc', response: { optionId: 's1' } })));
  await wait(10);
  assert.deepEqual(router.answered[0], ['route-abc', { optionId: 's1' }]);
  assert.ok(!log.some((row) => row[0] === 'brain-control'), 'the brain never sees route answers');
});

test('a sent route card is logged with its socket count and the pending count follows it to the panel', async (t) => {
  const router = fakeRouter();
  const logs = [];
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-runtime-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const factory = fakeBrainFactory([], {});
  const runtime = createAssistantRuntime({
    dataDir: root, detectProject: () => 'proj', buildCatalog: async () => ({ models: {} }),
    brainFactories: { 'claude-code': factory, codex: factory, opencode: factory }, config: { mailboxBatchMs: 20 },
    router, catalog: DEFAULT_CATALOG, log: (tag, text) => logs.push([tag, text]),
    configStore: { routing: () => ({ defaultMode: 'ask-unsure', askBelow: 0.75, preferences: {} }) },
  });
  t.after(() => runtime.shutdown());
  const session = await runtime.createSession({ brain: { provider: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash' }, cwd: '/tmp' });
  const ws = await attach(runtime, session.id);
  const sinks = runtime.routerSinks();
  sinks.sendCard(session.id, { type: 'control_request', request_id: 'route-live', request: { subtype: 'route', routeId: 'route-live' } });
  await wait(10);
  assert.ok(ws.sent.some((p) => p.type === 'control_request' && p.request_id === 'route-live'));
  assert.deepEqual(logs.find(([tag]) => tag === 'assistant:route-card'), ['assistant:route-card', 'route-live → 1 socket(s)']);
  const update = ws.sent.filter((p) => p.type === 'assistant:session' && p.reason === 'routes').at(-1);
  assert.equal(update?.session?.pendingRoutes, 1, 'the route chip learns the count even if the card packet was lost');
  // A settled route republishes the count; a card to a session that is not live is logged, not thrown.
  sinks.routeEvent(session.id, 'decided', { routeId: 'route-live' });
  await wait(10);
  assert.equal(ws.sent.filter((p) => p.type === 'assistant:session' && p.reason === 'routes').length, 2);
  sinks.sendCard('assistant-gone', { type: 'control_request', request_id: 'route-lost', request: { subtype: 'route' } });
  assert.ok(logs.some(([tag, text]) => tag === 'assistant:route-card' && /route-lost → session assistant-gone not live/.test(text)));
});

test('set_route_mode persists on the session and shows in the view', async (t) => {
  const { runtime } = harness(t, { router: fakeRouter() });
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  assert.deepEqual(session.routing, { mode: null, effectiveMode: 'ask-unsure', defaultMode: 'ask-unsure', askBelow: 0.75 });
  assert.deepEqual(session.features, { routing: true, computer: false });
  const ws = await attach(runtime, session.id);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'set_route_mode', mode: 'always' })));
  await wait(10);
  assert.equal(runtime.getSession(session.id).routing.mode, 'always-ask');
  assert.equal(runtime.getSession(session.id).routing.effectiveMode, 'always-ask');
  assert.ok(ws.sent.some((p) => p.type === 'assistant:session' && p.reason === 'routing'));
  await runtime.updateSession(session.id, { routing: { mode: null } });
  assert.equal(runtime.getSession(session.id).routing.mode, null);
  await assert.rejects(runtime.updateSession(session.id, { routing: { mode: 'sometimes' } }), (e) => e.code === 'ROUTE_MODE_INVALID');
});

test('a continuation runs the routed model for one turn, then the next user turn is back on the session model', async (t) => {
  const { runtime, log } = harness(t, { router: fakeRouter() });
  const session = await runtime.createSession({ brain: { provider: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash' }, cwd: '/tmp' });
  const ws = await attach(runtime, session.id);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'tidy the readme' })));
  await wait(2);
  runtime.routerContinue(session.id, { target: { kind: 'direct', provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro', effort: 'high' }, route: { summary: 'tidy the readme' } });
  await wait(150);
  const turns = log.filter((row) => row[0] === 'turn');
  assert.equal(turns.length, 2);
  assert.match(turns[1][1], /\[SynaBun Router\] The user chose to run "tidy the readme" here on DeepSeek V4 Pro \(effort high\)/);
  assert.equal(turns[1][2], 'ollama-cloud/deepseek-v4-pro');
  assert.equal(turns[1][3], 'high');
  assert.equal(runtime.getSession(session.id).brain.model, 'ollama-cloud/deepseek-v4.1-flash', 'never persisted');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'next' })));
  await wait(40);
  assert.equal(log.filter((row) => row[0] === 'turn').at(-1)[2], 'ollama-cloud/deepseek-v4.1-flash');
});

test('OpenCode brain pins resolve to their session; image turns on a blind brain run on a vision model', async (t) => {
  const catalog = {
    peek: () => ({ models: { opencode: [
      { id: 'ollama-cloud/deepseek-v4-pro', label: 'DeepSeek V4 Pro', vision: false, price: { output: 9 } },
      { id: 'ollama-cloud/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', vision: true, price: { output: 0.6 } },
    ] } }),
    brainInfo: (brain) => ({ vision: brain.model !== 'ollama-cloud/deepseek-v4-pro', label: brain.model }),
  };
  const { runtime, log } = harness(t, { catalog });
  const session = await runtime.createSession({ brain: { provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' }, cwd: '/tmp' });
  const pin = `assistant-oc-${session.id.replace(/^assistant-/, '').slice(0, 24)}`;
  assert.equal(runtime.resolveTerminal(pin), session.id);
  assert.equal(runtime.resolveTerminal(session.id), session.id);
  assert.equal(runtime.resolveTerminal('assistant-oc-unknown'), null);
  assert.equal(runtime.getSession(session.id).brainCapabilities.vision, false);
  const ws = await attach(runtime, session.id);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'what is in this screenshot?', images: [{ base64: 'AAAA', mediaType: 'image/png' }] })));
  await wait(40);
  const turn = log.find((row) => row[0] === 'turn');
  assert.equal(turn[2], 'ollama-cloud/deepseek-v4.1-flash', 'the image turn runs on the vision model');
  const route = ws.sent.find((p) => p.type === 'event' && p.event?.type === 'synabun.route');
  assert.equal(route.event.phase, 'auto');
  assert.equal(route.event.route.decidedBy, 'rule');
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'thanks' })));
  await wait(40);
  assert.equal(log.filter((row) => row[0] === 'turn').at(-1)[2], 'ollama-cloud/deepseek-v4-pro', 'text turns stay on the session model');
});

test('needs_input reaches the mailbox once; cost deltas survive a provider-session reset', async (t) => {
  const listeners = new Set();
  const dispatcher = { limits: {}, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, totals: () => ({ costUsd: 0 }), get: (runId) => ({ runId }) };
  const costs = [0.05, 0.02];
  const { runtime, log } = harness(t, { dispatcher, cost: () => costs.shift() ?? 0 });
  const session = await runtime.createSession({ brain: { provider: 'codex' }, cwd: '/tmp' });
  const ws = await attach(runtime, session.id);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'one' })));
  await wait(40);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'two' })));
  await wait(40);
  assert.equal(runtime.getSession(session.id).costUsd, 0.07, '0.05, then a reset to 0.02 counts in full');
  const run = { runId: 'run-q', assistantSessionId: session.id, provider: 'codex', title: 'Q', lastResult: { status: 'needs_input', question: 'Which env?' } };
  for (const listener of listeners) { listener({ type: 'assistant:dispatch', reason: 'needs_input', run }); listener({ type: 'assistant:dispatch', reason: 'turn_completed', run }); }
  await wait(80);
  const mailboxTurn = log.filter((row) => row[0] === 'turn').find((row) => /\[SynaBun Mailbox\]/.test(row[1]));
  assert.match(mailboxTurn[1], /\[SynaBun Mailbox\] 1 event/);
  assert.match(mailboxTurn[1], /needs_input/);
});

test('computer toggle: grant minted per brain, effective default from the desktop service, revoked on dispose', async (t) => {
  const calls = [];
  const desktop = {
    isSupported: () => true, defaultSessionOn: () => true, setupState: () => 'ready',
    mintGrant: (meta) => { calls.push(['mint', meta]); return `sbd_${'g'.repeat(43)}`; },
    revokeFor: (opts) => calls.push(['revoke', opts]), releaseOwner: (opts) => calls.push(['release', opts]),
    onSessionToggle: (id, on) => calls.push(['toggle', id, on]), stop: async (opts) => calls.push(['stop', opts]),
  };
  const { runtime, log } = harness(t, { desktop });
  const session = await runtime.createSession({ brain: { provider: 'claude-code' }, cwd: '/tmp' });
  assert.equal(session.computerUse, true, 'ON by default once setup is done');
  assert.equal(session.computerUseExplicit, null);
  assert.deepEqual(session.features, { routing: false, computer: true });
  const ws = await attach(runtime, session.id);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'query', prompt: 'hello' })));
  await wait(30);
  assert.equal(log.find((row) => row[0] === 'create')[2], `sbd_${'g'.repeat(43)}`, 'the brain receives its grant');
  assert.equal(calls.find(([kind]) => kind === 'mint')[1].assistantSessionId, session.id);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'set_computer_use', enabled: false })));
  await wait(10);
  assert.equal(runtime.getComputerUse(session.id), false);
  assert.deepEqual(calls.find(([kind]) => kind === 'toggle'), ['toggle', session.id, false]);
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'desktop_stop' })));
  await wait(10);
  assert.equal(calls.find(([kind]) => kind === 'stop')[1].scope, 'all');
  await runtime.closeSession(session.id);
  assert.ok(calls.some(([kind, opts]) => kind === 'revoke' && opts.token === `sbd_${'g'.repeat(43)}`));
  assert.ok(calls.some(([kind, opts]) => kind === 'release' && opts.assistantSessionId === session.id));
});

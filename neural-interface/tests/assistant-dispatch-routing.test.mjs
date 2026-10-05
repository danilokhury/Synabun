import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { NativeLoopRuntime } from '../lib/native-loop-runtime.js';
import { createAssistantDispatcher, DispatchError } from '../lib/assistant-dispatch.js';
import { createAssistantRouter } from '../lib/assistant-router.js';
import { createAssistantCatalog } from '../lib/assistant-catalog.js';
import { effectiveRouting } from '../lib/assistant-config.js';
import { PRICING, fakeFetch } from './assistant-catalog.fixtures.mjs';
import { formatMailbox, reconcileRouteItems } from '../lib/assistant-persona.js';

const RESULT = (status = 'done') => `## Result\nstatus: ${status}\nsummary: did it\nchanges:\n- none\nfollow_ups:\n- none`;
const waitFor = async (predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const v = predicate(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('Timed out waiting for condition');
};

// `routerGate()`: a promise every catalog read of the ROUTER waits on (the dispatcher's own snapshot is not held).
function makeHarness(t, { mode = 'always-ask', text = () => RESULT(), desktop = null, hidden = [], extra = {}, routerGate = null } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-dispatch-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const factoryCalls = [];
  const makeAdapter = (state) => {
    factoryCalls.push(state);
    return {
      identity: () => ({ providerSessionId: `sess-${state.runId.slice(0, 4)}` }),
      isAlive: () => true,
      async runTurn() { return { text: text(state), costUsd: 0.01 }; },
      async abort() {}, async dispose() {},
    };
  };
  const runtime = new NativeLoopRuntime({
    stateDir: resolve(root, 'loop'), ledgerPath: resolve(root, 'runs.json'), buildPrompt: () => 'LOOP', iterationDelayMs: 0,
    providerFactories: { codex: async (s) => makeAdapter(s), 'claude-code': async (s) => makeAdapter(s), opencode: async (s) => makeAdapter(s) },
  });
  const catalog = createAssistantCatalog({ fetchJson: fakeFetch(), claudePricing: PRICING, readHidden: () => hidden });
  let dispatcher = null;
  const sessions = new Map([['assistant-1', { brain: { provider: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash' }, routingMode: mode }]]);
  const mailbox = [];
  const cards = [];
  // `hooks.onCard`: a host that acts while a route card is being sent (the WhatsApp bridge closes it at once).
  const hooks = { onCard: null };
  const routerCatalog = routerGate
    ? { full: async (...args) => { await routerGate(); return catalog.full(...args); }, peek: (...args) => catalog.peek(...args), brainInfo: (...args) => catalog.brainInfo(...args) }
    : catalog;
  const router = createAssistantRouter({
    catalog: routerCatalog, configStore: { routing: () => effectiveRouting({ ladders: { opencode: ['ollama-cloud/deepseek-v4.1-flash', 'ollama-cloud/deepseek-v4-pro'] } }), setPreference() {} },
    getSession: (id) => sessions.get(id) || null,
    sinks: {
      sendCard: (sid, packet) => { cards.push(packet); hooks.onCard?.(sid, packet); }, routeEvent() {}, mailbox: (sid, item) => mailbox.push(item), cancelCard() {},
      startHeld: (runId, target, meta) => dispatcher.resolveRoute(runId, { target, ...meta }),
      declineHeld: (runId, reason) => dispatcher.declineRoute(runId, { reason }),
    },
  });
  dispatcher = createAssistantDispatcher({
    getRuntime: () => runtime, dataDir: root, loopDir: resolve(root, 'loop'), PACKAGE_ROOT: root,
    getCodexAccount: () => ({ id: 'default', home: '/tmp/codex' }), findCodexAccount: () => null, CODEX_DEFAULT_HOME: '/tmp/codex',
    detectProject: () => 'proj', limits: { minIdleTimeoutMs: 50 }, router, catalog, desktop,
    ...extra,
  });
  t.after(() => { router.shutdown(); dispatcher.shutdown('test'); });
  return { root, dispatcher, router, cards, mailbox, factoryCalls, sessions, hooks };
}

test('always-ask: an un-routed dispatch is held (no adapter, 202 payload), wait returns, and the pick starts it on the chosen model', async (t) => {
  const { dispatcher, router, cards, mailbox, factoryCalls } = makeHarness(t);
  const held = await dispatcher.dispatch({ provider: 'claude-code', task: 'write docs', cwd: undefined, title: 'Docs' }, { assistantSessionId: 'assistant-1', origin: 'assistant' });
  assert.equal(held.awaitingRoute, true);
  assert.equal(held.queued, true);
  assert.equal(held.run.state, 'awaiting_route');
  assert.equal(held.run.awaitingRoute, true);
  assert.equal(held.run.rawSpec, undefined, 'the held spec never leaks into views');
  assert.equal(factoryCalls.length, 0);
  assert.equal(cards.length, 1);
  const waited = await dispatcher.wait({ runId: held.run.runId, timeoutMs: 1000 });
  assert.equal(waited.timedOut, false, 'awaiting_route satisfies an idle wait');
  const card = cards[0];
  assert.deepEqual(card.request.runIds, [held.run.runId]);
  const cheaper = card.request.options.find((o) => o.badge === 'cheaper');
  assert.equal(cheaper.model, 'sonnet', 'one step below the provider default (Opus)');
  // The user picks "cheaper" on the card: the router starts the held run.
  await router.answer(card.request_id, { optionId: cheaper.id });
  const run = await waitFor(() => { const r = dispatcher.get(held.run.runId); return r.state === 'idle' ? r : null; });
  assert.equal(run.model, 'sonnet');
  assert.equal(run.route.status, 'approved');
  assert.equal(run.route.decidedBy, 'user');
  assert.equal(factoryCalls[0].model, 'sonnet');
  assert.equal(factoryCalls[0].provider, 'claude-code', 'state.provider is set for the task prompt');
  assert.equal(mailbox[0].kind, 'route_decided', 'the brain learns the held run started');
});

test('never: dispatches start at once with an auto route; unknown models are rejected with suggestions', async (t) => {
  const { dispatcher } = makeHarness(t, { mode: 'never' });
  const started = await dispatcher.dispatch({ provider: 'codex', model: 'gpt-5.6-luna', task: 'lint', confidence: 0.3 }, { assistantSessionId: 'assistant-1' });
  assert.equal(started.queued, false);
  assert.equal(started.run.route.status, 'auto');
  assert.equal(started.run.modelInfo.validated, 'catalog');
  await assert.rejects(
    dispatcher.dispatch({ provider: 'codex', model: 'gpt-9-imaginary', task: 'x' }, { assistantSessionId: 'assistant-1', origin: 'ui' }),
    (error) => error instanceof DispatchError && error.code === 'MODEL_UNKNOWN' && Array.isArray(error.suggestions) && error.suggestions.length > 0,
  );
  const auto = await dispatcher.dispatch({ provider: 'codex', model: 'auto', task: 'y' }, { assistantSessionId: 'assistant-1', origin: 'ui' });
  assert.equal(auto.run.model, null, '"auto" means the provider default');
});

test('declined and expired routes stop the held run without starting a worker', async (t) => {
  const { dispatcher, factoryCalls } = makeHarness(t);
  const held = await dispatcher.dispatch({ provider: 'claude-code', task: 'a' }, { assistantSessionId: 'assistant-1' });
  assert.equal(dispatcher.declineRoute(held.run.runId, { reason: 'route_declined' }), true);
  const run = dispatcher.get(held.run.runId);
  assert.equal(run.state, 'stopped');
  assert.equal(run.completionReason, 'route_declined');
  assert.equal(run.route.status, 'declined');
  assert.equal(factoryCalls.length, 0);
  const again = await dispatcher.dispatch({ provider: 'claude-code', task: 'b' }, { assistantSessionId: 'assistant-1' });
  await dispatcher.stop(again.run.runId, 'user');
  assert.equal(dispatcher.get(again.run.runId).state, 'stopped');
});

test('a blocked result carries a one-tier escalation; escalate re-dispatches up the ladder as a child run', async (t) => {
  const { dispatcher } = makeHarness(t, { mode: 'never', text: (state) => (state.model === 'ollama-cloud/deepseek-v4.1-flash' ? RESULT('blocked') : RESULT('done')) });
  const first = await dispatcher.dispatch({ provider: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash', task: 'hard thing', confidence: 0.9 }, { assistantSessionId: 'assistant-1' });
  const blocked = await waitFor(() => { const r = dispatcher.get(first.run.runId); return r.state === 'idle' && r.escalation ? r : null; });
  assert.equal(blocked.escalation.reason, 'blocked');
  assert.equal(blocked.escalation.to.model, 'ollama-cloud/deepseek-v4-pro');
  const child = await dispatcher.escalate(first.run.runId);
  assert.equal(child.run.model, 'ollama-cloud/deepseek-v4-pro');
  assert.equal(child.run.parentRunId, first.run.runId);
  assert.equal(dispatcher._internals.entries.get(child.run.runId).escalationDepth, 1);
  assert.match(dispatcher._internals.entries.get(child.run.runId).context, /ESCALATION/);
});

test('computer runs: refused without the desktop, one at a time with it, grant minted as a function and released at the end', async (t) => {
  const { dispatcher: noDesktop } = makeHarness(t, { mode: 'never' });
  await assert.rejects(noDesktop.dispatch({ provider: 'claude-code', task: 'open TextEdit', usesComputer: true, capability: 'workspace' }, { assistantSessionId: 'assistant-1', origin: 'ui' }), (e) => e.code === 'COMPUTER_UNAVAILABLE');
  const minted = [];
  const released = [];
  const desktop = {
    isSupported: () => true, isReady: () => true, setupState: () => 'ready', sessionAllows: () => true,
    mintGrant: (meta) => { minted.push(meta); return `sbd_${'x'.repeat(43)}`; },
    revokeFor: (opts) => released.push(['revoke', opts]), releaseOwner: (opts) => released.push(['release', opts]),
  };
  const { dispatcher, factoryCalls, root } = makeHarness(t, { mode: 'never', desktop });
  await assert.rejects(dispatcher.dispatch({ provider: 'claude-code', task: 'x', usesComputer: true }, { assistantSessionId: 'assistant-1', origin: 'ui' }), (e) => e.code === 'QUARANTINE_VIOLATION', 'capability full is refused like browser runs');
  const run = await dispatcher.dispatch({ provider: 'claude-code', model: 'sonnet', task: 'open TextEdit', usesComputer: true, capability: 'workspace' }, { assistantSessionId: 'assistant-1', origin: 'ui' });
  assert.equal(run.run.usesComputer, true);
  await waitFor(() => factoryCalls.length === 1);
  assert.equal(typeof factoryCalls[0].desktopGrantProvider, 'function');
  assert.equal(factoryCalls[0].desktopGrantProvider(), `sbd_${'x'.repeat(43)}`);
  assert.equal(factoryCalls[0].usesComputer, true);
  assert.equal(minted[0].runId, run.run.runId);
  const second = await dispatcher.dispatch({ provider: 'codex', model: 'gpt-5.6-luna', task: 'another', usesComputer: true, capability: 'workspace' }, { assistantSessionId: 'assistant-1', origin: 'ui' });
  assert.equal(second.queued, true, 'one computer run at a time');
  const stateFile = readFileSync(resolve(root, 'loop', `${run.run.runId}.json`), 'utf8').toString();
  assert.ok(!stateFile.includes('sbd_'), 'the grant never lands in the loop state file');
  await dispatcher.stop(run.run.runId, 'user');
  await waitFor(() => released.some(([kind, opts]) => kind === 'release' && opts.runId === run.run.runId));
});

test('COMPUTER_SESSION_OFF when the session toggle is off', async (t) => {
  const desktop = { isSupported: () => true, isReady: () => true, setupState: () => 'ready', sessionAllows: () => false, mintGrant: () => 'x', revokeFor() {}, releaseOwner() {} };
  const { dispatcher } = makeHarness(t, { mode: 'never', desktop });
  await assert.rejects(dispatcher.dispatch({ provider: 'claude-code', task: 'x', usesComputer: true, capability: 'workspace' }, { assistantSessionId: 'assistant-1' }), (e) => e.code === 'COMPUTER_SESSION_OFF');
});

test('a transient failure is retried on the same model with RETRY wording, one level deeper', async (t) => {
  const { dispatcher } = makeHarness(t, { mode: 'never', text: () => RESULT('blocked') });
  const first = await dispatcher.dispatch({ provider: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash', task: 'sync the feeds', title: 'Sync feeds', confidence: 0.9 }, { assistantSessionId: 'assistant-1' });
  await waitFor(() => dispatcher.get(first.run.runId).state === 'idle');
  // The cause Jev would have attached (the worker-outcome judgment itself is covered in assistant-dispatch.test.mjs).
  const entry = dispatcher._internals.entries.get(first.run.runId);
  entry.lastResult = { ...entry.lastResult, cause: 'transient' };
  const { escalationFor } = await import('../lib/assistant-router.js');
  entry.escalation = escalationFor({ run: { ...entry, state: 'idle' }, catalog: null, routing: {}, depth: 0 });
  assert.equal(entry.escalation.kind, 'retry');
  const child = await dispatcher.escalate(first.run.runId);
  const childEntry = dispatcher._internals.entries.get(child.run.runId);
  assert.equal(child.run.provider, 'opencode');
  assert.equal(child.run.model, 'ollama-cloud/deepseek-v4.1-flash', 'the same model');
  assert.equal(childEntry.escalationDepth, 1);
  assert.match(childEntry.context, /^RETRY: a previous attempt on opencode\/ollama-cloud\/deepseek-v4\.1-flash/);
  assert.doesNotMatch(childEntry.context, /ESCALATION/);
  assert.equal(child.run.title, 'Sync feeds ↻');
  assert.match(entry.notes.at(-1), /^retried on opencode\/ollama-cloud\/deepseek-v4\.1-flash as /);
});

test('a model disabled in Settings → OpenCode is refused (MODEL_DISABLED), from the UI and through a never-mode route', async (t) => {
  const { dispatcher, factoryCalls } = makeHarness(t, { mode: 'never', hidden: ['ollama-cloud/deepseek-v4-pro'] });
  await assert.rejects(
    dispatcher.dispatch({ provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro', task: 'x' }, { assistantSessionId: 'assistant-1', origin: 'ui' }),
    (error) => error instanceof DispatchError && error.code === 'MODEL_DISABLED' && /Assistant's Models list/.test(error.message) && !error.suggestions.includes('ollama-cloud/deepseek-v4-pro'),
  );
  const corrected = await dispatcher.dispatch({ provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro', task: 'y', confidence: 0.9 }, { assistantSessionId: 'assistant-1' });
  assert.equal(corrected.run.model, null, 'the router corrected the pick to the provider default');
  assert.equal(corrected.run.route.corrections[0].reason, 'model_disabled');
  assert.ok(factoryCalls.every((state) => state.model !== 'ollama-cloud/deepseek-v4-pro'));
});

test('hidden Claude / Codex models are refused (MODEL_DISABLED); an omitted model whose default is hidden runs on a visible one', async (t) => {
  const { dispatcher, factoryCalls } = makeHarness(t, { mode: 'never', hidden: { 'claude-code': ['claude-opus-5-5'], codex: ['gpt-6-astra'] } });
  for (const [provider, model] of [['claude-code', 'opus'], ['claude-code', 'default'], ['codex', 'gpt-6-astra']]) {
    await assert.rejects(
      dispatcher.dispatch({ provider, model, task: 'x' }, { assistantSessionId: 'assistant-1', origin: 'ui' }),
      (error) => error instanceof DispatchError && error.code === 'MODEL_DISABLED' && /Assistant's Models list/.test(error.message),
      `${provider}/${model}`,
    );
  }
  const pinned = await dispatcher.dispatch({ provider: 'codex', task: 'no model', permissionPolicy: 'auto' }, { assistantSessionId: 'assistant-1', origin: 'ui' });
  assert.equal(pinned.run.model, 'gpt-5.6-luna', 'the hidden Codex default is replaced by the first visible model');
  const claude = await dispatcher.dispatch({ provider: 'claude-code', task: 'no model either' }, { assistantSessionId: 'assistant-1', origin: 'ui' });
  assert.notEqual(claude.run.model, null);
  assert.ok(!['default', 'opus'].includes(claude.run.model), 'the hidden default alias is never used');
  assert.ok(factoryCalls.every((state) => !['opus', 'default', 'gpt-6-astra'].includes(state.model)));
});

test('a provider with every model hidden refuses dispatch (MODEL_DISABLED)', async (t) => {
  const { dispatcher } = makeHarness(t, { mode: 'never', hidden: { codex: ['gpt-6-astra', 'gpt-5.6-luna'] } });
  await assert.rejects(
    dispatcher.dispatch({ provider: 'codex', task: 'x', permissionPolicy: 'auto' }, { assistantSessionId: 'assistant-1', origin: 'ui' }),
    (error) => error.code === 'MODEL_DISABLED' && /Every codex model/.test(error.message),
  );
});

test('a hidden context variant is refused (MODEL_DISABLED) and its sibling still dispatches', async (t) => {
  const { dispatcher } = makeHarness(t, { mode: 'never', hidden: { 'claude-code': ['opus[1m]'] } });
  await assert.rejects(
    dispatcher.dispatch({ provider: 'claude-code', model: 'opus[1m]', task: 'x' }, { assistantSessionId: 'assistant-1', origin: 'ui' }),
    (error) => error instanceof DispatchError && error.code === 'MODEL_DISABLED',
  );
  const sibling = await dispatcher.dispatch({ provider: 'claude-code', model: 'opus', task: 'y' }, { assistantSessionId: 'assistant-1', origin: 'ui' });
  assert.equal(sibling.run.model, 'opus');
});

test('an unsupported effort is corrected to one the model runs, recorded on the run, and reaches the worker', async (t) => {
  const { dispatcher, factoryCalls } = makeHarness(t, { mode: 'never' });
  const started = await dispatcher.dispatch({ provider: 'codex', model: 'gpt-6-astra', effort: 'ultra', task: 'lint' }, { assistantSessionId: 'assistant-1', origin: 'ui' });
  assert.equal(started.run.effort, 'high');
  assert.deepEqual(started.run.effortCorrection, { from: 'ultra', to: 'high' });
  assert.ok(started.run.notes.some((note) => /effort "ultra" is not supported/.test(note)));
  await waitFor(() => factoryCalls.length === 1);
  assert.equal(factoryCalls[0].effort, 'high');
  const kept = await dispatcher.dispatch({ provider: 'claude-code', model: 'opus', effort: 'max', task: 'x' }, { assistantSessionId: 'assistant-1', origin: 'ui' });
  assert.equal(kept.run.effort, 'max');
  assert.equal(kept.run.effortCorrection, null);
});

test('a remote session under strict approvals: the pick on the route card is clamped again (Codex runs read-only)', async (t) => {
  const projects = [];
  const policies = new Map([['assistant-1', { level: 'ask', strictWorkerApprovals: true }]]);
  const { dispatcher, router, cards, root, factoryCalls } = makeHarness(t, { extra: { sessionPolicy: (id) => policies.get(id) || null, registeredProjects: () => projects } });
  projects.push(root);
  const held = await dispatcher.dispatch({ provider: 'claude-code', task: 'write docs', title: 'Docs', capability: 'full' }, { assistantSessionId: 'assistant-1', origin: 'assistant' });
  assert.equal(held.awaitingRoute, true);
  assert.ok(held.run.notes.some((note) => /strict worker approvals/.test(note)));
  const card = cards[0];
  // "Other…" is how the panel picks any provider; the phone never sends it, the desktop may.
  await router.answer(card.request_id, { optionId: 'other', target: { kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' } });
  const run = await waitFor(() => { const r = dispatcher.get(held.run.runId); return r.state === 'idle' ? r : null; });
  assert.equal(run.provider, 'codex');
  assert.deepEqual([run.capability, run.permissionPolicy], ['read-only', 'restricted']);
  assert.equal(factoryCalls[0].capability, 'read-only');
  policies.set('assistant-1', { level: 'read-only' });
  const refused = await dispatcher.dispatch({ provider: 'claude-code', task: 'more', title: 'More' }, { assistantSessionId: 'assistant-1', origin: 'assistant' }).catch((e) => e);
  assert.equal(refused.code, 'REMOTE_READ_ONLY');
});

test('a route card that closes before the run can wait on it leaves no held run: the dispatch is refused, nothing stays awaiting_route', async (t) => {
  const { dispatcher, router, cards, mailbox, factoryCalls, hooks } = makeHarness(t);
  const SESSION = { assistantSessionId: 'assistant-1', origin: 'assistant' };
  const heldRuns = () => dispatcher.list({ assistantSessionId: 'assistant-1' }).filter((run) => run.state === 'awaiting_route');
  // 1. Closed while it is being sent (the WhatsApp bridge, when the user already wrote something else).
  hooks.onCard = (sid, packet) => { assert.equal(router.cancel(packet.request_id, 'superseded', { sessionId: sid }), true); };
  await assert.rejects(
    () => dispatcher.dispatch({ provider: 'claude-code', task: 'write docs', title: 'Docs' }, SESSION),
    (error) => error.code === 'ROUTE_CANCELLED' && error.status === 409 && /sent a new message instead/.test(error.message) && /Nothing was started/.test(error.message),
  );
  assert.equal(cards.length, 1, 'the card was raised once');
  assert.deepEqual(heldRuns(), [], 'no orphan awaiting_route run');
  assert.deepEqual(dispatcher.list({ assistantSessionId: 'assistant-1' }), [], 'no run at all');
  assert.deepEqual(router.pendingCards('assistant-1'), []);
  // 2. Closed right after the hold was returned, before the run is attached: the attachment fails and is not ignored.
  hooks.onCard = null;
  const resolveDispatch = router.resolveDispatch;
  router.resolveDispatch = async (args) => {
    const routed = await resolveDispatch(args);
    assert.equal(routed.action, 'hold');
    assert.equal(router.cancel(routed.routeId, 'superseded', { sessionId: args.sessionId }), true);
    return routed;
  };
  await assert.rejects(
    () => dispatcher.dispatch({ provider: 'claude-code', task: 'write more docs', title: 'Docs 2', idempotencyKey: 'docs-2' }, SESSION),
    (error) => error.code === 'ROUTE_CANCELLED' && error.status === 409 && /sent a new message instead/.test(error.message),
  );
  assert.deepEqual(heldRuns(), [], 'the run that could not attach was not left waiting');
  assert.deepEqual(dispatcher.list({ assistantSessionId: 'assistant-1' }), []);
  router.resolveDispatch = resolveDispatch;
  // The refused dispatch left nothing behind its idempotency key: the same key dispatches for real afterwards.
  const again = await dispatcher.dispatch({ provider: 'claude-code', task: 'write more docs', title: 'Docs 2', idempotencyKey: 'docs-2' }, SESSION);
  assert.equal(again.awaitingRoute, true);
  assert.equal(again.replayed, undefined, 'not a replay of the refused attempt');
  assert.equal(heldRuns().length, 1);
  assert.deepEqual(router.pendingCards('assistant-1')[0].request.runIds, [again.run.runId], 'attached to its open card');
  assert.equal(factoryCalls.length, 0);
  assert.equal(mailbox.length, 0);
});

/** A promise the test settles by hand. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('a route approved between the hold and the run\'s attachment starts the run on it (not ROUTE_CANCELLED); a declined one is still refused', async (t) => {
  // The router's catalog reads wait at `gate`, in arrival order: routing first, then the other host's answer.
  let gate = null;
  let atGate = 0;
  const { dispatcher, router, mailbox, factoryCalls } = makeHarness(t, { routerGate: () => { atGate += 1; return gate?.promise; } });
  const SESSION = { assistantSessionId: 'assistant-1', origin: 'assistant' };
  const BODY = { task_class: 'code', confidence: 0.9, summary: 'write docs', proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'sonnet' }] };
  const runs = () => dispatcher.list({ assistantSessionId: 'assistant-1' });
  /** A dispatch on a pending route reaches the router's catalog read; another host's answer joins it; routing resumes first. */
  const race = async (route, spec, response) => {
    gate = deferred();
    atGate = 0;
    const dispatching = dispatcher.dispatch({ routeId: route.routeId, ...spec }, SESSION);
    for (let i = 0; i < 200 && atGate < 1; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(atGate, 1, 'routing waits at the catalog');
    const answering = router.answer(route.routeId, response);
    assert.equal(atGate, 2, 'the answer joined the same read');
    gate.resolve();
    const settled = await Promise.allSettled([dispatching, answering]);
    gate = null;
    return settled;
  };

  // 1. Approved meanwhile: the run starts on the approved target, once.
  const first = await router.propose({ sessionId: 'assistant-1', body: BODY, waitMs: 0 });
  assert.equal(first.status, 'pending');
  const [started, answer] = await race(first, { provider: 'claude-code', task: 'write docs', title: 'Docs' }, { optionId: 's1' });
  assert.equal(answer.status, 'fulfilled');
  assert.equal(answer.value.status, 'approved');
  assert.equal(started.status, 'fulfilled', `the dispatch was not refused: ${started.reason?.code || ''} ${started.reason?.message || ''}`);
  assert.deepEqual([started.value.ok, started.value.awaitingRoute, started.value.queued], [true, undefined, false]);
  assert.deepEqual([started.value.run.route.routeId, started.value.run.route.status, started.value.run.route.decidedBy], [first.routeId, 'approved', 'user']);
  assert.deepEqual([started.value.run.provider, started.value.run.model], ['claude-code', 'sonnet'], 'on the approved target');
  assert.match(started.value.next, /Do not dispatch it again/);
  await waitFor(() => factoryCalls.length === 1);
  assert.deepEqual(runs().map((run) => run.runId), [started.value.run.runId], 'one run, no held leftover');
  assert.equal(runs().some((run) => run.state === 'awaiting_route'), false);
  assert.equal(mailbox.filter((item) => item.kind === 'route_decided').length, 1);
  await waitFor(() => dispatcher.get(started.value.run.runId).state === 'idle');
  assert.equal(factoryCalls.length, 1, 'launched once');
  // The route's own "decided" event was emitted with no run attached ("Dispatch now"). Reconciled
  // with the session's runs before it is formatted, it names the run and asks for no dispatch.
  const raw = formatMailbox(mailbox);
  assert.match(raw, /next: agent_dispatch with route_id/, 'as emitted, the item still asks for a dispatch');
  const text = formatMailbox(reconcileRouteItems(mailbox, runs()));
  // (The mailbox's fixed closing line names the agent tools on every turn; the item itself asks for nothing.)
  assert.doesNotMatch(text, /next: agent_dispatch|with route_id|Dispatch now/i, text);
  assert.match(text, new RegExp(`route_decided · ${first.routeId} .* · runs ${started.value.run.runId.slice(0, 8)}`));
  assert.match(text, /already started on this route \([0-9a-f]{8}: idle\)\. Do not dispatch it again\./);
  assert.equal(runs().length, 1, 'exactly one run');

  // 2. Declined meanwhile: still refused, nothing held, nothing started.
  const second = await router.propose({ sessionId: 'assistant-1', body: BODY, waitMs: 0 });
  const [refused, declined] = await race(second, { provider: 'claude-code', task: 'write more docs', title: 'Docs 2' }, { decline: true });
  assert.equal(declined.value.status, 'declined');
  assert.equal(refused.status, 'rejected');
  assert.deepEqual([refused.reason.code, refused.reason.status], ['ROUTE_CANCELLED', 409]);
  assert.equal(runs().length, 1, 'no new run');
  assert.equal(factoryCalls.length, 1);
  assert.equal(router.pendingCards('assistant-1').length, 0);

  // 3. The ordinary path is unchanged: a route approved with no run yet still says "dispatch now",
  // and the brain may dispatch several runs on it (fan-out).
  const third = await router.propose({ sessionId: 'assistant-1', body: { ...BODY, summary: 'fan out' }, waitMs: 0 });
  const before = mailbox.length;
  await router.answer(third.routeId, { optionId: 's1' });
  const fresh = mailbox.slice(before);
  assert.deepEqual(reconcileRouteItems(fresh, runs()), fresh, 'no run on this route yet: the item is untouched');
  assert.match(formatMailbox(reconcileRouteItems(fresh, runs())), new RegExp(`next: agent_dispatch with route_id "${third.routeId}"`));
  const a = await dispatcher.dispatch({ routeId: third.routeId, provider: 'claude-code', task: 'part one', title: 'One' }, SESSION);
  const b = await dispatcher.dispatch({ routeId: third.routeId, provider: 'claude-code', task: 'part two', title: 'Two' }, SESSION);
  assert.deepEqual([a.run.route.routeId, b.run.route.routeId], [third.routeId, third.routeId], 'two runs on one approved route');
  assert.notEqual(a.run.runId, b.run.runId);
});

test('the same race in a remote (WhatsApp) session: the run goes through the remote clamps and uses the route up', async (t) => {
  let gate = null;
  let atGate = 0;
  const policy = { channel: 'whatsapp', level: 'ask', strictWorkerApprovals: false };
  let root = null;
  const h = makeHarness(t, {
    routerGate: () => { atGate += 1; return gate?.promise; },
    extra: { sessionPolicy: (id) => (id === 'assistant-1' ? policy : null), registeredProjects: () => [root] },
  });
  root = h.root;
  const { dispatcher, router, factoryCalls, sessions } = h;
  sessions.get('assistant-1').remote = true;
  const SESSION = { assistantSessionId: 'assistant-1', origin: 'assistant' };
  const BODY = { task_class: 'code', confidence: 0.9, summary: 'write docs', proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'sonnet' }] };
  const route = await router.propose({ sessionId: 'assistant-1', body: BODY, waitMs: 0 });
  gate = deferred();
  atGate = 0;
  const dispatching = dispatcher.dispatch({ routeId: route.routeId, provider: 'claude-code', task: 'write docs', title: 'Docs', cwd: root, usesComputer: true, tags: ['user-authorized-full', 'docs'] }, SESSION);
  for (let i = 0; i < 200 && atGate < 1; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(atGate, 1, 'routing waits at the catalog first');
  const answering = router.answer(route.routeId, { optionId: 's1' });
  assert.equal(atGate, 2, 'the answer joined the same read');
  gate.resolve();
  const started = await dispatching;
  await answering;
  gate = null;
  assert.equal(started.ok, true);
  assert.deepEqual([started.run.route.status, started.run.usesComputer, started.run.tags], ['approved', false, ['docs']], 'clamped like any approved remote route');
  await waitFor(() => factoryCalls.length === 1);
  // The remote route authorized this one dispatch: the same route id does not start a second run.
  const again = await dispatcher.dispatch({ routeId: route.routeId, provider: 'claude-code', task: 'write docs again', title: 'Docs again', cwd: root }, SESSION);
  assert.equal(again.awaitingRoute, true, 'asked again on a new card');
  assert.notEqual(again.routeId, route.routeId);
  assert.equal(factoryCalls.length, 1);
  // A decline in the same gap: refused, nothing held or started.
  assert.equal(router.cancel(again.routeId, 'superseded', { sessionId: 'assistant-1' }), true);
  const declinable = await router.propose({ sessionId: 'assistant-1', body: BODY, waitMs: 0 });
  gate = deferred();
  atGate = 0;
  const refusing = dispatcher.dispatch({ routeId: declinable.routeId, provider: 'claude-code', task: 'write docs', title: 'Docs', cwd: root }, SESSION);
  for (let i = 0; i < 200 && atGate < 1; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(atGate, 1);
  const declining = router.answer(declinable.routeId, { decline: true });
  gate.resolve();
  await assert.rejects(refusing, (error) => error.code === 'ROUTE_CANCELLED' && error.status === 409);
  assert.equal((await declining).status, 'declined');
  gate = null;
  assert.equal(dispatcher.list({ assistantSessionId: 'assistant-1' }).filter((run) => run.state === 'awaiting_route').length, 0);
  assert.equal(factoryCalls.length, 1);
});

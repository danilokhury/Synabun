import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAssistantRouter, evaluateRoute, normalizeRouteRequest, buildRouteOptions, targetFromAnswer, escalationFor, describeTarget,
  CANNOT_SEE_TEXT, TASK_CLASSES, UNAVAILABLE_TEXT, UNKNOWN_SIGHT_TEXT, classPlaybook, collectedMedia, designFit, requiresVision, runContract,
} from '../lib/assistant-router.js';
import { normalizeClaudeRows, normalizeCodexRows, parseOpenCodeProviders, createAssistantCatalog } from '../lib/assistant-catalog.js';
import { effectiveRouting } from '../lib/assistant-config.js';
import { CLAUDE_MODELS, CODEX_MODELS, OPENCODE_FULL, OPENCODE_MEDIA, PRICING, fakeFetch } from './assistant-catalog.fixtures.mjs';
import { gateStateFor } from '../lib/assistant-route-gate.js';

const CATALOG = {
  models: {
    'claude-code': normalizeClaudeRows(CLAUDE_MODELS.models, { pricing: PRICING }),
    codex: normalizeCodexRows(CODEX_MODELS.models),
    opencode: parseOpenCodeProviders(OPENCODE_FULL),
  },
};
const BRAIN = { provider: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash', effort: null };
const BRAIN_INFO = { vision: true, tier: 'small', label: 'DeepSeek V4.1 Flash', contextWindow: 1048576 };
const ROUTING = effectiveRouting({});

function request(body) { return normalizeRouteRequest(body, { brain: BRAIN }); }

test('normalizeRouteRequest: class, confidence (0..1 or %), vision, a direct proposal on another provider becomes a dispatch', () => {
  const req = request({ task_class: 'computer', confidence: 80, summary: 'open TextEdit', proposals: [{ kind: 'direct', provider: 'claude-code', model: 'sonnet' }] });
  assert.equal(req.taskClass, 'computer');
  assert.equal(req.confidence, 0.8);
  assert.equal(req.needsVision, true, 'computer tasks need vision');
  assert.equal(req.proposals[0].kind, 'dispatch');
  const fallback = request({ task_class: 'nonsense', proposals: [] });
  assert.equal(fallback.taskClass, 'quick');
  assert.deepEqual(fallback.proposals[0], { kind: 'direct', provider: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash', effort: null, reason: null });
});

test('evaluateRoute: always-ask asks every actionable task, never chat', () => {
  const chat = evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: request({ task_class: 'chat', confidence: 1 }), brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.equal(chat.ask, false);
  const code = evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: request({ task_class: 'code', confidence: 0.99, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'sonnet' }] }), brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.equal(code.ask, true);
  assert.equal(code.reasons[0], 'always-ask');
});

test('evaluateRoute: ask-unsure asks only for low confidence, unknown/missing models or a blind model on a vision task', () => {
  const sure = evaluateRoute({ mode: 'ask-unsure', routing: ROUTING, request: request({ task_class: 'code', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'sonnet', effort: 'high' }] }), brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.equal(sure.ask, false);
  assert.deepEqual(sure.auto, { kind: 'dispatch', provider: 'claude-code', model: 'sonnet', effort: 'high' });
  const low = evaluateRoute({ mode: 'ask-unsure', routing: ROUTING, request: request({ task_class: 'code', confidence: 0.4, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'sonnet' }] }), brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.deepEqual(low.reasons, ['low_confidence']);
  const unknown = evaluateRoute({ mode: 'ask-unsure', routing: ROUTING, request: request({ task_class: 'code', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-9-imaginary' }] }), brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.ok(unknown.reasons.includes('model_unknown'));
  const missing = evaluateRoute({ mode: 'ask-unsure', routing: ROUTING, request: request({ task_class: 'code', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'codex' }] }), brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.ok(missing.reasons.includes('model_missing'));
  const blind = evaluateRoute({ mode: 'ask-unsure', routing: ROUTING, request: request({ task_class: 'computer', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' }] }), brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.ok(blind.reasons.includes('needs_vision'));
  // A remembered preference fills an omitted model and removes the doubt.
  const remembered = evaluateRoute({ mode: 'ask-unsure', routing: { ...ROUTING, preferences: { code: { kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' } } }, request: request({ task_class: 'code', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'codex' }] }), brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.equal(remembered.ask, false);
  assert.equal(remembered.auto.model, 'gpt-5.6-luna');
  assert.equal(remembered.source, 'remembered');
});

test('evaluateRoute: never auto-corrects unknown models and blind picks for vision work', () => {
  const unknown = evaluateRoute({ mode: 'never', routing: ROUTING, request: request({ task_class: 'code', confidence: 0.2, proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-9-imaginary' }] }), brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.equal(unknown.ask, false);
  assert.equal(unknown.auto.model, null, 'falls back to the provider default');
  assert.equal(unknown.source, 'corrected');
  const blind = evaluateRoute({ mode: 'never', routing: ROUTING, request: request({ task_class: 'computer', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' }] }), brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.equal(blind.auto.model, 'ollama-cloud/deepseek-v4.1-flash', 'cheapest same-provider vision model');
});

test('route card options: suggested first, here, cheaper, stronger; blind "here" disabled for vision work', () => {
  const req = request({ task_class: 'code', confidence: 0.5, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'sonnet', reason: 'solid default' }] });
  const evaluation = evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: req, brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  const { options, defaultOptionId } = buildRouteOptions({ request: req, evaluation, brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG, routing: ROUTING });
  assert.equal(options[0].id, 's1');
  assert.equal(options[0].badge, 'suggested');
  assert.equal(options[0].reason, 'solid default');
  assert.equal(defaultOptionId, 's1');
  const here = options.find((o) => o.id === 'here');
  assert.equal(here.label, 'Do it here with DeepSeek V4.1 Flash');
  assert.equal(options.find((o) => o.badge === 'cheaper').model, 'haiku');
  assert.ok(['opus', 'claude-fable-5-1', 'default'].includes(options.find((o) => o.badge === 'stronger').model));
  const blindBrain = { provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' };
  const vreq = normalizeRouteRequest({ task_class: 'computer', confidence: 0.9, proposals: [{ kind: 'direct' }] }, { brain: blindBrain });
  const vevaluation = evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: vreq, brain: blindBrain, brainInfo: { vision: false, label: 'DeepSeek V4 Pro' }, catalog: CATALOG });
  const vcard = buildRouteOptions({ request: vreq, evaluation: vevaluation, brain: blindBrain, brainInfo: { vision: false, label: 'DeepSeek V4 Pro' }, catalog: CATALOG, routing: ROUTING });
  assert.equal(vcard.options.find((o) => o.id === 's1').disabled, true);
  assert.notEqual(vcard.defaultOptionId, 's1');
});

test('targetFromAnswer: options, catalog "other" picks, declines, invalid picks', () => {
  const card = { options: [{ id: 's1', kind: 'dispatch', provider: 'claude-code', model: 'sonnet', effort: 'high' }, { id: 'x', kind: 'direct', disabled: true, disabledReason: 'blind' }] };
  assert.deepEqual(targetFromAnswer({ card, response: { optionId: 's1', remember: true }, catalog: CATALOG, brain: BRAIN }), { target: { kind: 'dispatch', provider: 'claude-code', model: 'sonnet', effort: 'high' }, optionId: 's1', remember: true, corrections: [] });
  assert.deepEqual(targetFromAnswer({ card, response: { decline: true }, catalog: CATALOG, brain: BRAIN }), { declined: true });
  const other = targetFromAnswer({ card, response: { optionId: 'other', target: { kind: 'direct', provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' } }, catalog: CATALOG, brain: BRAIN });
  assert.equal(other.target.kind, 'direct');
  assert.throws(() => targetFromAnswer({ card, response: { optionId: 'x' }, catalog: CATALOG, brain: BRAIN }), (e) => e.code === 'ROUTE_INVALID');
  assert.throws(() => targetFromAnswer({ card, response: { optionId: 'other', target: { provider: 'codex', model: 'gpt-9-imaginary' } }, catalog: CATALOG, brain: BRAIN }), (e) => e.code === 'ROUTE_INVALID');
});

test('targetFromAnswer rechecks an open card against current hidden models and vision needs', () => {
  const card = { needsVision: false, options: [{ id: 's1', kind: 'dispatch', provider: 'codex', model: 'gpt-6-astra', effort: 'high', disabled: false }] };
  const hidden = { ...CATALOG, hidden: { codex: ['gpt-6-astra'] } };
  assert.throws(() => targetFromAnswer({ card, response: { optionId: 's1' }, catalog: hidden, brain: BRAIN }), (e) => e.code === 'MODEL_DISABLED');
  const allHidden = { ...hidden, models: { codex: [CATALOG.models.codex.find((row) => row.id === 'gpt-6-astra')] }, listed: { codex: 1 } };
  assert.throws(() => targetFromAnswer({ card, response: { optionId: 'other', target: { provider: 'codex' } }, catalog: allHidden, brain: BRAIN }), (e) => e.code === 'MODEL_DISABLED');

  const visionCard = { needsVision: true, options: [] };
  assert.throws(() => targetFromAnswer({ card: visionCard, response: { optionId: 'other', target: { provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' } }, catalog: CATALOG, brain: BRAIN }), (e) => e.code === 'ROUTE_INVALID' && /cannot see images/.test(e.message));
});

test('escalationFor: ladder first, then one tier up, never past depth 2', () => {
  const failed = { provider: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash', state: 'failed', completionReason: 'provider_error' };
  const byLadder = escalationFor({ run: failed, catalog: CATALOG, routing: { ...ROUTING, ladders: { opencode: ['ollama-cloud/deepseek-v4.1-flash', 'ollama-cloud/deepseek-v4-pro'] } } });
  assert.equal(byLadder.to.model, 'ollama-cloud/deepseek-v4-pro');
  assert.equal(byLadder.reason, 'failed');
  assert.equal(byLadder.depth, 1);
  const byTier = escalationFor({ run: { provider: 'claude-code', model: 'haiku', state: 'idle', lastResult: { status: 'blocked', found: true } }, catalog: CATALOG, routing: ROUTING });
  assert.equal(byTier.to.model, 'sonnet');
  assert.equal(escalationFor({ run: failed, catalog: CATALOG, routing: ROUTING, depth: 2 }), null);
  assert.equal(escalationFor({ run: { ...failed, completionReason: 'budget_cap' }, catalog: CATALOG, routing: ROUTING }), null, 'budget stops are not escalated');
  assert.equal(escalationFor({ run: { provider: 'codex', state: 'completed', lastResult: { status: 'done', found: true } }, catalog: CATALOG, routing: ROUTING }), null);
});

// `continues(payload)`: what the runtime's continueDirect answers (false: the pick's turn is gone).
// `catalogGate()`: a promise the router's catalog read waits on (an answer held in mid-flight, with no timer).
function harness(t, { mode = 'ask-unsure', routing = {}, brain = BRAIN, continues = () => true, catalogGate = null } = {}) {
  const built = createAssistantCatalog({ fetchJson: fakeFetch(), claudePricing: PRICING });
  const catalog = catalogGate
    ? { full: async (...args) => { await catalogGate(); return built.full(...args); }, peek: (...args) => built.peek(...args), brainInfo: (...args) => built.brainInfo(...args) }
    : built;
  let routingState = effectiveRouting(routing);
  const prefs = [];
  const configStore = {
    routing: () => routingState,
    setPreference: (key, target) => { prefs.push([key, target]); routingState = { ...routingState, preferences: { ...routingState.preferences, [key]: target } }; },
  };
  const sessions = new Map([['assistant-1', { brain, routingMode: mode }], ['assistant-2', { brain, routingMode: mode }]]);
  const sink = { cards: [], cancels: [], events: [], mailbox: [], continues: [], started: [], declined: [] };
  let n = 0;
  const router = createAssistantRouter({
    catalog, configStore, getSession: (id) => sessions.get(id) || null, randomId: () => `r${++n}`,
    sinks: {
      // `sink.onSend`: a host that acts while the card is being sent (the WhatsApp bridge closes it at once).
      sendCard: (sid, packet) => { sink.cards.push(packet); sink.onSend?.(sid, packet); }, cancelCard: (sid, id, reason) => sink.cancels.push([id, reason]),
      routeEvent: (sid, phase, route) => sink.events.push([phase, route]), mailbox: (sid, item) => sink.mailbox.push(item),
      continueDirect: (sid, payload) => { sink.continues.push(payload); return continues(payload); }, startHeld: (runId, target, meta) => sink.started.push([runId, target, meta]),
      declineHeld: (runId, reason) => sink.declined.push([runId, reason]),
    },
  });
  t.after(() => router.shutdown());
  return { router, sink, prefs, sessions, setMode: (m) => { sessions.get('assistant-1').routingMode = m; } };
}

test('propose: never approves at once with an auto route event', async (t) => {
  const { router, sink } = harness(t, { mode: 'never' });
  const result = await router.propose({ sessionId: 'assistant-1', body: { task_class: 'code', confidence: 0.3, summary: 'fix bug', proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'sonnet' }] } });
  assert.equal(result.status, 'approved');
  assert.equal(result.target.provider, 'claude-code');
  assert.match(result.next, /agent_dispatch route_id="route-r1"/);
  assert.equal(sink.cards.length, 0);
  assert.equal(sink.events[0][0], 'auto');
  // The approved route id is reusable by agent_dispatch.
  const dispatch = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { routeId: result.routeId, task: 'x' } });
  assert.equal(dispatch.action, 'start');
  assert.equal(dispatch.spec.model, 'sonnet');
});

test('propose: a card answered in time returns the user\'s pick and remembers it', async (t) => {
  const { router, sink, prefs } = harness(t, { mode: 'always-ask' });
  const pending = router.propose({ sessionId: 'assistant-1', body: { task_class: 'code', confidence: 0.9, summary: 'refactor', proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'sonnet' }] }, waitMs: 2000 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sink.cards.length, 1);
  const card = sink.cards[0];
  assert.equal(card.request.subtype, 'route');
  assert.ok(router.owns(card.request_id));
  const stronger = card.request.options.find((o) => o.badge === 'stronger');
  await router.answer(card.request_id, { optionId: stronger.id, remember: true });
  const result = await pending;
  assert.equal(result.status, 'approved');
  assert.equal(result.source, 'user');
  assert.equal(result.target.model, stronger.model);
  assert.equal(prefs[0][0], 'code');
  assert.equal(sink.mailbox.length, 0, 'an in-turn answer needs no mailbox turn');
  assert.ok(sink.events.some(([phase]) => phase === 'decided'));
  await assert.rejects(router.answer(card.request_id, { optionId: 's1' }), (e) => e.code === 'ROUTE_ALREADY_DECIDED');
});

test('propose: pending after the wait; the later pick arrives through the mailbox', async (t) => {
  const { router, sink } = harness(t, { mode: 'always-ask' });
  const result = await router.propose({ sessionId: 'assistant-1', body: { task_class: 'research', confidence: 0.9, summary: 'look up', proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' }] }, waitMs: 0 });
  assert.equal(result.status, 'pending');
  assert.match(result.next, /End your turn/);
  await router.answer(result.routeId, { optionId: 's1' });
  assert.equal(sink.mailbox.length, 1);
  assert.equal(sink.mailbox[0].kind, 'route_decided');
  assert.equal(sink.mailbox[0].route.target.model, 'gpt-5.6-luna');
});

test('a "here" pick on another model of the brain\'s provider becomes a continuation turn', async (t) => {
  const { router, sink } = harness(t, { mode: 'always-ask' });
  const pending = router.propose({ sessionId: 'assistant-1', body: { task_class: 'quick', confidence: 0.9, summary: 'tidy', proposals: [{ kind: 'direct' }] }, waitMs: 2000 });
  await new Promise((r) => setTimeout(r, 20));
  const card = sink.cards[0];
  await router.answer(card.request_id, { optionId: 'other', target: { kind: 'direct', provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' } });
  const result = await pending;
  assert.equal(result.continuation, true);
  assert.match(result.next, /End your turn/);
  assert.equal(sink.continues[0].target.model, 'ollama-cloud/deepseek-v4-pro');
});

test('a "here" pick the runtime refuses (a newer prompt, a Stop or a close replaced its turn) is not approved: the card expires, nothing is remembered or decided', async (t) => {
  const { router, sink, prefs } = harness(t, { mode: 'always-ask', continues: () => false });
  const pending = router.propose({ sessionId: 'assistant-1', body: { task_class: 'quick', confidence: 0.9, summary: 'tidy', proposals: [{ kind: 'direct' }] }, waitMs: 2000 });
  for (let i = 0; i < 200 && !sink.cards.length; i += 1) await new Promise((r) => setImmediate(r));
  const card = sink.cards[0];
  const answer = await router.answer(card.request_id, { optionId: 'other', target: { kind: 'direct', provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' }, remember: true });
  assert.deepEqual([answer.status, answer.reason, answer.continuation], ['expired', 'superseded', false]);
  assert.match(answer.next, /no longer valid/);
  assert.equal(sink.continues.length, 1, 'the runtime was asked once');
  assert.deepEqual(sink.cancels, [[card.request_id, 'superseded']], 'the card closes (it reads Expired)');
  assert.deepEqual(sink.events.map(([phase]) => phase), ['card', 'expired'], 'never decided');
  assert.deepEqual([prefs.length, sink.mailbox.length], [0, 0], 'nothing remembered, no mailbox turn');
  const heard = await pending;
  assert.deepEqual([heard.status, heard.continuation], ['expired', false], 'the turn that asked is told not to start it');
  assert.match(heard.next, /no longer valid\. Do not start the task; ask the user how to proceed\./, 'the desktop wording is unchanged (only a cancel says the user moved on)');
  await assert.rejects(router.answer(card.request_id, { optionId: 'other', target: { kind: 'direct', provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' } }), (e) => e.code === 'ROUTE_NOT_FOUND');
  const dispatch = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { routeId: card.request.routeId, provider: 'opencode', task: 'x' } });
  assert.equal(dispatch.action, 'hold', 'the route id authorizes nothing');
});

test('resolveDispatch holds un-routed dispatches in ask modes, joins a workflow on one card, and starts them on the pick', async (t) => {
  const { router, sink } = harness(t, { mode: 'always-ask' });
  const first = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { provider: 'claude-code', task: 'a', workflowId: 'wf' } });
  assert.equal(first.action, 'hold');
  router.holdRuns(first.routeId, ['run-a']);
  const second = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { provider: 'claude-code', task: 'b', workflowId: 'wf' } });
  assert.equal(second.routeId, first.routeId, 'same workflow → same card');
  router.holdRuns(second.routeId, ['run-b']);
  assert.equal(sink.cards.length, 1);
  assert.deepEqual(sink.cards[0].request.runIds, ['run-a', 'run-b']);
  const ui = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { provider: 'codex', task: 'c' }, origin: 'ui' });
  assert.equal(ui.action, 'start', 'the user\'s own dispatches are never held');
  await router.answer(first.routeId, { optionId: 'here' });
  assert.deepEqual(sink.started.map(([runId]) => runId), ['run-a', 'run-b']);
  assert.equal(sink.mailbox[0].kind, 'route_decided');
});

test('cards expire: held runs are declined and the brain hears about it', async (t) => {
  const { router, sink } = harness(t, { mode: 'always-ask', routing: { cardTimeoutMinutes: 1 } });
  const held = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { provider: 'claude-code', task: 'a' } });
  router.holdRuns(held.routeId, ['run-x']);
  router._internals.cards.get(held.routeId).expiresAt = Date.now();
  // Fire the expiry directly (the timer is minutes away).
  const card = router._internals.cards.get(held.routeId);
  clearTimeout(card.timer);
  router.cancelForRun('run-unrelated');
  router.cancelForSession('assistant-1', 'expired');
  assert.deepEqual(sink.declined, [['run-x', 'route_expired']]);
  assert.equal(sink.cancels[0][1], 'expired');
  assert.equal(sink.mailbox[0].kind, 'route_expired');
});

test('stamp changes when the mode changes', (t) => {
  const { router, setMode } = harness(t, { mode: 'ask-unsure' });
  const first = router.stamp('assistant-1');
  assert.equal(first.changed, true);
  first.commit();
  assert.equal(router.stamp('assistant-1').changed, false);
  setMode('never');
  const next = router.stamp('assistant-1');
  assert.equal(next.changed, true);
  assert.match(next.text, /never ask/);
});

test('describeTarget labels the brain model through brainInfo', () => {
  const d = describeTarget({ kind: 'direct', provider: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash' }, { catalog: CATALOG, brain: BRAIN, brainInfo: BRAIN_INFO });
  assert.equal(d.label, 'DeepSeek V4.1 Flash');
  assert.equal(d.vision, true);
});

test('escalationFor follows the judged cause: access / needs_user → none (even at depth 2), transient → retry, capability → the ladder', () => {
  const routing = { ...ROUTING, ladders: { opencode: ['ollama-cloud/deepseek-v4.1-flash', 'ollama-cloud/deepseek-v4-pro'] } };
  const base = { provider: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash', effort: 'high', state: 'failed', completionReason: 'provider_error' };
  const access = escalationFor({ run: { ...base, failure: { cause: 'access', needs: 'EACCES: permission denied, open /etc/hosts', source: 'jev' } }, catalog: CATALOG, routing });
  assert.equal(access.kind, 'none');
  assert.equal(access.to, null);
  assert.equal(access.cause, 'access');
  assert.equal(access.needs, 'EACCES: permission denied, open /etc/hosts');
  assert.equal(access.depth, 0);
  const atMax = escalationFor({ run: { ...base, failure: { cause: 'needs_user', needs: 'Which account?' } }, catalog: CATALOG, routing, depth: 2 });
  assert.equal(atMax.kind, 'none', 'returned even at the maximum depth');
  assert.equal(atMax.cause, 'needs_user');
  const transient = escalationFor({ run: { ...base, failure: { cause: 'transient' } }, catalog: CATALOG, routing });
  assert.equal(transient.kind, 'retry');
  assert.equal(transient.to.provider, 'opencode');
  assert.equal(transient.to.model, 'ollama-cloud/deepseek-v4.1-flash');
  assert.equal(transient.to.effort, 'high');
  assert.equal(transient.depth, 1);
  assert.equal(escalationFor({ run: { ...base, failure: { cause: 'transient' } }, catalog: CATALOG, routing, depth: 2 }), null, 'depth 2 caps retries too');
  const capability = escalationFor({ run: { ...base, failure: { cause: 'capability' } }, catalog: CATALOG, routing });
  assert.equal(capability.kind, 'escalate');
  assert.equal(capability.cause, 'capability');
  assert.equal(capability.to.model, 'ollama-cloud/deepseek-v4-pro');
  const unjudged = escalationFor({ run: base, catalog: CATALOG, routing });
  assert.equal(unjudged.kind, 'escalate');
  assert.equal(unjudged.cause, null);
  // A blocked result reads its cause from lastResult; a failure from run.failure.
  const blocked = escalationFor({ run: { ...base, state: 'idle', lastResult: { status: 'blocked', found: true, cause: 'access', needs: 'an API key' }, failure: { cause: 'capability' } }, catalog: CATALOG, routing });
  assert.equal(blocked.reason, 'blocked');
  assert.equal(blocked.kind, 'none');
  // A status Jev read without a ## Result block is a usable result: no "no_result" escalation.
  assert.equal(escalationFor({ run: { ...base, state: 'idle', lastResult: { status: 'done', found: false, source: 'jev' } }, catalog: CATALOG, routing }), null);
  assert.equal(escalationFor({ run: { ...base, state: 'idle', lastResult: { status: 'unknown', found: false, source: null } }, catalog: CATALOG, routing }).reason, 'no_result');
});

test('hidden Claude / Codex models (a hand-built catalog still carrying the rows): isDisabled and "stronger" skip them', () => {
  const catalog = { ...CATALOG, hidden: { 'claude-code': ['claude-opus-5-5', 'claude-fable-5-1'], codex: ['gpt-6-astra'], opencode: [] } };
  const brain = { provider: 'claude-code', model: 'sonnet', effort: null };
  const req = normalizeRouteRequest({ task_class: 'code', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-6-astra' }] }, { brain });
  const never = evaluateRoute({ mode: 'never', routing: ROUTING, request: req, brain, catalog });
  assert.ok(never.reasons.includes('model_disabled'));
  assert.notEqual(never.auto.model, 'gpt-6-astra');
  const ask = evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: req, brain, catalog });
  const { options } = buildRouteOptions({ request: req, evaluation: ask, brain, catalog, routing: ROUTING });
  assert.equal(options.find((o) => o.model === 'gpt-6-astra').disabled, true);
  // opus / default resolve to the hidden claude-opus-5-5; Fable is hidden by id.
  for (const o of options.filter((x) => x.provider === 'claude-code' && !x.disabled)) assert.ok(!['opus', 'default', 'claude-fable-5-1'].includes(o.model), o.model);
});

// ── never mode: saved routes are binding (the brain only classifies) ─────────
const SAVED = (prefs) => ({ ...ROUTING, preferences: prefs });

test('never: a saved dispatch route overrides a direct pick, and the correction says so', () => {
  const ev = evaluateRoute({ mode: 'never', routing: SAVED({ code: { kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' } }), request: request({ task_class: 'code', confidence: 0.9, proposals: [{ kind: 'direct' }] }), brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.equal(ev.ask, false);
  assert.deepEqual([ev.auto.kind, ev.auto.provider, ev.auto.model], ['dispatch', 'codex', 'gpt-5.6-luna']);
  assert.equal(ev.source, 'remembered');
  assert.equal(ev.bound, true);
  const c = ev.corrections.find((x) => x.reason === 'remembered_route');
  assert.equal(c.field, 'route');
  assert.equal(c.from, 'here on ollama-cloud/deepseek-v4.1-flash');
  assert.equal(c.to, 'codex/gpt-5.6-luna');
  assert.match(c.text, /saved Coding route/);
});

test('never: a named-model dispatch is overridden; the saved effort wins, else the brain\'s', () => {
  const req = request({ task_class: 'code', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'sonnet', effort: 'medium' }] });
  const withEffort = evaluateRoute({ mode: 'never', routing: SAVED({ code: { kind: 'dispatch', provider: 'claude-code', model: 'opus', effort: 'high' } }), request: req, brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.deepEqual([withEffort.auto.provider, withEffort.auto.model, withEffort.auto.effort], ['claude-code', 'opus', 'high']);
  const noEffort = evaluateRoute({ mode: 'never', routing: SAVED({ code: { kind: 'dispatch', provider: 'claude-code', model: 'opus' } }), request: req, brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.equal(noEffort.auto.effort, 'medium', 'the brain\'s proposed effort fills in');
  // The same route the table holds: no override correction, still decided by the table.
  const same = evaluateRoute({ mode: 'never', routing: SAVED({ code: { kind: 'dispatch', provider: 'claude-code', model: 'sonnet' } }), request: req, brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.equal(same.corrections.some((x) => x.reason === 'remembered_route'), false);
  assert.equal(same.source, 'remembered');
});

test('never: a saved route on a hidden model is ignored; the brain\'s pick stands and the result says so', () => {
  const catalog = { ...CATALOG, hidden: { 'claude-code': [], codex: ['gpt-5.6-luna'], opencode: [] } };
  const ev = evaluateRoute({ mode: 'never', routing: SAVED({ code: { kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' } }), request: request({ task_class: 'code', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'sonnet' }] }), brain: BRAIN, brainInfo: BRAIN_INFO, catalog });
  assert.deepEqual([ev.auto.provider, ev.auto.model], ['claude-code', 'sonnet']);
  assert.equal(ev.bound, false);
  assert.equal(ev.source, 'brain');
  assert.equal(ev.corrections.find((x) => x.reason === 'remembered_disabled')?.from, 'codex/gpt-5.6-luna');
});

test('never: chat stays unbound; the ask modes ignore saved routes as before', () => {
  const prefs = SAVED({ chat: { kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' }, code: { kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' } });
  const chat = evaluateRoute({ mode: 'never', routing: prefs, request: request({ task_class: 'chat', confidence: 1 }), brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.deepEqual([chat.auto.kind, chat.auto.provider], ['direct', 'opencode']);
  const req = request({ task_class: 'code', confidence: 0.95, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'sonnet' }] });
  const unsure = evaluateRoute({ mode: 'ask-unsure', routing: prefs, request: req, brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.deepEqual([unsure.ask, unsure.auto.provider, unsure.auto.model, unsure.source], [false, 'claude-code', 'sonnet', 'brain']);
  const always = evaluateRoute({ mode: 'always-ask', routing: prefs, request: req, brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.equal(always.ask, true);
  assert.equal(always.proposal.model, 'sonnet');
});

test('never: needs_vision still corrects a bound route that cannot see', () => {
  const ev = evaluateRoute({ mode: 'never', routing: SAVED({ computer: { kind: 'direct', provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' } }), request: request({ task_class: 'computer', confidence: 0.9, proposals: [{ kind: 'direct' }] }), brain: BRAIN, brainInfo: BRAIN_INFO, catalog: CATALOG });
  assert.equal(ev.auto.model, 'ollama-cloud/deepseek-v4.1-flash');
  assert.ok(ev.corrections.some((x) => x.reason === 'needs_vision'));
});

test('propose (never): the bound route drives next; a saved "here" on another model of the brain\'s provider is a continuation', async (t) => {
  const { router, sink } = harness(t, { mode: 'never', routing: { preferences: { code: { kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' }, quick: { kind: 'direct', provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' } } } });
  const bound = await router.propose({ sessionId: 'assistant-1', body: { task_class: 'code', confidence: 0.9, summary: 'fix', proposals: [{ kind: 'direct' }] } });
  assert.equal(bound.target.provider, 'codex');
  assert.equal(bound.source, 'remembered');
  assert.match(bound.next, /saved route for this task class applies \(codex\/gpt-5.6-luna\)/);
  assert.match(bound.next, /agent_dispatch route_id="route-r1"/);
  assert.equal(sink.events[0][1].decidedBy, 'remembered');
  assert.ok(sink.events[0][1].corrections.some((c) => c.reason === 'remembered_route'));
  const here = await router.propose({ sessionId: 'assistant-1', body: { task_class: 'quick', confidence: 0.9, summary: 'tidy', proposals: [{ kind: 'direct' }] } });
  assert.equal(here.continuation, true);
  assert.equal(sink.continues.at(-1).target.model, 'ollama-cloud/deepseek-v4-pro');
});

test('resolveDispatch (never): an un-routed dispatch is bound to the saved route', async (t) => {
  const { router } = harness(t, { mode: 'never', routing: { preferences: { code: { kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' } } } });
  const out = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { provider: 'claude-code', model: 'sonnet', task: 'x', taskClass: 'code' } });
  assert.equal(out.action, 'start');
  assert.deepEqual([out.spec.provider, out.spec.model], ['codex', 'gpt-5.6-luna']);
  assert.equal(out.route.decidedBy, 'remembered');
  assert.deepEqual(out.route.requested, { provider: 'claude-code', model: 'sonnet', effort: null });
});

test('propose reports every agent_route outcome to the gate sinks; a router failure reports routeFailed', async (t) => {
  const catalog = createAssistantCatalog({ fetchJson: fakeFetch(), claudePricing: PRICING });
  const seen = [];
  const router = createAssistantRouter({
    catalog, configStore: { routing: () => effectiveRouting({}) }, getSession: (id) => (id === 'ok' ? { brain: BRAIN, routingMode: 'never' } : null),
    sinks: { routed: (sid, result, meta) => seen.push(['routed', sid, result.status, meta?.taskClass]), routeFailed: (sid, error) => seen.push(['failed', sid, error.code]) },
  });
  t.after(() => router.shutdown());
  await router.propose({ sessionId: 'ok', body: { task_class: 'quick', confidence: 0.9, summary: 's', proposals: [{ kind: 'direct' }] } });
  await router.propose({ sessionId: 'ok', body: { task_class: 'chat', summary: 'hi', proposals: [{ kind: 'direct' }] } });
  await assert.rejects(router.propose({ sessionId: 'missing', body: {} }));
  assert.deepEqual(seen, [['routed', 'ok', 'approved', 'quick'], ['routed', 'ok', 'approved', 'chat'], ['failed', 'missing', 'SESSION_NOT_FOUND']]);
});

// ── Image creation / Video creation (dispatch only, a model that makes the medium) ──
// CATALOG: the Codex GPT rows make images (built-in tool); nothing makes video.
// MEDIA: OpenCode also has image makers (media-lab/pixel-flash $2.50, studio/pixel-pro $30) and video makers (reel-1 $6, motion-1 $12).
// (OpenCode neighbours come from another upstream provider: neighbour() skips rows sharing the current row's upstream.)
const MEDIA = { models: { ...CATALOG.models, opencode: [...CATALOG.models.opencode, ...parseOpenCodeProviders(OPENCODE_MEDIA)] } };
const CODEX_BRAIN = { provider: 'codex', model: 'gpt-5.6-luna', effort: null };
const CLAUDE_BRAIN = { provider: 'claude-code', model: 'sonnet', effort: null };
const media = (body, brain = CLAUDE_BRAIN) => normalizeRouteRequest(body, { brain });

test('image_gen / video_gen: dispatch-only classes; a "here" proposal becomes a dispatch on the brain\'s model', () => {
  const req = media({ task_class: 'image_gen', confidence: 0.9, summary: 'logo', proposals: [{ kind: 'direct' }, { kind: 'direct', model: 'gpt-6-astra' }] }, CODEX_BRAIN);
  assert.deepEqual([req.taskClassLabel, req.needsOutput, req.dispatchOnly, req.coercedDirect], ['Image creation', 'image', true, true]);
  assert.deepEqual(req.proposals.map((p) => [p.kind, p.provider, p.model]), [['dispatch', 'codex', 'gpt-5.6-luna'], ['dispatch', 'codex', 'gpt-6-astra']]);
  const video = media({ task_class: 'video_gen', proposals: [] });
  assert.deepEqual([video.needsOutput, video.proposals[0].kind, video.proposals[0].model, video.coercedDirect], ['video', 'dispatch', null, false]);
  assert.equal(media({ task_class: 'code', proposals: [{ kind: 'direct' }] }).needsOutput, undefined, 'other classes keep their shape');
});

test('image_gen: a direct pick runs as a dispatch in every mode, and the correction says so', () => {
  for (const mode of ['never', 'ask-unsure']) {
    const ev = evaluateRoute({ mode, routing: ROUTING, request: media({ task_class: 'image_gen', confidence: 0.95, proposals: [{ kind: 'direct' }] }, CODEX_BRAIN), brain: CODEX_BRAIN, catalog: CATALOG });
    assert.equal(ev.ask, false, mode);
    assert.deepEqual([ev.auto.kind, ev.auto.provider, ev.auto.model], ['dispatch', 'codex', 'gpt-5.6-luna'], mode);
    assert.equal(ev.corrections.find((c) => c.reason === 'dispatch_only')?.text, 'Image creation always runs on a worker, not here');
  }
  // A saved "here" route is a dispatch onto the same model.
  const saved = evaluateRoute({ mode: 'never', routing: SAVED({ image_gen: { kind: 'direct', provider: 'codex', model: 'gpt-6-astra' } }), request: media({ task_class: 'image_gen', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'codex' }] }, CODEX_BRAIN), brain: CODEX_BRAIN, catalog: CATALOG });
  assert.deepEqual([saved.auto.kind, saved.auto.model, saved.bound], ['dispatch', 'gpt-6-astra', true]);
});

test('image_gen (never): an incapable pick is corrected — same provider first, else the cheapest maker anywhere', () => {
  const opus = evaluateRoute({ mode: 'never', routing: ROUTING, request: media({ task_class: 'image_gen', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }] }), brain: CLAUDE_BRAIN, catalog: CATALOG });
  assert.deepEqual([opus.auto.provider, opus.auto.model], ['codex', 'gpt-5.6-luna'], 'no Claude maker: the cheapest anywhere (unpriced Codex rows: the smaller tier)');
  const c = opus.corrections.find((x) => x.reason === 'needs_output');
  assert.equal(c.text, 'Image creation needs a model that makes images: claude-code/opus → codex/gpt-5.6-luna');
  assert.equal(opus.source, 'corrected');
  const priced = evaluateRoute({ mode: 'never', routing: ROUTING, request: media({ task_class: 'image_gen', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }] }), brain: CLAUDE_BRAIN, catalog: MEDIA });
  assert.equal(priced.auto.model, 'media-lab/pixel-flash', 'a priced maker is cheaper than an unpriced one');
  const sameProvider = evaluateRoute({ mode: 'never', routing: ROUTING, request: media({ task_class: 'image_gen', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'opencode', model: 'media-lab/text-only' }] }), brain: CLAUDE_BRAIN, catalog: MEDIA });
  assert.equal(sameProvider.auto.model, 'media-lab/pixel-flash', 'unknown outputs never qualify; the same provider\'s maker comes first');
  const defaultCodex = evaluateRoute({ mode: 'never', routing: ROUTING, request: media({ task_class: 'image_gen', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'codex' }] }), brain: CLAUDE_BRAIN, catalog: CATALOG });
  assert.deepEqual([defaultCodex.auto.provider, defaultCodex.auto.model], ['codex', null], 'the Codex default makes images: kept');
  assert.ok(!defaultCodex.corrections.some((x) => x.reason === 'needs_output'));
});

test('image_gen (never): a saved route that cannot make images is not applied; a capable one binds', () => {
  const incapable = evaluateRoute({ mode: 'never', routing: SAVED({ image_gen: { kind: 'dispatch', provider: 'claude-code', model: 'opus' } }), request: media({ task_class: 'image_gen', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-6-astra' }] }), brain: CLAUDE_BRAIN, catalog: CATALOG });
  assert.deepEqual([incapable.auto.model, incapable.bound, incapable.source], ['gpt-6-astra', false, 'brain']);
  assert.equal(incapable.corrections.find((x) => x.reason === 'remembered_incapable').text, 'saved Image creation route claude-code/opus cannot make images; not applied');
  const capable = evaluateRoute({ mode: 'never', routing: SAVED({ image_gen: { kind: 'dispatch', provider: 'opencode', model: 'studio/pixel-pro' } }), request: media({ task_class: 'image_gen', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }] }), brain: CLAUDE_BRAIN, catalog: MEDIA });
  assert.deepEqual([capable.auto.model, capable.bound], ['studio/pixel-pro', true]);
});

test('image_gen (ask-unsure): an incapable pick asks; a capable confident pick does not; always-ask always asks', () => {
  const blind = evaluateRoute({ mode: 'ask-unsure', routing: ROUTING, request: media({ task_class: 'image_gen', confidence: 0.95, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }] }), brain: CLAUDE_BRAIN, catalog: CATALOG });
  assert.deepEqual([blind.ask, blind.reasons], [true, ['needs_output']]);
  const unknown = evaluateRoute({ mode: 'ask-unsure', routing: ROUTING, request: media({ task_class: 'image_gen', confidence: 0.95, proposals: [{ kind: 'dispatch', provider: 'opencode', model: 'media-lab/text-only' }] }), brain: CLAUDE_BRAIN, catalog: MEDIA });
  assert.ok(unknown.reasons.includes('needs_output'), 'null never qualifies');
  const sure = evaluateRoute({ mode: 'ask-unsure', routing: ROUTING, request: media({ task_class: 'image_gen', confidence: 0.95, proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-6-astra' }] }), brain: CLAUDE_BRAIN, catalog: CATALOG });
  assert.deepEqual([sure.ask, sure.auto.model], [false, 'gpt-6-astra']);
  assert.equal(evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: media({ task_class: 'image_gen', confidence: 0.95, proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-6-astra' }] }), brain: CLAUDE_BRAIN, catalog: CATALOG }).ask, true);
});

test('image_gen card: no "here", incapable models disabled, neighbours and the stand-in make images', () => {
  const req = media({ task_class: 'image_gen', confidence: 0.4, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }] });
  const evaluation = evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: req, brain: CLAUDE_BRAIN, catalog: MEDIA });
  const { options, defaultOptionId } = buildRouteOptions({ request: req, evaluation, brain: CLAUDE_BRAIN, catalog: MEDIA, routing: ROUTING });
  assert.ok(!options.some((o) => o.id === 'here' || o.kind === 'direct'), 'always a worker');
  const s1 = options.find((o) => o.id === 's1');
  assert.deepEqual([s1.disabled, s1.disabledReason], [true, "This model can't generate images."]);
  const g1 = options.find((o) => o.id === 'g1');
  assert.deepEqual([g1.badge, g1.model, g1.disabled], ['capable', 'media-lab/pixel-flash', false]);
  assert.equal(defaultOptionId, 'g1');
  assert.ok(!options.some((o) => o.provider === 'claude-code' && !o.disabled), 'no Claude stand-in (Claude makes no images)');
  // A capable pick: cheaper / stronger stay among the makers of its provider.
  const pro = media({ task_class: 'image_gen', confidence: 0.4, proposals: [{ kind: 'dispatch', provider: 'opencode', model: 'studio/pixel-pro' }] });
  const proCard = buildRouteOptions({ request: pro, evaluation: evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: pro, brain: CLAUDE_BRAIN, catalog: MEDIA }), brain: CLAUDE_BRAIN, catalog: MEDIA, routing: ROUTING });
  assert.equal(proCard.options.find((o) => o.badge === 'cheaper').model, 'media-lab/pixel-flash');
  assert.ok(!proCard.options.some((o) => o.badge === 'capable'), 'no stand-in when the suggestion can make images');
  for (const o of proCard.options) assert.equal(o.disabled, false, o.id);
  // A capable saved route is the stand-in, listed once as "remembered".
  const saved = { ...ROUTING, preferences: { image_gen: { kind: 'dispatch', provider: 'codex', model: 'gpt-6-astra' } } };
  const withPref = buildRouteOptions({ request: req, evaluation: evaluateRoute({ mode: 'always-ask', routing: saved, request: req, brain: CLAUDE_BRAIN, catalog: MEDIA }), brain: CLAUDE_BRAIN, catalog: MEDIA, routing: saved });
  assert.deepEqual(withPref.options.filter((o) => !o.disabled).map((o) => [o.id, o.badge, o.model]), [['r1', 'remembered', 'gpt-6-astra']]);
  assert.equal(withPref.defaultOptionId, 'r1');
});

test('image_gen card answers: picks become dispatches, an incapable "other" pick is refused', () => {
  const card = { needsOutput: 'image', dispatchOnly: true, options: [{ id: 's1', kind: 'dispatch', provider: 'codex', model: 'gpt-6-astra', effort: null }] };
  assert.deepEqual(targetFromAnswer({ card, response: { optionId: 's1' }, catalog: CATALOG, brain: CODEX_BRAIN }).target, { kind: 'dispatch', provider: 'codex', model: 'gpt-6-astra', effort: null });
  const here = targetFromAnswer({ card, response: { optionId: 'other', target: { kind: 'direct', provider: 'codex', model: 'gpt-5.6-luna' } }, catalog: CATALOG, brain: CODEX_BRAIN });
  assert.equal(here.target.kind, 'dispatch', 'a "here" pick on the brain\'s provider still runs on a worker');
  assert.throws(() => targetFromAnswer({ card, response: { optionId: 'other', target: { provider: 'claude-code', model: 'opus' } }, catalog: CATALOG, brain: CODEX_BRAIN }), (e) => e.code === 'ROUTE_INVALID' && e.message === "This model can't generate images.");
  assert.throws(() => targetFromAnswer({ card: { ...card, needsOutput: 'video' }, response: { optionId: 'other', target: { provider: 'codex', model: 'gpt-6-astra' } }, catalog: CATALOG, brain: CODEX_BRAIN }), (e) => /can't generate videos/.test(e.message));
});

test('video_gen with no model that makes video: unavailable in every mode (no card)', () => {
  for (const mode of ['always-ask', 'ask-unsure', 'never']) {
    const ev = evaluateRoute({ mode, routing: ROUTING, request: media({ task_class: 'video_gen', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-6-astra' }] }), brain: CLAUDE_BRAIN, catalog: CATALOG });
    assert.deepEqual([ev.ask, ev.unavailable, ev.auto], [false, 'no_capable_model', null], mode);
  }
  // A hidden maker does not count.
  const hidden = { ...MEDIA, hidden: { opencode: ['legacy-media/reel-1', 'media-lab/motion-1'] } };
  assert.equal(evaluateRoute({ mode: 'never', routing: ROUTING, request: media({ task_class: 'video_gen', confidence: 0.9 }), brain: CLAUDE_BRAIN, catalog: hidden }).unavailable, 'no_capable_model');
  const found = evaluateRoute({ mode: 'never', routing: ROUTING, request: media({ task_class: 'video_gen', confidence: 0.9 }), brain: CLAUDE_BRAIN, catalog: MEDIA });
  assert.deepEqual([found.auto.provider, found.auto.model], ['opencode', 'legacy-media/reel-1'], 'the cheapest video maker');
});

test('propose: no_capable_model declines at once in every mode with a next that names the row; an un-routed dispatch is refused', async (t) => {
  for (const mode of ['always-ask', 'ask-unsure', 'never']) {
    const { router, sink } = harness(t, { mode });
    const result = await router.propose({ sessionId: 'assistant-1', body: { task_class: 'video_gen', confidence: 0.9, summary: 'waves', proposals: [{ kind: 'dispatch', provider: 'codex' }] }, waitMs: 0 });
    assert.deepEqual([result.status, result.reason, result.requires, result.target], ['declined', 'no_capable_model', 'video', null], mode);
    assert.match(result.next, /No model in the user's catalog can make videos/);
    assert.match(result.next, /Video creation row in Model routes/);
    assert.match(result.next, /Do not start it or dispatch it/);
    assert.equal(sink.cards.length, 0, `${mode}: no card`);
    const [phase, route] = sink.events.at(-1);
    assert.deepEqual([phase, route.reasonCode, route.taskClassLabel], ['declined', 'no_capable_model', 'Video creation']);
    await assert.rejects(router.resolveDispatch({ sessionId: 'assistant-1', spec: { provider: 'codex', task: 'waves', taskClass: 'video_gen' } }), (e) => e.code === 'NO_CAPABLE_MODEL' && e.status === 409 && e.requires === 'video');
  }
  assert.deepEqual(gateStateFor({ ok: true, status: 'declined', reason: 'no_capable_model' }).state, 'held');
  assert.match(gateStateFor({ ok: true, status: 'declined', reason: 'no_capable_model' }).text, /which Model routes row needs a model/);
});

test('propose + dispatch (never): image_gen routes carry the class and its label to the run', async (t) => {
  const { router, sink } = harness(t, { mode: 'never', brain: CODEX_BRAIN });
  const result = await router.propose({ sessionId: 'assistant-1', body: { task_class: 'image_gen', confidence: 0.9, summary: 'bunny logo', proposals: [{ kind: 'direct' }] } });
  assert.deepEqual([result.status, result.target.kind, result.target.model, result.continuation], ['approved', 'dispatch', 'gpt-5.6-luna', false]);
  assert.equal(sink.continues.length, 0, 'never a continuation');
  const out = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { routeId: result.routeId, task: 'draw' } });
  assert.deepEqual([out.route.taskClass, out.route.taskClassLabel], ['image_gen', 'Image creation']);
  const unrouted = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { provider: 'claude-code', model: 'opus', task: 'draw', taskClass: 'image_gen' } });
  assert.deepEqual([unrouted.action, unrouted.spec.provider, unrouted.spec.model], ['start', 'codex', 'gpt-5.6-luna'], 'an un-routed incapable dispatch is corrected');
});

test('escalationFor: an image_gen run escalates only onto a model that makes images, never to Claude', () => {
  const run = (model, provider = 'codex') => ({ provider, model, state: 'failed', completionReason: 'provider_error', route: { taskClass: 'image_gen' } });
  assert.equal(escalationFor({ run: run('gpt-5.6-luna'), catalog: CATALOG, routing: ROUTING }).to.model, 'gpt-6-astra');
  assert.equal(escalationFor({ run: run('gpt-6-astra'), catalog: CATALOG, routing: ROUTING }), null, 'the strongest maker: no Claude or saved-complex fallback');
  const withComplex = { ...ROUTING, preferences: { complex: { kind: 'dispatch', provider: 'claude-code', model: 'opus' } } };
  assert.equal(escalationFor({ run: run('gpt-6-astra'), catalog: CATALOG, routing: withComplex }), null);
  assert.equal(escalationFor({ run: run('media-lab/pixel-flash', 'opencode'), catalog: MEDIA, routing: ROUTING }).to.model, 'studio/pixel-pro', 'the next maker up, not the text-only model');
  const ladder = { ...ROUTING, ladders: { opencode: ['media-lab/pixel-flash', 'media-lab/text-only', 'studio/pixel-pro'] } };
  assert.equal(escalationFor({ run: run('media-lab/pixel-flash', 'opencode'), catalog: MEDIA, routing: ladder }).to.model, 'studio/pixel-pro', 'the ladder skips a rung that cannot make images');
  // A code run keeps the old ladder (Claude stand-in).
  assert.equal(escalationFor({ run: { ...run('gpt-6-astra'), route: { taskClass: 'code' } }, catalog: CATALOG, routing: ROUTING }).to.provider, 'claude-code');
});

// ── Review fixes (2026-09-28, Codex review run 35d06cf3) ────────────────────

test('review #5 (routing): with no OpenCode provider connected, a disconnected video maker does not count — video_gen is declined', () => {
  const disconnected = { models: { ...CATALOG.models, opencode: parseOpenCodeProviders({ ok: true, data: { all: OPENCODE_MEDIA.data.all, default: {}, connected: [] } }) } };
  const ev = evaluateRoute({ mode: 'never', routing: ROUTING, request: media({ task_class: 'video_gen', confidence: 0.9 }), brain: CLAUDE_BRAIN, catalog: disconnected });
  assert.deepEqual([ev.unavailable, ev.auto], ['no_capable_model', null]);
});

test('review #6: image_gen with needs_vision weighs both requirements; the output fallback never undoes sight', () => {
  // The cheapest image maker overall cannot see; media-lab/pixel-flash ($2.50) makes images and sees.
  const blindMaker = parseOpenCodeProviders({ ok: true, data: { all: [{ id: 'blindlab', models: { 'draw-1': { id: 'draw-1', name: 'Draw 1', capabilities: { toolcall: true, input: { text: true, image: false }, output: { text: true, image: true, video: false } }, cost: { input: 0.1, output: 0.5 } } } }], connected: ['blindlab'] } });
  const catalog = { models: { ...MEDIA.models, opencode: [...MEDIA.models.opencode, ...blindMaker] } };
  const opus = [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }];
  const seeing = evaluateRoute({ mode: 'never', routing: ROUTING, request: media({ task_class: 'image_gen', needs_vision: true, confidence: 0.9, proposals: opus }), brain: CLAUDE_BRAIN, catalog });
  assert.equal(seeing.auto.model, 'media-lab/pixel-flash', 'the reproduction picked blindlab/draw-1');
  assert.match(seeing.corrections.find((c) => c.reason === 'needs_output').text, /makes images and can see: claude-code\/opus → opencode\/media-lab\/pixel-flash/);
  const plain = evaluateRoute({ mode: 'never', routing: ROUTING, request: media({ task_class: 'image_gen', confidence: 0.9, proposals: opus }), brain: CLAUDE_BRAIN, catalog });
  assert.equal(plain.auto.model, 'blindlab/draw-1', 'without a reference image the cheapest maker still wins');
  // A maker that cannot see is swapped for one that can.
  const blindPick = evaluateRoute({ mode: 'never', routing: ROUTING, request: media({ task_class: 'image_gen', needs_vision: true, confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'opencode', model: 'blindlab/draw-1' }] }), brain: CLAUDE_BRAIN, catalog });
  assert.equal(blindPick.auto.model, 'media-lab/pixel-flash');
  assert.equal(blindPick.corrections.find((c) => c.field === 'model').reason, 'needs_vision');
  // A saved route that cannot see yields to a maker that can when the task needs sight.
  const saved = { ...ROUTING, preferences: { image_gen: { kind: 'dispatch', provider: 'opencode', model: 'blindlab/draw-1' } } };
  assert.equal(evaluateRoute({ mode: 'never', routing: saved, request: media({ task_class: 'image_gen', needs_vision: true, confidence: 0.9, proposals: opus }), brain: CLAUDE_BRAIN, catalog }).auto.model, 'media-lab/pixel-flash');
  // The card: the blind suggestion is disabled and the stand-in can see.
  const req = media({ task_class: 'image_gen', needs_vision: true, confidence: 0.4, proposals: [{ kind: 'dispatch', provider: 'opencode', model: 'blindlab/draw-1' }] });
  const { options } = buildRouteOptions({ request: req, evaluation: evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: req, brain: CLAUDE_BRAIN, catalog }), brain: CLAUDE_BRAIN, catalog, routing: ROUTING });
  assert.equal(options.find((o) => o.id === 's1').disabled, true);
  assert.equal(options.find((o) => o.id === 'g1')?.model, 'media-lab/pixel-flash');
  // Only blind makers exist: the output requirement still wins (the task cannot run otherwise).
  const onlyBlind = { models: { 'claude-code': CATALOG.models['claude-code'], codex: [], opencode: blindMaker } };
  assert.equal(evaluateRoute({ mode: 'never', routing: ROUTING, request: media({ task_class: 'image_gen', needs_vision: true, confidence: 0.9, proposals: opus }), brain: CLAUDE_BRAIN, catalog: onlyBlind }).auto.model, 'blindlab/draw-1');
});

test('re-review #2 (routing): with nothing connected on OpenCode, a code route never lands there', async () => {
  const empty = await createAssistantCatalog({ fetchJson: fakeFetch({ '/api/opencode/providers/full': { ok: true, data: { all: OPENCODE_MEDIA.data.all, default: {}, connected: [] } } }), claudePricing: PRICING }).full();
  const proposals = [{ kind: 'dispatch', provider: 'opencode', model: 'media-lab/text-only' }];
  const never = evaluateRoute({ mode: 'never', routing: ROUTING, request: media({ task_class: 'code', confidence: 0.9, proposals }), brain: CLAUDE_BRAIN, catalog: empty });
  assert.ok(never.reasons.includes('model_disabled'), 'unusable like a hidden model');
  assert.equal(never.auto.provider, 'claude-code', 'the reproduction dispatched to the disconnected provider');
  const unsure = evaluateRoute({ mode: 'ask-unsure', routing: ROUTING, request: media({ task_class: 'code', confidence: 0.9, proposals }), brain: CLAUDE_BRAIN, catalog: empty });
  assert.equal(unsure.ask, true);
  const noModel = evaluateRoute({ mode: 'never', routing: ROUTING, request: media({ task_class: 'code', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'opencode' }] }), brain: CLAUDE_BRAIN, catalog: empty });
  assert.equal(noModel.auto.provider, 'claude-code');
});

test('final #1: a saved route naming a model on a provider with nothing connected is skipped like a hidden one; OpenCode down stays lenient', async () => {
  const empty = await createAssistantCatalog({ fetchJson: fakeFetch({ '/api/opencode/providers/full': { ok: true, data: { all: OPENCODE_MEDIA.data.all, default: {}, connected: [] } } }), claudePricing: PRICING }).full();
  const saved = SAVED({ code: { kind: 'dispatch', provider: 'opencode', model: 'media-lab/text-only' } });
  const pick = [{ kind: 'dispatch', provider: 'claude-code', model: 'sonnet' }];
  const skipped = evaluateRoute({ mode: 'never', routing: saved, request: media({ task_class: 'code', confidence: 0.9, proposals: pick }), brain: CLAUDE_BRAIN, catalog: empty });
  assert.deepEqual([skipped.bound, skipped.auto.provider, skipped.auto.model], [false, 'claude-code', 'sonnet'], 'the brain\'s pick stands');
  assert.ok(skipped.corrections.some((c) => c.reason === 'remembered_disabled'));
  const req = media({ task_class: 'code', confidence: 0.4, proposals: [{ kind: 'dispatch', provider: 'opencode', model: 'media-lab/text-only' }] });
  const { options } = buildRouteOptions({ request: req, evaluation: evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: req, brain: CLAUDE_BRAIN, catalog: empty }), brain: CLAUDE_BRAIN, catalog: empty, routing: ROUTING });
  const s1 = options.find((o) => o.id === 's1');
  assert.deepEqual([s1.disabled, s1.disabledReason], [true, 'No model of this provider is connected.']);
  const down = await createAssistantCatalog({ fetchJson: fakeFetch({ '/api/opencode/providers/full': { ok: false, error: 'OpenCode server not running', data: {} } }), claudePricing: PRICING }).full();
  const lenient = evaluateRoute({ mode: 'never', routing: saved, request: media({ task_class: 'code', confidence: 0.9, proposals: pick }), brain: CLAUDE_BRAIN, catalog: down });
  assert.deepEqual([lenient.bound, lenient.auto.provider, lenient.auto.model], [true, 'opencode', 'media-lab/text-only'], 'an unavailable catalog keeps binding');
});

test('a WhatsApp (remote) session: one decided route authorizes exactly one dispatch; the desktop keeps fan-out under one card', async (t) => {
  const { router, sink, sessions } = harness(t, { mode: 'always-ask' });
  sessions.get('assistant-1').remote = true;
  const result = await router.propose({ sessionId: 'assistant-1', body: { task_class: 'code', confidence: 0.9, summary: 'fix the login test', proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'sonnet' }] }, waitMs: 0 });
  await router.answer(result.routeId, { optionId: 's1' });
  const first = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { routeId: result.routeId, task: 'fix the login test' } });
  assert.equal(first.action, 'start', 'the approved task runs');
  const reused = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { routeId: result.routeId, task: 'delete the staging database' } });
  assert.equal(reused.action, 'hold', 'the same route id again: a new card');
  assert.notEqual(reused.routeId, result.routeId);
  assert.equal(sink.cards.length, 2);
  // Held runs started by a decision use it up too.
  const held = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { provider: 'claude-code', task: 'a', workflowId: 'wf' } });
  router.holdRuns(held.routeId, ['run-a']);
  const joined = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { provider: 'claude-code', task: 'b', workflowId: 'wf' } });
  assert.notEqual(joined.routeId, held.routeId, 'no fan-out under one phone card');
  const pendingAgain = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { routeId: held.routeId, task: 'c' } });
  assert.notEqual(pendingAgain.routeId, held.routeId, 'a card that already holds a run takes no second one');
  await router.answer(held.routeId, { optionId: 'here' });
  assert.deepEqual(sink.started.map(([runId]) => runId), ['run-a']);
  assert.equal((await router.resolveDispatch({ sessionId: 'assistant-1', spec: { routeId: held.routeId, task: 'd' } })).action, 'hold', 'consumed by its held run');

  // The desktop: a decided route stays reusable until it expires.
  sessions.get('assistant-1').remote = false;
  const desk = await router.propose({ sessionId: 'assistant-1', body: { task_class: 'code', confidence: 0.9, summary: 'x', proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'sonnet' }] }, waitMs: 0 });
  await router.answer(desk.routeId, { optionId: 's1' });
  for (const task of ['one', 'two']) assert.equal((await router.resolveDispatch({ sessionId: 'assistant-1', spec: { routeId: desk.routeId, task } })).action, 'start', task);
});

// ── Design (dispatch only, a model that can see) ────────────────────────────
// CATALOG: every Claude and Codex row can see; on OpenCode ollama-cloud/deepseek-v4.1-flash ($0.60) and
// legacy/vis-1 ($1) can, deepseek-v4-pro, deepseek-v4-flash and zai-coding-plan/glm-5.2 cannot.
const design = (body, brain = CLAUDE_BRAIN) => normalizeRouteRequest({ task_class: 'design', ...body }, { brain });
const BLIND_PRO = [{ kind: 'dispatch', provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' }];
const OPENCODE_BRAIN = { provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro', effort: null };
/** Nothing can see: Claude and Codex disconnected, only OpenCode's blind rows. */
const NO_SIGHT = { models: { 'claude-code': [], codex: [], opencode: CATALOG.models.opencode.filter((row) => row.vision !== true) } };

test('design: listed after Automation; always a worker on a model that can see; it collects images and has a playbook', () => {
  assert.equal(TASK_CLASSES.indexOf('design'), TASK_CLASSES.indexOf('automation') + 1);
  assert.equal(TASK_CLASSES.indexOf('image_gen'), TASK_CLASSES.indexOf('design') + 1);
  assert.deepEqual([requiresVision('design'), requiresVision('computer'), requiresVision('code')], [true, false, false], 'computer keeps its softer check');
  assert.deepEqual([collectedMedia('design'), collectedMedia('image_gen'), collectedMedia('video_gen'), collectedMedia('code')], ['image', 'image', 'video', null]);
  assert.deepEqual([classPlaybook('design'), classPlaybook('image_gen'), classPlaybook('code')], ['design', null, null]);
  const req = design({ confidence: 0.9, summary: 'Redesign settings', proposals: [{ kind: 'direct' }, { kind: 'direct', model: 'opus' }] });
  assert.deepEqual([req.taskClassLabel, req.needsVision, req.visionOnly, req.dispatchOnly, req.coercedDirect, req.needsOutput], ['Design', true, true, true, true, null]);
  assert.deepEqual(req.proposals.map((p) => [p.kind, p.provider, p.model]), [['dispatch', 'claude-code', 'sonnet'], ['dispatch', 'claude-code', 'opus']]);
  const none = design({ proposals: [] });
  assert.deepEqual([none.proposals[0].kind, none.proposals[0].model, none.coercedDirect], ['dispatch', null, false], 'the class default is a dispatch');
  const computer = normalizeRouteRequest({ task_class: 'computer', proposals: [{ kind: 'direct' }] }, { brain: CLAUDE_BRAIN });
  assert.deepEqual([computer.needsVision, computer.visionOnly, computer.dispatchOnly], [true, undefined, undefined], 'computer keeps its shape');
});

test('design: a direct pick runs as a dispatch in every mode (never a continuation), and the correction says so', async (t) => {
  for (const mode of ['never', 'ask-unsure']) {
    const ev = evaluateRoute({ mode, routing: ROUTING, request: design({ confidence: 0.95, proposals: [{ kind: 'direct' }] }), brain: CLAUDE_BRAIN, catalog: CATALOG });
    assert.equal(ev.ask, false, mode);
    assert.deepEqual([ev.auto.kind, ev.auto.provider, ev.auto.model], ['dispatch', 'claude-code', 'sonnet'], mode);
    assert.equal(ev.corrections.find((c) => c.reason === 'dispatch_only')?.text, 'Design always runs on a worker, not here');
  }
  const { router, sink } = harness(t, { mode: 'never', brain: CLAUDE_BRAIN });
  const result = await router.propose({ sessionId: 'assistant-1', body: { task_class: 'design', confidence: 0.9, summary: 'Redesign settings', proposals: [{ kind: 'direct', model: 'opus' }] } });
  assert.deepEqual([result.status, result.target.kind, result.target.model, result.continuation], ['approved', 'dispatch', 'opus', false]);
  assert.equal(sink.continues.length, 0, 'never a continuation');
  const out = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { routeId: result.routeId, task: 'redesign' } });
  assert.deepEqual([out.route.taskClass, out.route.taskClassLabel, out.spec.model], ['design', 'Design', 'opus']);
});

test('design (never): a pick that cannot see is corrected — the cheapest seeing model on its provider, else anywhere', () => {
  const same = evaluateRoute({ mode: 'never', routing: ROUTING, request: design({ confidence: 0.9, proposals: BLIND_PRO }), brain: CLAUDE_BRAIN, catalog: CATALOG });
  assert.deepEqual([same.auto.kind, same.auto.provider, same.auto.model, same.source], ['dispatch', 'opencode', 'ollama-cloud/deepseek-v4.1-flash', 'corrected']);
  assert.equal(same.corrections.find((c) => c.reason === 'needs_vision').text, 'Design needs a model that can see: opencode/ollama-cloud/deepseek-v4-pro → opencode/ollama-cloud/deepseek-v4.1-flash');
  // No OpenCode model can see: the cheapest seeing model anywhere (Claude Haiku, $5 out).
  const blindOpenCode = { models: { ...CATALOG.models, codex: [], opencode: NO_SIGHT.models.opencode } };
  const anywhere = evaluateRoute({ mode: 'never', routing: ROUTING, request: design({ confidence: 0.9, proposals: BLIND_PRO }), brain: CLAUDE_BRAIN, catalog: blindOpenCode });
  assert.deepEqual([anywhere.auto.provider, anywhere.auto.model], ['claude-code', 'haiku']);
  // A brain that cannot see: its "here" pick becomes a dispatch onto a model that can.
  const here = evaluateRoute({ mode: 'never', routing: ROUTING, request: design({ confidence: 0.9, proposals: [{ kind: 'direct' }] }, OPENCODE_BRAIN), brain: OPENCODE_BRAIN, catalog: CATALOG });
  assert.deepEqual([here.auto.kind, here.auto.provider, here.auto.model], ['dispatch', 'opencode', 'ollama-cloud/deepseek-v4.1-flash']);
  // A pick that can see is kept.
  const sees = evaluateRoute({ mode: 'never', routing: ROUTING, request: design({ confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-6-astra' }] }), brain: CLAUDE_BRAIN, catalog: CATALOG });
  assert.deepEqual([sees.auto.provider, sees.auto.model, sees.source], ['codex', 'gpt-6-astra', 'brain']);
});

test('design (never): a saved route that cannot see is skipped (remembered_incapable); one that can binds', () => {
  const blindSaved = SAVED({ design: { kind: 'dispatch', provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' } });
  const skipped = evaluateRoute({ mode: 'never', routing: blindSaved, request: design({ confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }] }), brain: CLAUDE_BRAIN, catalog: CATALOG });
  assert.deepEqual([skipped.auto.provider, skipped.auto.model, skipped.bound, skipped.source], ['claude-code', 'opus', false, 'brain']);
  assert.equal(skipped.corrections.find((c) => c.reason === 'remembered_incapable').text, 'saved Design route opencode/ollama-cloud/deepseek-v4-pro cannot see images; not applied');
  // The skipped route never fills an omitted model either (and OpenCode has no default row: its sight is unknown).
  const omitted = evaluateRoute({ mode: 'ask-unsure', routing: blindSaved, request: design({ confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'opencode' }] }), brain: CLAUDE_BRAIN, catalog: CATALOG });
  assert.deepEqual([omitted.ask, omitted.reasons], [true, ['model_missing', 'needs_vision']]);
  const seeing = evaluateRoute({ mode: 'never', routing: SAVED({ design: { kind: 'direct', provider: 'claude-code', model: 'opus', effort: 'high' } }), request: design({ confidence: 0.9, proposals: BLIND_PRO }), brain: CLAUDE_BRAIN, catalog: CATALOG });
  assert.deepEqual([seeing.auto.kind, seeing.auto.provider, seeing.auto.model, seeing.auto.effort, seeing.bound], ['dispatch', 'claude-code', 'opus', 'high', true], 'a saved "here" is a worker on that model');
});

test('design (ask-unsure): a pick that cannot see asks; a confident seeing pick does not; always-ask asks', () => {
  const blind = evaluateRoute({ mode: 'ask-unsure', routing: ROUTING, request: design({ confidence: 0.95, proposals: BLIND_PRO }), brain: CLAUDE_BRAIN, catalog: CATALOG });
  assert.deepEqual([blind.ask, blind.reasons], [true, ['needs_vision']]);
  const sure = evaluateRoute({ mode: 'ask-unsure', routing: ROUTING, request: design({ confidence: 0.95, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }] }), brain: CLAUDE_BRAIN, catalog: CATALOG });
  assert.deepEqual([sure.ask, sure.auto.model], [false, 'opus']);
  assert.equal(evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: design({ confidence: 0.95, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }] }), brain: CLAUDE_BRAIN, catalog: CATALOG }).ask, true);
});

test('design card: no "here", models that cannot see disabled, neighbours and the stand-in can see', () => {
  const req = design({ confidence: 0.4, proposals: BLIND_PRO });
  const evaluation = evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: req, brain: CLAUDE_BRAIN, catalog: CATALOG });
  const { options, defaultOptionId } = buildRouteOptions({ request: req, evaluation, brain: CLAUDE_BRAIN, catalog: CATALOG, routing: ROUTING });
  assert.ok(!options.some((o) => o.id === 'here' || o.kind === 'direct'), 'always a worker');
  const s1 = options.find((o) => o.id === 's1');
  assert.deepEqual([s1.disabled, s1.disabledReason], [true, CANNOT_SEE_TEXT]);
  assert.equal(CANNOT_SEE_TEXT, "This model can't see images.");
  const g1 = options.find((o) => o.id === 'g1');
  assert.deepEqual([g1.badge, g1.provider, g1.model, g1.disabled], ['capable', 'opencode', 'ollama-cloud/deepseek-v4.1-flash', false]);
  assert.equal(defaultOptionId, 'g1');
  for (const o of options.filter((x) => !x.disabled)) assert.notEqual(o.vision, false, o.id);
  // A seeing pick: no stand-in, nothing disabled.
  const opus = design({ confidence: 0.4, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }] });
  const opusCard = buildRouteOptions({ request: opus, evaluation: evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: opus, brain: CLAUDE_BRAIN, catalog: CATALOG }), brain: CLAUDE_BRAIN, catalog: CATALOG, routing: ROUTING });
  assert.ok(!opusCard.options.some((o) => o.badge === 'capable'));
  for (const o of opusCard.options) assert.equal(o.disabled, false, o.id);
  // A seeing saved route is the stand-in, listed once as "remembered".
  const saved = { ...ROUTING, preferences: { design: { kind: 'dispatch', provider: 'codex', model: 'gpt-6-astra' } } };
  const withPref = buildRouteOptions({ request: req, evaluation: evaluateRoute({ mode: 'always-ask', routing: saved, request: req, brain: CLAUDE_BRAIN, catalog: CATALOG }), brain: CLAUDE_BRAIN, catalog: CATALOG, routing: saved });
  assert.deepEqual(withPref.options.filter((o) => o.badge === 'remembered' || o.badge === 'capable').map((o) => [o.id, o.badge, o.model]), [['r1', 'remembered', 'gpt-6-astra']]);
});

test('design cards: the packet says always a worker and only seeing models; answers become dispatches, a blind "other" pick is refused', async (t) => {
  const { router, sink } = harness(t, { mode: 'always-ask', brain: CLAUDE_BRAIN });
  await router.propose({ sessionId: 'assistant-1', body: { task_class: 'design', confidence: 0.9, summary: 'Redesign settings', proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }] }, waitMs: 0 });
  const packet = sink.cards.at(-1).request;
  assert.deepEqual([packet.taskClass, packet.taskClassLabel, packet.needsVision, packet.visionOnly, packet.dispatchOnly, packet.requires], ['design', 'Design', true, true, true, null]);
  assert.ok(!packet.options.some((o) => o.id === 'here'));
  const card = { needsVision: true, visionOnly: true, dispatchOnly: true, options: [{ id: 's1', kind: 'dispatch', provider: 'claude-code', model: 'opus', effort: null }] };
  assert.deepEqual(targetFromAnswer({ card, response: { optionId: 's1' }, catalog: CATALOG, brain: CLAUDE_BRAIN }).target, { kind: 'dispatch', provider: 'claude-code', model: 'opus', effort: null });
  const here = targetFromAnswer({ card, response: { optionId: 'other', target: { kind: 'direct', provider: 'claude-code', model: 'sonnet' } }, catalog: CATALOG, brain: CLAUDE_BRAIN });
  assert.equal(here.target.kind, 'dispatch', 'a "here" pick on the brain\'s provider still runs on a worker');
  assert.throws(() => targetFromAnswer({ card, response: { optionId: 'other', target: { provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' } }, catalog: CATALOG, brain: CLAUDE_BRAIN }), (e) => e.code === 'ROUTE_INVALID' && e.message === CANNOT_SEE_TEXT);
  // Computer use keeps its wording.
  assert.throws(() => targetFromAnswer({ card: { needsVision: true, options: [] }, response: { optionId: 'other', target: { provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' } }, catalog: CATALOG, brain: CLAUDE_BRAIN }), (e) => e.message === 'This model cannot see images, and this task needs to.');
});

test('design with no model that can see: declined at once in every mode (no card), a next that names the row, un-routed dispatches refused', async (t) => {
  for (const mode of ['always-ask', 'ask-unsure', 'never']) {
    const ev = evaluateRoute({ mode, routing: ROUTING, request: design({ confidence: 0.9, proposals: BLIND_PRO }), brain: CLAUDE_BRAIN, catalog: NO_SIGHT });
    assert.deepEqual([ev.ask, ev.unavailable, ev.auto], [false, 'no_capable_model', null], mode);
  }
  // A hidden seeing model does not count.
  const hidden = { models: { 'claude-code': [], codex: [], opencode: CATALOG.models.opencode }, hidden: { opencode: ['ollama-cloud/deepseek-v4.1-flash', 'legacy/vis-1'] } };
  assert.equal(evaluateRoute({ mode: 'never', routing: ROUTING, request: design({ confidence: 0.9, proposals: BLIND_PRO }), brain: CLAUDE_BRAIN, catalog: hidden }).unavailable, 'no_capable_model');
  const catalog = { full: async () => NO_SIGHT, peek: () => NO_SIGHT, brainInfo: () => null };
  const sink = { events: [], cards: [] };
  const router = createAssistantRouter({
    catalog, configStore: { routing: () => effectiveRouting({}) }, getSession: () => ({ brain: CLAUDE_BRAIN, routingMode: 'ask-unsure' }),
    sinks: { routeEvent: (sid, phase, route) => sink.events.push([phase, route]), sendCard: (sid, packet) => sink.cards.push(packet) },
  });
  t.after(() => router.shutdown());
  const result = await router.propose({ sessionId: 'assistant-1', body: { task_class: 'design', confidence: 0.9, summary: 'Redesign settings', proposals: BLIND_PRO }, waitMs: 0 });
  assert.deepEqual([result.status, result.reason, result.requires, result.needs, result.target], ['declined', 'no_capable_model', null, 'vision', null]);
  assert.match(result.next, /No model in the user's catalog can see images/);
  assert.match(result.next, /Design row in Model routes has no model that can see yet/);
  assert.equal(sink.cards.length, 0, 'no card');
  const [phase, route] = sink.events.at(-1);
  assert.deepEqual([phase, route.reasonCode, route.needs, route.taskClassLabel, route.reason], ['declined', 'no_capable_model', 'vision', 'Design', 'No model in your catalog can see images yet.']);
  await assert.rejects(router.resolveDispatch({ sessionId: 'assistant-1', spec: { provider: 'claude-code', task: 'redesign', taskClass: 'design' } }), (e) => e.code === 'NO_CAPABLE_MODEL' && e.status === 409 && e.needs === 'vision' && e.requires === null);
  assert.match(gateStateFor({ ok: true, status: 'declined', reason: 'no_capable_model', needs: 'vision' }).text, /No model in the catalog can see images/);
  assert.match(gateStateFor({ ok: true, status: 'declined', reason: 'no_capable_model', requires: 'video' }).text, /can make what this task creates/, 'image / video creation keeps its text');
});

test('escalationFor: a design run escalates only onto a model that can see', () => {
  const run = (model, provider = 'opencode', taskClass = 'design') => ({ provider, model, state: 'failed', completionReason: 'provider_error', route: { taskClass } });
  // From deepseek-v4.1-flash (small) the next tier up is glm-5.2, which cannot see: legacy/vis-1 (same tier, pricier) instead.
  assert.equal(escalationFor({ run: run('ollama-cloud/deepseek-v4.1-flash'), catalog: CATALOG, routing: ROUTING }).to.model, 'legacy/vis-1');
  assert.equal(escalationFor({ run: run('ollama-cloud/deepseek-v4.1-flash', 'opencode', 'code'), catalog: CATALOG, routing: ROUTING }).to.model, 'zai-coding-plan/glm-5.2', 'a code run keeps the old ladder');
  const ladder = { ...ROUTING, ladders: { opencode: ['ollama-cloud/deepseek-v4.1-flash', 'zai-coding-plan/glm-5.2', 'legacy/vis-1'] } };
  assert.equal(escalationFor({ run: run('ollama-cloud/deepseek-v4.1-flash'), catalog: CATALOG, routing: ladder }).to.model, 'legacy/vis-1', 'the ladder skips a rung that cannot see');
  // A saved complex route that cannot see is not the fallback; the strongest Claude model (it can see) is.
  const blindComplex = { ...ROUTING, preferences: { complex: { kind: 'dispatch', provider: 'opencode', model: 'ollama-cloud/deepseek-v4-flash' } } };
  const top = escalationFor({ run: run('legacy/vis-1'), catalog: CATALOG, routing: blindComplex });
  assert.deepEqual([top.to.provider, top.to.vision], ['claude-code', true]);
  // A code run at the top of its provider still takes the saved complex route.
  assert.equal(escalationFor({ run: run('ollama-cloud/deepseek-v4-pro', 'opencode', 'code'), catalog: CATALOG, routing: blindComplex }).to.model, 'ollama-cloud/deepseek-v4-flash');
});

test('runContract: design, image and video creation cannot share a route with each other or with plain classes (both directions)', () => {
  assert.equal(runContract('design'), 'design');
  assert.equal(runContract('image_gen'), 'image');
  for (const plain of ['code', 'complex', 'review', 'browser', 'computer']) {
    assert.equal(runContract(plain), null, plain);
    assert.notEqual(runContract(plain), runContract('design'), `${plain} → design`);
  }
  assert.notEqual(runContract('design'), runContract('image_gen'));
  assert.notEqual(runContract('design'), runContract('video_gen'));
});

// ── Design review fixes (2026-09-28, Codex review run 873da571) ──────────────
// mystery/eye-1 ($0.20, small) and mystery/eye-pro ($40, large) declare no input capabilities: their sight is unknown (null).
const UNKNOWN_SIGHT_ROWS = parseOpenCodeProviders({ ok: true, data: { all: [{ id: 'mystery', models: {
  'eye-1': { id: 'eye-1', name: 'Eye 1', capabilities: { toolcall: true }, cost: { input: 0.05, output: 0.2 } },
  'eye-pro': { id: 'eye-pro', name: 'Eye Pro', capabilities: { toolcall: true }, cost: { input: 5, output: 40 } },
} }], connected: ['mystery'] } });
const UNKNOWN = { models: { ...CATALOG.models, opencode: [...CATALOG.models.opencode, ...UNKNOWN_SIGHT_ROWS] } };
const EYE = [{ kind: 'dispatch', provider: 'opencode', model: 'mystery/eye-1' }];

test('design review #1 (automatic): a model whose sight is unknown never runs design while one that can see exists; computer keeps it', () => {
  assert.equal(describeTarget(EYE[0], { catalog: UNKNOWN }).vision, null, 'the fixture\'s sight is unknown');
  const never = evaluateRoute({ mode: 'never', routing: ROUTING, request: design({ confidence: 0.9, proposals: EYE }), brain: CLAUDE_BRAIN, catalog: UNKNOWN });
  assert.deepEqual([never.auto.provider, never.auto.model, never.source], ['opencode', 'ollama-cloud/deepseek-v4.1-flash', 'corrected'], 'the reproduction approved mystery/eye-1');
  assert.equal(never.corrections.find((c) => c.reason === 'needs_vision').text, 'Design needs a model that can see: opencode/mystery/eye-1 → opencode/ollama-cloud/deepseek-v4.1-flash');
  const unsure = evaluateRoute({ mode: 'ask-unsure', routing: ROUTING, request: design({ confidence: 0.95, proposals: EYE }), brain: CLAUDE_BRAIN, catalog: UNKNOWN });
  assert.deepEqual([unsure.ask, unsure.reasons], [true, ['needs_vision']]);
  // Computer use only refuses a confirmed false: the unknown pick stands.
  const computer = evaluateRoute({ mode: 'never', routing: ROUTING, request: normalizeRouteRequest({ task_class: 'computer', confidence: 0.9, proposals: EYE }, { brain: CLAUDE_BRAIN }), brain: CLAUDE_BRAIN, catalog: UNKNOWN });
  assert.equal(computer.auto.model, 'mystery/eye-1');
});

test('design review #1 (saved): a saved route whose sight is unknown is skipped and says so; the brain\'s seeing pick stands', () => {
  const saved = SAVED({ design: { kind: 'dispatch', provider: 'opencode', model: 'mystery/eye-1' } });
  const ev = evaluateRoute({ mode: 'never', routing: saved, request: design({ confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }] }), brain: CLAUDE_BRAIN, catalog: UNKNOWN });
  assert.deepEqual([ev.bound, ev.auto.provider, ev.auto.model], [false, 'claude-code', 'opus'], 'the reproduction bound mystery/eye-1');
  assert.equal(ev.corrections.find((c) => c.reason === 'remembered_incapable').text, 'saved Design route opencode/mystery/eye-1 is not known to see images; not applied');
  // The stand-in never picks it either.
  const blindPick = evaluateRoute({ mode: 'never', routing: saved, request: design({ confidence: 0.9, proposals: BLIND_PRO }), brain: CLAUDE_BRAIN, catalog: UNKNOWN });
  assert.equal(blindPick.auto.model, 'ollama-cloud/deepseek-v4.1-flash');
});

test('design review #1 (cards and answers): an unknown-sight option is disabled, neighbours and the stand-in can see, an unknown "other" pick is refused', () => {
  const req = design({ confidence: 0.4, proposals: EYE });
  const { options, defaultOptionId } = buildRouteOptions({ request: req, evaluation: evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: req, brain: CLAUDE_BRAIN, catalog: UNKNOWN }), brain: CLAUDE_BRAIN, catalog: UNKNOWN, routing: ROUTING });
  const s1 = options.find((o) => o.id === 's1');
  assert.deepEqual([s1.disabled, s1.disabledReason], [true, UNKNOWN_SIGHT_TEXT]);
  assert.equal(UNKNOWN_SIGHT_TEXT, "This model isn't known to see images.");
  for (const o of options.filter((x) => !x.disabled)) assert.equal(o.vision, true, o.id);
  assert.ok(!options.find((o) => o.id === defaultOptionId).disabled);
  // From legacy/vis-1 the next tier up with unknown sight (mystery/eye-pro) is not "stronger": the strongest Claude model is.
  const vis = design({ confidence: 0.4, proposals: [{ kind: 'dispatch', provider: 'opencode', model: 'legacy/vis-1' }] });
  const visCard = buildRouteOptions({ request: vis, evaluation: evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: vis, brain: CLAUDE_BRAIN, catalog: UNKNOWN }), brain: CLAUDE_BRAIN, catalog: UNKNOWN, routing: ROUTING });
  assert.deepEqual(visCard.options.filter((o) => o.badge === 'stronger').map((o) => [o.provider, o.vision]), [['claude-code', true]]);
  assert.ok(!visCard.options.some((o) => o.model === 'mystery/eye-pro'));
  const card = { needsVision: true, visionOnly: true, dispatchOnly: true, options: [] };
  assert.throws(() => targetFromAnswer({ card, response: { optionId: 'other', target: { provider: 'opencode', model: 'mystery/eye-1' } }, catalog: UNKNOWN, brain: CLAUDE_BRAIN }), (e) => e.code === 'ROUTE_INVALID' && e.message === UNKNOWN_SIGHT_TEXT);
  assert.equal(targetFromAnswer({ card, response: { optionId: 'other', target: { provider: 'opencode', model: 'legacy/vis-1' } }, catalog: UNKNOWN, brain: CLAUDE_BRAIN }).target.model, 'legacy/vis-1');
});

test('design review #1 (escalation): never onto a model whose sight is unknown (ladder or next tier)', () => {
  const run = (model, taskClass = 'design') => ({ provider: 'opencode', model, state: 'failed', completionReason: 'provider_error', route: { taskClass } });
  const up = escalationFor({ run: run('legacy/vis-1'), catalog: UNKNOWN, routing: ROUTING });
  assert.deepEqual([up.to.provider, up.to.vision], ['claude-code', true], 'the reproduction escalated onto mystery/eye-pro');
  const ladder = { ...ROUTING, ladders: { opencode: ['legacy/vis-1', 'mystery/eye-pro', 'ollama-cloud/deepseek-v4.1-flash'] } };
  assert.equal(escalationFor({ run: run('legacy/vis-1'), catalog: UNKNOWN, routing: ladder }).to.model, 'ollama-cloud/deepseek-v4.1-flash', 'the ladder skips the unknown rung');
  assert.equal(escalationFor({ run: run('legacy/vis-1', 'code'), catalog: UNKNOWN, routing: ROUTING }).to.model, 'zai-coding-plan/glm-5.2', 'a code run keeps the old ladder (the next tier up)');
});

test('design review #1 (catalog unavailable): design follows image creation\'s rule — an unavailable provider\'s models are unknown (not disabled, not qualifying); no catalog at all declines', async () => {
  const down = await createAssistantCatalog({ fetchJson: fakeFetch({ '/api/opencode/providers/full': { ok: false, error: 'OpenCode server not running', data: {} } }), claudePricing: PRICING }).full();
  // The last round's leniency still holds: a code route onto an OpenCode model keeps binding while OpenCode is down.
  const code = evaluateRoute({ mode: 'never', routing: SAVED({ code: { kind: 'dispatch', provider: 'opencode', model: 'studio/pixel-pro' } }), request: design({ task_class: 'code', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'sonnet' }] }), brain: CLAUDE_BRAIN, catalog: down });
  assert.deepEqual([code.bound, code.auto.model], [true, 'studio/pixel-pro']);
  // A capability class needs a confirmed true, which an unavailable catalog cannot give: image creation and design alike skip the saved route.
  const image = evaluateRoute({ mode: 'never', routing: SAVED({ image_gen: { kind: 'dispatch', provider: 'opencode', model: 'studio/pixel-pro' } }), request: media({ task_class: 'image_gen', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-6-astra' }] }), brain: CLAUDE_BRAIN, catalog: down });
  assert.deepEqual([image.bound, image.corrections.some((c) => c.reason === 'remembered_incapable')], [false, true]);
  const saved = evaluateRoute({ mode: 'never', routing: SAVED({ design: { kind: 'dispatch', provider: 'opencode', model: 'legacy/vis-1' } }), request: design({ confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }] }), brain: CLAUDE_BRAIN, catalog: down });
  assert.deepEqual([saved.bound, saved.auto.model], [false, 'opus']);
  assert.equal(saved.corrections.find((c) => c.reason === 'remembered_incapable').text, 'saved Design route opencode/legacy/vis-1 is not known to see images; not applied');
  assert.ok(!saved.corrections.some((c) => c.reason === 'remembered_disabled'), 'not reported as disabled');
  const pick = evaluateRoute({ mode: 'never', routing: ROUTING, request: design({ confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'opencode', model: 'legacy/vis-1' }] }), brain: CLAUDE_BRAIN, catalog: down });
  assert.deepEqual([pick.auto.provider, pick.auto.vision ?? describeTarget(pick.auto, { catalog: down }).vision], ['claude-code', true], 'corrected onto a model known to see');
  // No catalog value at all: nothing can be shown to see (or make images), so both decline.
  for (const request of [design({ confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }] }), media({ task_class: 'image_gen', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-6-astra' }] })]) {
    assert.equal(evaluateRoute({ mode: 'never', routing: ROUTING, request, brain: CLAUDE_BRAIN, catalog: { models: {} } }).unavailable, 'no_capable_model', request.taskClass);
  }
});

// ── Design re-review (Codex run 873da571, turn 2) ────────────────────────────
// claude-legacy-4 can see, but its CLI cannot run it (cliReady false → status unavailable), so the fallbacks never pick it.
const LEGACY_CATALOG = { models: { ...CATALOG.models, 'claude-code': normalizeClaudeRows([...CLAUDE_MODELS.models, { id: 'claude-legacy-4', label: 'Claude Legacy 4', cliReady: false }], { pricing: PRICING }) } };
const LEGACY = [{ kind: 'dispatch', provider: 'claude-code', model: 'claude-legacy-4' }];

test('design re-review D: a seeing row marked unavailable is never approved for design (proposed, saved, card, answer, escalation); other classes unchanged', () => {
  assert.deepEqual([designFit(LEGACY_CATALOG, LEGACY[0]), describeTarget(LEGACY[0], { catalog: LEGACY_CATALOG }).vision], ['unavailable', true]);
  const never = evaluateRoute({ mode: 'never', routing: ROUTING, request: design({ confidence: 0.9, proposals: LEGACY }), brain: CLAUDE_BRAIN, catalog: LEGACY_CATALOG });
  assert.deepEqual([never.auto.provider, never.auto.model, never.source], ['claude-code', 'haiku', 'corrected'], 'the reproduction approved claude-legacy-4');
  assert.deepEqual(never.corrections.find((c) => c.field === 'model'), { field: 'model', from: 'claude-code/claude-legacy-4', to: 'claude-code/haiku', reason: 'model_unavailable', text: 'Design needs an available model that can see: claude-code/claude-legacy-4 is unavailable → claude-code/haiku' });
  const unsure = evaluateRoute({ mode: 'ask-unsure', routing: ROUTING, request: design({ confidence: 0.95, proposals: LEGACY }), brain: CLAUDE_BRAIN, catalog: LEGACY_CATALOG });
  assert.deepEqual([unsure.ask, unsure.reasons], [true, ['model_unavailable']]);
  // Saved.
  const saved = evaluateRoute({ mode: 'never', routing: SAVED({ design: LEGACY[0] }), request: design({ confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }] }), brain: CLAUDE_BRAIN, catalog: LEGACY_CATALOG });
  assert.deepEqual([saved.bound, saved.auto.model], [false, 'opus']);
  assert.equal(saved.corrections.find((c) => c.reason === 'remembered_incapable').text, 'saved Design route claude-code/claude-legacy-4 is unavailable; not applied');
  // Card and answer.
  const req = design({ confidence: 0.4, proposals: LEGACY });
  const { options, defaultOptionId } = buildRouteOptions({ request: req, evaluation: evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: req, brain: CLAUDE_BRAIN, catalog: LEGACY_CATALOG }), brain: CLAUDE_BRAIN, catalog: LEGACY_CATALOG, routing: ROUTING });
  assert.deepEqual([options.find((o) => o.id === 's1').disabled, options.find((o) => o.id === 's1').disabledReason], [true, UNAVAILABLE_TEXT]);
  assert.equal(UNAVAILABLE_TEXT, "This model isn't available right now.");
  const enabled = options.filter((o) => !o.disabled);
  assert.ok(enabled.length > 0 && enabled.every((o) => o.vision === true && o.model !== 'claude-legacy-4'), JSON.stringify(enabled.map((o) => o.model)));
  assert.ok(enabled.some((o) => o.id === defaultOptionId));
  const card = { needsVision: true, visionOnly: true, dispatchOnly: true, options: [] };
  assert.throws(() => targetFromAnswer({ card, response: { optionId: 'other', target: LEGACY[0] }, catalog: LEGACY_CATALOG, brain: CLAUDE_BRAIN }), (e) => e.code === 'ROUTE_INVALID' && e.message === UNAVAILABLE_TEXT);
  // Escalation: the ladder skips the unavailable rung for design, not for code.
  const ladder = { ...ROUTING, ladders: { 'claude-code': ['haiku', 'claude-legacy-4', 'opus'] } };
  const run = (taskClass) => ({ provider: 'claude-code', model: 'haiku', state: 'failed', completionReason: 'provider_error', route: { taskClass } });
  assert.equal(escalationFor({ run: run('design'), catalog: LEGACY_CATALOG, routing: ladder }).to.model, 'opus', 'the reproduction escalated onto claude-legacy-4');
  assert.equal(escalationFor({ run: run('code'), catalog: LEGACY_CATALOG, routing: ladder }).to.model, 'claude-legacy-4', 'a code run keeps the old ladder');
  // Other classes do not look at availability.
  const code = evaluateRoute({ mode: 'never', routing: ROUTING, request: design({ task_class: 'code', confidence: 0.9, proposals: LEGACY }), brain: CLAUDE_BRAIN, catalog: LEGACY_CATALOG });
  assert.deepEqual([code.auto.model, code.corrections.length], ['claude-legacy-4', 0]);
});

// ── Design re-review, round 3 (Codex run 6b37e4c8) ──────────────────────────
const MADE_UP = { kind: 'dispatch', provider: 'claude-code', model: 'claude-made-up-9' };

test('design round 3 #2: a claude-* id the catalog does not list is unknown for design everywhere (proposed, saved, card, answer, escalation); an id the catalog resolves is its row; other classes still take it as seeing', () => {
  assert.equal(describeTarget(MADE_UP, { catalog: CATALOG }).vision, true, 'other classes: an unlisted Claude id still reads as seeing');
  assert.deepEqual([designFit(CATALOG, MADE_UP), designFit(CATALOG, { ...MADE_UP, model: 'claude-opus-5-5' }), designFit(CATALOG, { ...MADE_UP, model: 'claude-sonnet-5' })], ['unknown', 'ok', 'ok']);
  assert.equal(designFit(LEGACY_CATALOG, { ...MADE_UP, model: 'CLAUDE-LEGACY-4' }), 'unavailable', 'resolved in another case, then judged by its row');
  // Proposed.
  const never = evaluateRoute({ mode: 'never', routing: ROUTING, request: design({ confidence: 0.9, proposals: [MADE_UP] }), brain: CLAUDE_BRAIN, catalog: CATALOG });
  assert.equal(never.corrections.find((c) => c.field === 'model')?.reason, 'needs_vision', 'the reproduction approved claude-made-up-9');
  assert.deepEqual([never.auto.provider, designFit(CATALOG, never.auto)], ['claude-code', 'ok']);
  assert.notEqual(never.auto.model, 'claude-made-up-9');
  const unsure = evaluateRoute({ mode: 'ask-unsure', routing: ROUTING, request: design({ confidence: 0.95, proposals: [MADE_UP] }), brain: CLAUDE_BRAIN, catalog: CATALOG });
  assert.deepEqual([unsure.ask, unsure.reasons], [true, ['needs_vision']]);
  // Saved.
  const saved = evaluateRoute({ mode: 'never', routing: SAVED({ design: MADE_UP }), request: design({ confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'opus' }] }), brain: CLAUDE_BRAIN, catalog: CATALOG });
  assert.deepEqual([saved.bound, saved.auto.model], [false, 'opus']);
  assert.equal(saved.corrections.find((c) => c.reason === 'remembered_incapable').text, 'saved Design route claude-code/claude-made-up-9 is not known to see images; not applied');
  // Card and answer.
  const req = design({ confidence: 0.4, proposals: [MADE_UP] });
  const { options } = buildRouteOptions({ request: req, evaluation: evaluateRoute({ mode: 'always-ask', routing: ROUTING, request: req, brain: CLAUDE_BRAIN, catalog: CATALOG }), brain: CLAUDE_BRAIN, catalog: CATALOG, routing: ROUTING });
  assert.deepEqual([options.find((o) => o.id === 's1').disabled, options.find((o) => o.id === 's1').disabledReason, options.find((o) => o.id === 's1').vision], [true, UNKNOWN_SIGHT_TEXT, null], 'the card does not also call it "vision"');
  const card = { needsVision: true, visionOnly: true, dispatchOnly: true, options: [] };
  assert.throws(() => targetFromAnswer({ card, response: { optionId: 'other', target: MADE_UP }, catalog: CATALOG, brain: CLAUDE_BRAIN }), (e) => e.code === 'ROUTE_INVALID' && e.message === UNKNOWN_SIGHT_TEXT);
  assert.equal(targetFromAnswer({ card, response: { optionId: 'other', target: { ...MADE_UP, model: 'claude-opus-5-5' } }, catalog: CATALOG, brain: CLAUDE_BRAIN }).target.model, 'claude-opus-5-5');
  // Escalation: a saved complex route on it is not the fallback.
  const complex = { ...ROUTING, preferences: { complex: MADE_UP } };
  const top = escalationFor({ run: { provider: 'opencode', model: 'legacy/vis-1', state: 'failed', completionReason: 'provider_error', route: { taskClass: 'design' } }, catalog: CATALOG, routing: complex });
  assert.deepEqual([top.to.provider, top.to.model === 'claude-made-up-9'], ['claude-code', false]);
  // Other classes: computer use still takes it (a confirmed false is all it refuses).
  const computer = evaluateRoute({ mode: 'never', routing: ROUTING, request: design({ task_class: 'computer', confidence: 0.9, proposals: [MADE_UP] }), brain: CLAUDE_BRAIN, catalog: CATALOG });
  assert.equal(computer.auto.model, 'claude-made-up-9');
});

test('design round 3 #4: a transient failure retries a design run only on a model that can still run design; otherwise it escalates as a failure does (other classes still retry)', () => {
  const run = (model, taskClass = 'design') => ({ provider: 'claude-code', model, effort: 'high', state: 'failed', completionReason: 'provider_error', failure: { cause: 'transient' }, route: { taskClass } });
  // The Design model became unavailable after the run failed: no Retry onto it (the reproduction offered one, and launch refused it with MODEL_UNAVAILABLE).
  const moved = escalationFor({ run: run('claude-legacy-4'), catalog: LEGACY_CATALOG, routing: ROUTING });
  assert.deepEqual([moved.kind, moved.cause, moved.to.provider, moved.to.model, moved.depth], ['escalate', 'transient', 'claude-code', 'opus', 1]);
  assert.equal(designFit(LEGACY_CATALOG, moved.to), 'ok');
  // The same fallback escalation uses: the ladder's next rung that can run design.
  const ladder = { ...ROUTING, ladders: { 'claude-code': ['claude-legacy-4', 'haiku', 'opus'] } };
  assert.equal(escalationFor({ run: run('claude-legacy-4'), catalog: LEGACY_CATALOG, routing: ladder }).to.model, 'haiku');
  // A model not known to see (a claude-* id the list lacks) gets no Retry either.
  assert.equal(escalationFor({ run: run('claude-made-up-9'), catalog: CATALOG, routing: ROUTING }).kind, 'escalate');
  // Still able to run design: retried on the same model, as before; with no catalog value to tell, too (the launch checks it).
  const same = escalationFor({ run: run('opus'), catalog: LEGACY_CATALOG, routing: ROUTING });
  assert.deepEqual([same.kind, same.to.model, same.to.effort], ['retry', 'opus', 'high']);
  assert.deepEqual([escalationFor({ run: run('claude-legacy-4'), catalog: null, routing: ROUTING }).kind], ['retry'], 'no catalog value: nothing says it cannot');
  // Other classes are retried on the unavailable model as before.
  const code = escalationFor({ run: run('claude-legacy-4', 'code'), catalog: LEGACY_CATALOG, routing: ROUTING });
  assert.deepEqual([code.kind, code.to.model], ['retry', 'claude-legacy-4']);
});

test('cancel: a card closed because the user wrote something else is not approved and not a "declined"; the brain hears nothing', async (t) => {
  // Pending, the brain's turn over: no mailbox event follows a cancel (an explicit decline sends one).
  const { router, sink } = harness(t, { mode: 'always-ask' });
  const body = { task_class: 'research', confidence: 0.9, summary: 'look up', proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' }] };
  const pending = await router.propose({ sessionId: 'assistant-1', body, waitMs: 0 });
  assert.equal(pending.status, 'pending');
  const requestId = sink.cards[0].request_id;
  const SID = { sessionId: 'assistant-1' };
  assert.equal(router.cancel(requestId, 'superseded', SID), true);
  assert.equal(router.owns(requestId), false);
  assert.deepEqual(router.pendingCards('assistant-1'), []);
  assert.deepEqual(sink.cancels, [[requestId, 'superseded']], 'every host closes the card');
  assert.equal(sink.events.at(-1)[0], 'expired');
  assert.equal(sink.mailbox.length, 0, 'no route_declined / route_expired turn talks over the user');
  assert.equal(router.status(pending.routeId), null, 'nothing was decided');
  assert.equal(router.cancel(requestId, 'superseded', SID), false, 'only an open card');
  await assert.rejects(() => router.answer(requestId, { optionId: 's1' }), (e) => e.code === 'ROUTE_NOT_FOUND', 'a late pick approves nothing');
  // While agent_route still waits inside the turn: it returns "expired" (do not start the task).
  // (The card goes out, and the call starts waiting, in one synchronous step after the catalog read: no sleep.)
  const waiting = router.propose({ sessionId: 'assistant-1', body, waitMs: 2000 });
  for (let i = 0; i < 200 && sink.cards.length < 2; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(sink.cards.length, 2, 'the card is out and the call is waiting');
  assert.equal(router.cancel(sink.cards[1].request_id, 'superseded', SID), true);
  const result = await waiting;
  assert.deepEqual([result.status, result.reason], ['expired', 'superseded']);
  // The turn that asked is told the user wrote something else: no task, and no closing line unless it has a result.
  assert.match(result.next, /sent a new message instead, which you get next\. Nothing was approved, so do not start this task\. End your turn now, with no text unless you have a result to report\./);
  assert.doesNotMatch(result.next, /ask the user/, 'their message is next: nothing to ask');
  // A run held on the card is declined, never started.
  const held = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { task: 'x', provider: 'codex', model: 'gpt-5.6-luna', taskClass: 'code' } });
  assert.equal(held.action, 'hold');
  router.holdRuns(held.routeId, ['run-9']);
  assert.equal(router.cancel(held.routeId, 'superseded', SID), true);
  assert.deepEqual(sink.declined.at(-1), ['run-9', 'route_superseded']);
  assert.equal(sink.started.length, 0);
});

/** A promise the test settles by hand: holds an await open without a timer. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('answer: a card cancelled while its answer is still reading the catalog is not approved (no decision, no continuation, no held run started)', async (t) => {
  // The gate is open for propose and closed for the answers under test.
  let gate = null;
  const { router, sink, prefs } = harness(t, { mode: 'always-ask', catalogGate: () => gate?.promise });
  const SID = { sessionId: 'assistant-1' };
  // 1. A "do it here on another model" pick (it would queue a direct continuation), cancelled in mid-flight.
  const here = await router.propose({ sessionId: 'assistant-1', body: { task_class: 'quick', confidence: 0.9, summary: 'tidy', proposals: [{ kind: 'direct' }] }, waitMs: 0 });
  assert.equal(here.status, 'pending');
  gate = deferred();
  const lateHere = router.answer(here.routeId, { optionId: 'other', target: { kind: 'direct', provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' }, remember: true });
  // The owner writes something else: the route is cancelled while the answer above still waits for the catalog.
  assert.equal(router.cancel(here.routeId, 'superseded', SID), true);
  gate.resolve();
  await assert.rejects(lateHere, (e) => e.code === 'ROUTE_NOT_FOUND', 'the answer in progress approves nothing');
  assert.equal(sink.continues.length, 0, 'no direct continuation was queued');
  assert.equal(router.status(here.routeId), null, 'no approved route was recorded');
  assert.equal(prefs.length, 0, 'nothing was remembered');
  assert.deepEqual(sink.events.map(([phase]) => phase), ['card', 'expired'], 'never "decided"');
  assert.equal(sink.mailbox.length, 0);
  // 2. A dispatch pick with a held run: the run is declined by the cancel and never started by the late answer.
  gate = null;
  const held = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { task: 'x', provider: 'codex', model: 'gpt-5.6-luna', taskClass: 'code' } });
  assert.equal(held.action, 'hold');
  router.holdRuns(held.routeId, ['run-7']);
  gate = deferred();
  const lateRun = router.answer(held.routeId, { optionId: 's1' });
  assert.equal(router.cancel(held.routeId, 'superseded', SID), true);
  gate.resolve();
  await assert.rejects(lateRun, (e) => e.code === 'ROUTE_NOT_FOUND');
  assert.deepEqual(sink.declined.at(-1), ['run-7', 'route_superseded']);
  assert.equal(sink.started.length, 0, 'the held run never started');
  assert.equal(router.status(held.routeId), null);
  assert.equal(sink.mailbox.length, 0, 'no route_decided event follows a cancelled card');
  // 3. An explicit decline in mid-flight does not turn a cancel into the user's own "no" either.
  gate = null;
  const third = await router.propose({ sessionId: 'assistant-1', body: { task_class: 'research', confidence: 0.9, summary: 'look up', proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' }] }, waitMs: 0 });
  gate = deferred();
  const lateNo = router.answer(third.routeId, { decline: true });
  assert.equal(router.cancel(third.routeId, 'superseded', SID), true);
  gate.resolve();
  await assert.rejects(lateNo, (e) => e.code === 'ROUTE_NOT_FOUND');
  assert.equal(sink.events.some(([phase]) => phase === 'declined'), false);
  assert.equal(sink.mailbox.length, 0, 'no route_declined turn');
  // 4. Two answers in flight: the first one decides, the second is refused (one decision per card).
  gate = null;
  const fourth = await router.propose({ sessionId: 'assistant-1', body: { task_class: 'research', confidence: 0.9, summary: 'look up', proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' }] }, waitMs: 0 });
  gate = deferred();
  const first = router.answer(fourth.routeId, { optionId: 's1' });
  const second = router.answer(fourth.routeId, { optionId: 's1' });
  gate.resolve();
  assert.equal((await first).status, 'approved');
  await assert.rejects(second, (e) => e.code === 'ROUTE_ALREADY_DECIDED');
  assert.equal(sink.mailbox.filter((item) => item.kind === 'route_decided').length, 1, 'decided once');
});

test('cancel and owns are scoped to the session: another session can neither see nor cancel a card', async (t) => {
  const { router, sink } = harness(t, { mode: 'always-ask' });
  const pending = await router.propose({ sessionId: 'assistant-2', body: { task_class: 'research', confidence: 0.9, summary: 'look up', proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' }] }, waitMs: 0 });
  const requestId = sink.cards[0].request_id;
  assert.equal(router.owns(requestId), true);
  assert.equal(router.owns(requestId, 'assistant-2'), true);
  assert.equal(router.owns(requestId, 'assistant-1'), false, 'not this session\'s card');
  assert.equal(router.cancel(requestId, 'superseded', { sessionId: 'assistant-1' }), false, 'another session cannot cancel it');
  assert.equal(router.cancel(requestId, 'superseded'), false, 'a cancel names its session');
  assert.equal(router.pendingCards('assistant-2').length, 1, 'still open');
  assert.deepEqual(sink.cancels, []);
  await assert.rejects(() => router.answer(requestId, { optionId: 's1' }, { origin: 'ui', sessionId: 'assistant-1' }), (e) => e.code === 'ROUTE_NOT_FOUND', 'nor answer it');
  assert.equal(router.status(pending.routeId).status, 'pending');
  assert.equal(router.cancel(requestId, 'superseded', { sessionId: 'assistant-2' }), true);
  assert.equal(router.pendingCards('assistant-2').length, 0);
});

/** Lets every already-settled promise run (macrotask turns, no clock): what is still pending afterwards is waiting on a timer. */
async function turns(n = 5) { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); }

test('a card a host closes while it is being sent (the user had already written something else) is never reported pending or held', async (t) => {
  const { router, sink } = harness(t, { mode: 'always-ask' });
  // The WhatsApp bridge, with a phone message already waiting: it cancels the card inside sendCard.
  sink.onSend = (sid, packet) => { assert.equal(router.cancel(packet.request_id, 'superseded', { sessionId: sid }), true); };
  const body = { task_class: 'research', confidence: 0.9, summary: 'look up', proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' }] };
  // agent_route inside a turn (it would wait up to 2 s for the user): it returns at once, and not "pending".
  const waited = await Promise.race([router.propose({ sessionId: 'assistant-1', body, waitMs: 2000 }), turns().then(() => 'still waiting')]);
  assert.notEqual(waited, 'still waiting', 'no wait on a card that is already closed');
  assert.deepEqual([waited.status, waited.reason], ['expired', 'superseded']);
  assert.match(waited.next, /sent a new message instead, which you get next\. Nothing was approved, so do not start this task\./);
  assert.deepEqual(sink.events.map(([phase]) => phase), ['expired'], 'no "card" event after the card closed');
  assert.deepEqual(router.pendingCards('assistant-1'), []);
  assert.equal(router.status(waited.routeId), null);
  // Without a wait (waitMs 0) too: never "pending" for a route that no longer exists.
  const unwaited = await router.propose({ sessionId: 'assistant-1', body, waitMs: 0 });
  assert.deepEqual([unwaited.status, unwaited.reason], ['expired', 'superseded']);
  assert.equal(sink.mailbox.length, 0, 'and no mailbox event is promised or sent');
  // An implicit dispatch: no hold on the closed card; the caller gets a refusal it can act on.
  await assert.rejects(
    () => router.resolveDispatch({ sessionId: 'assistant-1', spec: { task: 'x', provider: 'codex', model: 'gpt-5.6-luna', taskClass: 'code' } }),
    (e) => e.code === 'ROUTE_CANCELLED' && e.status === 409 && /sent a new message instead/.test(e.message) && /Nothing was started/.test(e.message),
  );
  assert.deepEqual(router.pendingCards('assistant-1'), []);
  assert.equal(sink.events.some(([phase]) => phase === 'card'), false);
  // A card closed for another reason while it is sent (the turn was stopped) reads as cancelled, not as "the user moved on".
  sink.onSend = (sid) => router.cancelForSession(sid, 'aborted');
  const stopped = await Promise.race([router.propose({ sessionId: 'assistant-1', body, waitMs: 2000 }), turns().then(() => 'still waiting')]);
  assert.equal(stopped.status, 'cancelled');
  assert.match(stopped.next, /no longer valid\. Do not start the task/);
  await assert.rejects(() => router.resolveDispatch({ sessionId: 'assistant-1', spec: { task: 'x', provider: 'codex', model: 'gpt-5.6-luna', taskClass: 'code' } }), (e) => e.code === 'ROUTE_CANCELLED' && /no longer valid/.test(e.message));
  // A run attached to a route that has closed is refused (holdRuns → false), an open one accepted.
  sink.onSend = null;
  const held = await router.resolveDispatch({ sessionId: 'assistant-1', spec: { task: 'x', provider: 'codex', model: 'gpt-5.6-luna', taskClass: 'code' } });
  assert.equal(held.action, 'hold');
  assert.equal(router.holdRuns(held.routeId, ['run-1']), true);
  assert.equal(router.cancel(held.routeId, 'superseded', { sessionId: 'assistant-1' }), true);
  assert.equal(router.holdRuns(held.routeId, ['run-2']), false);
});

// ── A route card that also asks for the Mac (a WhatsApp session at Ask) ──────

test('computer consent on a route card: recorded when the card is made, for the one option a plain yes approves; never derived again at answer time', async (t) => {
  const catalog = createAssistantCatalog({ fetchJson: fakeFetch(), claudePricing: PRICING });
  const brain = { provider: 'claude-code', model: 'sonnet', effort: null };
  const sessions = new Map();
  const calls = [];
  const sinks = {
    sendCard: (sessionId, packet) => calls.push(['card', sessionId, packet]),
    computerApproved: (sessionId, payload) => calls.push(['computerApproved', sessionId, payload]),
    mailbox: (sessionId, item) => calls.push(['mailbox', sessionId, item.kind]),
    continueDirect: () => true,
  };
  let waitSeconds = 0; // how long agent_route waits inside its turn before it answers "pending"
  const router = createAssistantRouter({
    catalog, configStore: { routing: () => effectiveRouting({ defaultMode: 'always-ask', waitSeconds }), setPreference() {} },
    getSession: (id) => sessions.get(id) || null, sinks,
  });
  t.after(() => router.shutdown());
  const ASK = { state: 'ask', reason: 'ask' };
  const session = (id, extra = {}) => { sessions.set(id, { brain, routingMode: 'always-ask', running: true, remote: true, computer: ASK, ...extra }); return id; };
  const HERE = { task_class: 'computer', confidence: 0.9, summary: 'Tidy the desktop', proposals: [{ kind: 'direct' }] };
  const propose = async (sessionId, body = HERE, origin = 'agent_route') => {
    const result = await router.propose({ sessionId, body, origin, waitMs: 0 });
    return { result, card: router._internals.cards.get(result.routeId) };
  };
  const approvals = () => calls.filter((row) => row[0] === 'computerApproved').map((row) => [row[1], row[2]]);

  // The card of a computer task done here, in a WhatsApp session whose computer use is "after approval".
  const wa = session('wa');
  const { result, card } = await propose(wa);
  assert.equal(result.status, 'pending');
  const marked = card.defaultOptionId;
  const option = card.options.find((o) => o.id === marked);
  assert.deepEqual([option.kind, option.provider, option.model, option.disabled], ['direct', 'claude-code', 'sonnet', false]);
  assert.deepEqual(card.computer, { optionId: marked });
  assert.deepEqual(card.packet.request.computer, { optionId: marked }, 'every host is told which option also asks for the Mac');
  // Every case that stays a plain route card: no flag on the card, nothing in the packet.
  const plain = async (label, id, body = HERE, origin = 'agent_route') => {
    const made = await propose(id, body, origin);
    assert.equal(made.card.computer, null, label);
    assert.equal('computer' in made.card.packet.request, false, label);
    return made;
  };
  await plain('a desktop session', session('desk', { remote: false, computer: null }));
  await plain('Autonomous: unasked anyway', session('auto', { computer: { state: 'allowed', reason: 'autonomous' } }));
  await plain('the switch is off', session('off', { computer: { state: 'off', reason: 'switch_off' } }));
  await plain('no answer from the runtime', session('none', { computer: null }));
  for (const taskClass of ['quick', 'browser', 'research', 'automation', 'code']) await plain(`class ${taskClass}`, session(`c-${taskClass}`), { ...HERE, task_class: taskClass });
  await plain('another model of the brain (a continuation)', session('cont'), { ...HERE, proposals: [{ kind: 'direct', model: 'haiku' }] });
  await plain('another effort (a continuation)', session('effort'), { ...HERE, proposals: [{ kind: 'direct', model: 'sonnet', effort: 'high' }] });
  await plain('a worker', session('worker'), { ...HERE, proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-5.6-luna' }] });
  await plain('another provider', session('codex'), { ...HERE, proposals: [{ kind: 'direct', provider: 'codex', model: 'gpt-5.6-luna' }] });
  // A dispatch's own card (agent_dispatch without a route) never carries it, whatever its class says.
  const held = await router.resolveDispatch({ sessionId: session('dispatch'), spec: { provider: 'claude-code', model: 'sonnet', task: 'open Notes', taskClass: 'computer', usesComputer: true } });
  assert.equal(held.action, 'hold');
  assert.equal(router._internals.cards.get(held.routeId).computer, null);
  assert.equal('computer' in router._internals.cards.get(held.routeId).packet.request, false);

  // The yes to the marked option: one call to the runtime, saying which route, who answered and which turn carries it out.
  assert.deepEqual(approvals(), []);
  // `authority` is the answerer's capability (the WhatsApp bridge's): the router hands it on untouched and decides nothing by it.
  const capability = Symbol('the bridge');
  const approved = await router.answer(result.routeId, { kind: 'route', optionId: marked, remember: false }, { origin: 'whatsapp', sessionId: wa, authority: capability });
  assert.equal(approved.status, 'approved');
  assert.deepEqual(approvals(), [[wa, { routeId: result.routeId, origin: 'whatsapp', viaMailbox: true, authority: capability }]], 'the turn that raised it is over (pending): the mailbox turn carries it out');
  assert.ok(calls.findIndex((row) => row[0] === 'computerApproved') < calls.findIndex((row) => row[0] === 'mailbox'), 'the approval is recorded before the route_decided item is queued');
  assert.equal('computer' in router._internals.decided.get(result.routeId), false, 'the decided route itself carries no computer approval (it is reusable; the approval is not)');
  // Answered while agent_route is still waiting in its turn: that turn carries it out.
  calls.length = 0;
  const live = session('wa-live');
  waitSeconds = 30;
  const waiting = router.propose({ sessionId: live, body: HERE, waitMs: 30_000 });
  let open = null;
  for (let i = 0; i < 50 && !open; i += 1) { await new Promise((done) => setImmediate(done)); open = [...router._internals.cards.values()].find((c) => c.sessionId === live && c.waiters.size > 0) || null; }
  waitSeconds = 0;
  await router.answer(open.routeId, { kind: 'route', optionId: open.computer.optionId, remember: false }, { origin: 'ui', sessionId: live });
  assert.equal((await waiting).status, 'approved');
  assert.deepEqual(approvals(), [[live, { routeId: open.routeId, origin: 'ui', viaMailbox: false, authority: null }]], 'an answer without a capability carries none: the runtime then grants nothing');

  // Another option of a marked card, a model named outside the options, and a decline: a route answer only.
  calls.length = 0;
  for (const [label, respond] of [
    ['another offered model', (c) => ({ kind: 'route', optionId: c.options.find((o) => o.id !== c.computer.optionId && !o.disabled).id, remember: false })],
    ['a model outside the options', () => ({ kind: 'route', optionId: 'other', remember: false, target: { kind: 'direct', provider: 'claude-code', model: 'haiku' } })],
    ['the same model named through "other"', () => ({ kind: 'route', optionId: 'other', remember: false, target: { kind: 'direct', provider: 'claude-code', model: 'sonnet' } })],
    ['a decline', () => ({ kind: 'route', optionId: null, remember: false, decline: true })],
  ]) {
    const id = session(`x-${label}`);
    const made = await propose(id);
    assert.ok(made.card.computer, label);
    await router.answer(made.result.routeId, respond(made.card), { origin: 'whatsapp', sessionId: id });
    assert.deepEqual(approvals(), [], label);
  }
  // Decided from what the card recorded when it was sent: a session that became "ask" afterwards
  // does not turn a plain card's approval into a computer approval…
  const late = session('late', { computer: { state: 'off', reason: 'switch_off' } });
  const before = await propose(late);
  assert.equal(before.card.computer, null);
  sessions.get(late).computer = ASK;
  await router.answer(before.result.routeId, { kind: 'route', optionId: before.card.defaultOptionId, remember: false }, { origin: 'whatsapp', sessionId: late });
  assert.deepEqual(approvals(), [], 'the card never said the Mac would be controlled');
  // …and neither does a class the brain supplies again later: the same summary routed as "quick" is a plain card.
  const again = await propose(wa, { ...HERE, task_class: 'quick' });
  assert.equal(again.card.computer, null);
  await router.answer(again.result.routeId, { kind: 'route', optionId: again.card.defaultOptionId, remember: false }, { origin: 'whatsapp', sessionId: wa });
  assert.deepEqual(approvals(), []);
  // A marked card answered through REST still reports its origin: the runtime, not the router, refuses it.
  const rest = await propose(session('rest'));
  await router.answer(rest.result.routeId, { kind: 'route', optionId: rest.card.computer.optionId, remember: false }, { origin: 'rest' });
  assert.deepEqual(approvals(), [['rest', { routeId: rest.result.routeId, origin: 'rest', viaMailbox: true, authority: null }]]);
});

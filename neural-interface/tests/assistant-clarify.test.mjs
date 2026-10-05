import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import express from 'express';
import {
  ClarifyError, answersFromResponse, createAssistantClarifier, normalizeClarifyRequest, questionsFromControl,
} from '../lib/assistant-clarify.js';
import { briefBlock, buildTaskPrompt } from '../lib/assistant-task-prompt.js';
import { CLARIFY_HOLD_TEXT, createRouteGate, gateStateFor, isExemptTool } from '../lib/assistant-route-gate.js';
import { buildAssistantPersona, formatMailbox } from '../lib/assistant-persona.js';
import { createAssistantRuntime } from '../lib/assistant-runtime.js';
import { createAssistantApi } from '../lib/assistant-api.js';
import { createAssistantRouter, TASK_CLASS_META } from '../lib/assistant-router.js';
import { createAssistantDispatcher, DispatchError } from '../lib/assistant-dispatch.js';
import { createAssistantCatalog } from '../lib/assistant-catalog.js';
import { effectiveRouting } from '../lib/assistant-config.js';
import { NativeLoopRuntime } from '../lib/native-loop-runtime.js';
import { planToolDecision } from '../lib/assistant-plan-permissions.js';
import {
  CONTROL_KINDS, buildControlResponse, controlActions, normalizeControlRequest, renderControlCard,
} from '../public/shared/assistant/asst-control.js';
import { PRICING, fakeFetch } from './assistant-catalog.fixtures.mjs';

const QUESTIONS = [
  { id: 'scope', header: 'Scope', question: 'Should dark mode cover the whole app or only the settings page?', options: [{ label: 'Whole app', description: 'Every screen' }, { label: 'Settings page only' }] },
  { header: 'Theme source', question: 'Follow the OS setting or a manual toggle?', options: ['Follow the OS', 'Manual toggle', 'Both'] },
];
const BODY = { summary: 'Add dark mode', questions: QUESTIONS, constraints: ['Keep the current light palette'], assumptions: ['Use CSS variables', 'No new dependencies'] };
const PROMPT = 'add dark mode to the app\nit should look good';
const RESULT = (status = 'done') => `## Result\nstatus: ${status}\nsummary: did it\nchanges:\n- none\nfollow_ups:\n- none`;
const tick = () => new Promise((r) => setImmediate(r));
const waitFor = async (predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const v = predicate(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('Timed out waiting for condition');
};

function harness({ waitSeconds = 0, enabled = true, prompt = PROMPT, cycle = 1 } = {}) {
  const sent = [];
  const cancelled = [];
  const events = [];
  const mailbox = [];
  const gates = [];
  const session = { lastPrompt: prompt, cycle };
  // `hooks.onSend`: a host that acts while the card is being sent (it closes the card at once).
  const hooks = { onSend: null };
  let n = 0;
  const clarifier = createAssistantClarifier({
    getSession: (id) => (id === 'assistant-1' ? session : null),
    settings: () => ({ enabled, waitSeconds }),
    sinks: {
      sendCard: (sid, packet) => { sent.push([sid, packet]); hooks.onSend?.(sid, packet); },
      cancelCard: (sid, requestId, reason) => cancelled.push([sid, requestId, reason]),
      event: (sid, phase, view) => events.push([sid, phase, view]),
      mailbox: (sid, item) => mailbox.push([sid, item]),
      gate: (sid, result) => gates.push([sid, result]),
    },
    randomId: () => `id${++n}`,
  });
  return { clarifier, sent, cancelled, events, mailbox, gates, session, hooks };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('normalizeClarifyRequest keeps it light: 1-3 questions of 2-4 options, clean lists', () => {
  const out = normalizeClarifyRequest({
    ...BODY,
    questions: [...QUESTIONS, { ...QUESTIONS[0], id: 'again' }],
    assumptions: ['Use CSS variables', 'use css variables', '  ', 'No new dependencies'],
  });
  assert.equal(out.summary, 'Add dark mode');
  assert.equal(out.questions.length, 2, 'a repeated question is dropped');
  assert.equal(out.questions[0].id, 'scope');
  assert.equal(out.questions[1].id, 'q2', 'ids default to their position');
  assert.equal(out.questions[1].header, 'Theme source');
  assert.deepEqual(out.questions[1].options.map((o) => o.label), ['Follow the OS', 'Manual toggle', 'Both'], 'string options are accepted');
  assert.equal(out.questions[0].options[0].description, 'Every screen');
  assert.deepEqual(out.assumptions, ['Use CSS variables', 'No new dependencies']);
  assert.deepEqual(out.constraints, ['Keep the current light palette']);
  assert.equal(normalizeClarifyRequest({ questions: [{ question: 'Which one?', options: ['A', 'B'] }] }).questions[0].header, 'Which one', 'a missing header comes from the question');

  const two = ['A', 'B'];
  assert.throws(() => normalizeClarifyRequest({ questions: [] }), (e) => e instanceof ClarifyError && e.code === 'CLARIFY_INVALID' && e.status === 400 && /act/.test(e.message));
  assert.throws(
    () => normalizeClarifyRequest({ questions: ['a?', 'b?', 'c?', 'd?'].map((question) => ({ question, options: two })) }),
    (e) => e.code === 'CLARIFY_TOO_MANY' && /at most 3/.test(e.message) && /assumptions/.test(e.message),
  );
  assert.throws(() => normalizeClarifyRequest({ questions: [{ question: 'x?', options: ['only'] }] }), /2-4 distinct options/);
  assert.throws(() => normalizeClarifyRequest({ questions: [{ question: 'x?', options: ['a', 'b', 'c', 'd', 'e'] }] }), /2-4 distinct options/);
  assert.throws(() => normalizeClarifyRequest({ questions: [{ question: 'x?', options: ['same', 'Same'] }] }), /2-4 distinct options/);
  assert.throws(() => normalizeClarifyRequest({ questions: [{ options: two }] }), /has no text/);
});

test('answersFromResponse reads every reply shape the panel builds', () => {
  const qs = normalizeClarifyRequest(BODY).questions;
  const lists = answersFromResponse(qs, { kind: 'clarify', behavior: 'allow', answers: [['Whole app'], ['Follow the OS']] });
  assert.equal(lists.declined, false);
  assert.deepEqual(lists.answers.map((a) => a.answers), [['Whole app'], ['Follow the OS']]);
  // Claude AskUserQuestion keys answers by the question's own text (spacing differences are ignored).
  const claude = answersFromResponse(qs, { behavior: 'allow', updatedInput: { answers: { 'Should dark mode cover the whole app  or only the settings page?': 'Whole app' } } });
  assert.deepEqual(claude.answers[0].answers, ['Whole app']);
  assert.deepEqual(claude.answers[1].answers, []);
  // Codex requestUserInput: keyed by id.
  const codex = answersFromResponse(qs, { behavior: 'allow', answers: { scope: { answers: ['Settings page only'] }, q2: { answers: ['Both'] } } });
  assert.deepEqual(codex.answers.map((a) => a.answers), [['Settings page only'], ['Both']]);
  // SynaBun `choice` over MCP elicitation, with an "Other" answer.
  const choice = answersFromResponse(qs, { result: { action: 'accept', content: { scope: '__synabun_other__', scope__other: 'Only the editor', q2: 'Manual toggle' } } });
  assert.deepEqual(choice.answers.map((a) => a.answers), [['Only the editor'], ['Manual toggle']]);
  // Skip, decline and "submitted nothing".
  assert.deepEqual(answersFromResponse(qs, { behavior: 'deny', message: 'your call' }), { declined: true, answers: [], note: 'your call' });
  assert.equal(answersFromResponse(qs, { result: { action: 'decline' } }).declined, true);
  assert.equal(answersFromResponse(qs, { behavior: 'allow', answers: [[], []] }).declined, true);
});

test('questionsFromControl reads the brain\'s own question cards and nothing else', () => {
  const claude = questionsFromControl({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which database?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] } });
  assert.deepEqual(claude.map((q) => [q.id, q.header, q.options.length]), [['Which database?', 'DB', 2]]);
  const choice = questionsFromControl({ kind: 'elicitation', tool_name: 'AskUserQuestion', input: { message: `[SYNABUN_CHOICE_V1]${JSON.stringify({ questions: [{ id: 'db', header: 'DB', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] })}` } });
  assert.equal(choice[0].id, 'db');
  const opencode = questionsFromControl({ subtype: 'can_use_tool', provider: 'opencode', kind: 'question', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Deploy now?', options: [{ label: 'Yes' }, { label: 'No' }] }] } });
  assert.equal(opencode[0].question, 'Deploy now?');
  assert.deepEqual(questionsFromControl({ subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } }), []);
  assert.deepEqual(questionsFromControl({ kind: 'elicitation', input: { message: 'Pick a file', requestedSchema: {} } }), []);
});

// ── The clarifier ────────────────────────────────────────────────────────────

test('answered on the card while agent_clarify waits: no mailbox turn, and the brief goes to the dispatch', async () => {
  const h = harness({ waitSeconds: 5 });
  const asking = h.clarifier.ask({ sessionId: 'assistant-1', body: BODY });
  await tick();
  assert.equal(h.sent.length, 1);
  const [, packet] = h.sent[0];
  assert.equal(packet.type, 'control_request');
  assert.equal(packet.request.subtype, 'clarify');
  assert.equal(packet.request.summary, 'Add dark mode');
  assert.deepEqual(packet.request.questions.map((q) => q.id), ['scope', 'q2']);
  assert.deepEqual(packet.request.assumptions, BODY.assumptions);
  assert.equal(h.clarifier.owns(packet.request_id), true);
  assert.equal(h.clarifier.blocking('assistant-1').briefId, packet.request.briefId, 'dependent work waits while the card is open');

  h.clarifier.answer(packet.request_id, { kind: 'clarify', behavior: 'allow', answers: [['Whole app'], ['Follow the OS']] });
  const result = await asking;
  assert.equal(result.status, 'answered');
  assert.equal(result.briefId, packet.request.briefId);
  assert.match(result.next, /agent_dispatch with brief_id "brief-/);
  assert.deepEqual(result.decisions.map((d) => [d.header, d.answers]), [['Scope', ['Whole app']], ['Theme source', ['Follow the OS']]]);
  assert.equal(h.mailbox.length, 0, 'the brain got the answers in its tool call');
  assert.equal(h.gates.length, 0, 'answered in the call: the route gate is untouched');
  assert.deepEqual(h.events.map(([, phase]) => phase), ['card', 'answered']);
  assert.equal(h.clarifier.owns(packet.request_id), false);
  assert.equal(h.clarifier.blocking('assistant-1'), null);

  const brief = h.clarifier.forDispatch('assistant-1', {});
  assert.equal(brief.briefId, result.briefId);
  assert.equal(brief.request, PROMPT, 'the user\'s own words, verbatim');
  assert.equal(brief.summary, 'Add dark mode');
  assert.deepEqual(brief.constraints, ['Keep the current light palette']);
  assert.deepEqual(brief.assumptions, ['Use CSS variables', 'No new dependencies']);
  assert.equal(brief.skipped, false);
  assert.equal(h.clarifier.forDispatch('assistant-1', { independent: true }), null, 'independent work goes without it');
  assert.equal(h.clarifier.forDispatch('assistant-1', { briefId: result.briefId }).briefId, result.briefId);
  assert.throws(() => h.clarifier.forDispatch('assistant-1', { briefId: 'brief-nope' }), (e) => e.code === 'BRIEF_UNKNOWN' && e.status === 400);
  assert.equal(h.clarifier.get(result.briefId).status, 'answered');
});

test('still waiting: the gate holds, dependent work is refused, one card only, and the answer arrives by mailbox', async () => {
  const h = harness({ waitSeconds: 0 });
  const result = await h.clarifier.ask({ sessionId: 'assistant-1', body: BODY });
  assert.equal(result.status, 'pending');
  assert.match(result.next, /End your turn now/);
  assert.deepEqual(h.gates.map(([, r]) => r.status), ['pending']);
  assert.throws(
    () => h.clarifier.forDispatch('assistant-1', {}),
    (e) => e instanceof ClarifyError && e.code === 'CLARIFICATION_PENDING' && e.status === 409 && e.briefId === result.briefId && /independent:true/.test(e.message),
  );
  assert.throws(() => h.clarifier.forDispatch('assistant-1', { briefId: result.briefId }), (e) => e.code === 'CLARIFICATION_PENDING');
  assert.equal(h.clarifier.forDispatch('assistant-1', { independent: true }), null);
  assert.equal(h.clarifier.blocking('assistant-1', { independent: true }), null);

  const again = await h.clarifier.ask({ sessionId: 'assistant-1', body: BODY });
  assert.equal(again.status, 'pending');
  assert.match(again.next, /already on screen: do not ask again/);
  assert.equal(h.sent.length, 1, 'no second card');
  const requestId = h.sent[0][1].request_id;
  assert.deepEqual(h.clarifier.pendingCards('assistant-1').map((p) => p.request_id), [requestId], 'a reattaching panel gets the open card back');

  h.clarifier.answer(requestId, { kind: 'clarify', behavior: 'allow', answers: [['Settings page only'], ['Manual toggle']] });
  assert.equal(h.mailbox.length, 1);
  const [, item] = h.mailbox[0];
  assert.equal(item.kind, 'clarify_answered');
  assert.equal(item.brief.briefId, result.briefId);
  const text = formatMailbox([item]);
  assert.match(text, /^\[SynaBun Mailbox\] 1 event/);
  assert.match(text, /1\. clarify_answered · brief-\S+ \("Add dark mode"\)/);
  assert.match(text, /answers: Scope: Settings page only · Theme source: Manual toggle/);
  assert.match(text, /next: The user answered\. Route the task now/);
  assert.equal(h.clarifier.forDispatch('assistant-1', {}).decisions.length, 2);
  assert.throws(() => h.clarifier.answer(requestId, { behavior: 'allow' }), (e) => e.code === 'CLARIFY_NOT_FOUND' && e.status === 404);
});

test('skipped: the brain goes on its assumptions, and the worker is told the user skipped', async () => {
  const h = harness({ waitSeconds: 0 });
  const result = await h.clarifier.ask({ sessionId: 'assistant-1', body: BODY });
  const skipped = h.clarifier.answer(h.sent[0][1].request_id, { kind: 'clarify', behavior: 'deny', message: 'Your call' });
  assert.equal(skipped.status, 'declined');
  assert.match(skipped.next, /Proceed on your stated assumptions/);
  const [, item] = h.mailbox[0];
  assert.equal(item.kind, 'clarify_declined');
  assert.match(formatMailbox([item]), /note: Your call · your assumptions: Use CSS variables; No new dependencies/);
  const brief = h.clarifier.forDispatch('assistant-1', { briefId: result.briefId });
  assert.equal(brief.skipped, true);
  assert.deepEqual(brief.notes, ['Your call']);
  assert.deepEqual(brief.decisions, []);
  const block = briefBlock(brief);
  assert.match(block, /The user skipped the questions: go with the assumptions below\./);
  assert.match(block, /The user's note: Your call/);
});

test('a chat reply answers the open questions; the next request retires the brief', async () => {
  const h = harness({ waitSeconds: 0 });
  const result = await h.clarifier.ask({ sessionId: 'assistant-1', body: BODY });
  assert.equal(h.clarifier.onUserPrompt('assistant-1', { text: '/agents', cycle: 2 }), null, 'a slash command is no reply');
  assert.ok(h.clarifier.blocking('assistant-1'), 'still open');
  const reply = h.clarifier.onUserPrompt('assistant-1', { text: 'whole app, follow the OS', cycle: 2 });
  assert.equal(reply.briefId, result.briefId);
  assert.match(reply.note, /^\[SynaBun Clarify\] The user's message below replies to your open questions \(brief brief-\S+: "Add dark mode"\)/);
  assert.equal(h.mailbox.length, 0, 'the brain reads the reply itself');
  assert.equal(h.events.at(-1)[1], 'chat');
  assert.equal(h.clarifier.pendingCards('assistant-1').length, 0);
  assert.equal(h.clarifier.blocking('assistant-1'), null);
  const brief = h.clarifier.forDispatch('assistant-1', {});
  assert.deepEqual(brief.replies, ['whole app, follow the OS']);
  assert.equal(brief.request, PROMPT, 'the original request is kept beside the reply');
  assert.match(briefBlock(brief), /The user's reply in chat to the assistant's questions:\n> whole app, follow the OS/);

  assert.equal(h.clarifier.onUserPrompt('assistant-1', { text: 'now something else', cycle: 3 }), null);
  assert.equal(h.clarifier.forDispatch('assistant-1', {}), null, 'a new request starts without it');
  assert.equal(h.clarifier.forDispatch('assistant-1', { briefId: result.briefId }).briefId, result.briefId, 'still addressable by id');
  assert.equal(h.clarifier.onUserPrompt('assistant-1', { text: 'nothing open', cycle: 4 }), null);
});

test('questions asked with the brain\'s own tool join the brief and hold dependent dispatches', () => {
  const h = harness();
  const request = { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which database?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] } };
  const briefId = h.clarifier.onNativeQuestion('assistant-1', { requestId: 'toolu_1', request, cycle: 1, prompt: 'build the api' });
  assert.match(briefId, /^brief-/);
  assert.equal(h.sent.length, 0, 'the brain\'s own card asks it');
  assert.throws(() => h.clarifier.forDispatch('assistant-1', {}), (e) => e.code === 'CLARIFICATION_PENDING' && /A question you asked the user is still open/.test(e.message));
  assert.equal(h.clarifier.blocking('assistant-1'), null, 'its own tool blocks the brain\'s turn; agent_route is not held for it');
  h.clarifier.onNativeAnswer('assistant-1', { requestId: 'toolu_1', response: { behavior: 'allow', updatedInput: { questions: [], answers: { 'Which database?': 'SQLite' } } } });
  const brief = h.clarifier.forDispatch('assistant-1', {});
  assert.equal(brief.request, 'build the api');
  assert.deepEqual(brief.decisions, [{ header: 'DB', question: 'Which database?', answers: ['SQLite'] }]);
  assert.equal(h.events.length, 0, 'the brain\'s own transcript already shows its question');

  assert.equal(h.clarifier.onNativeQuestion('assistant-1', { requestId: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } }), null, 'a permission card is no question');
  h.clarifier.onNativeQuestion('assistant-1', { requestId: 'toolu_2', request, cycle: 1 });
  assert.throws(() => h.clarifier.forDispatch('assistant-1', {}), (e) => e.code === 'CLARIFICATION_PENDING');
  h.clarifier.onNativeSettled('assistant-1', 'toolu_2', 'turn_ended');
  assert.doesNotThrow(() => h.clarifier.forDispatch('assistant-1', {}), 'closed unanswered: it stops holding');
  assert.equal(h.clarifier.forDispatch('assistant-1', {}).decisions.length, 1);
});

test('switched off, bad input, unknown session and a closed session', async () => {
  const off = harness({ enabled: false });
  const disabled = await off.clarifier.ask({ sessionId: 'assistant-1', body: BODY });
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.code, 'CLARIFY_DISABLED');
  assert.equal(off.sent.length, 0);
  assert.equal(off.clarifier.forDispatch('assistant-1', {}), null);
  assert.equal(off.clarifier.onNativeQuestion('assistant-1', { requestId: 'x', request: { tool_name: 'AskUserQuestion', input: { questions: [{ question: 'q?' }] } } }), null);

  const h = harness({ waitSeconds: 0 });
  await assert.rejects(h.clarifier.ask({ sessionId: 'assistant-nope', body: BODY }), (e) => e.code === 'SESSION_NOT_FOUND' && e.status === 404);
  await assert.rejects(h.clarifier.ask({ sessionId: 'assistant-1', body: { questions: [] } }), (e) => e.code === 'CLARIFY_INVALID');
  assert.equal(h.sent.length, 0, 'an invalid call shows nothing');
  await h.clarifier.ask({ sessionId: 'assistant-1', body: BODY });
  h.clarifier.cancelForSession('assistant-1', 'session_closed');
  assert.deepEqual(h.cancelled.map(([, , reason]) => reason), ['session_closed']);
  assert.equal(h.events.at(-1)[1], 'cancelled');
  assert.equal(h.clarifier.blocking('assistant-1'), null);
  assert.equal(h.mailbox.length, 0);
});

// ── Worker prompt, gate, router, persona, plan mode ──────────────────────────

test('the worker prompt carries the brief between TASK and CONTEXT: answers bind, assumptions are defaults', () => {
  const brief = {
    briefId: 'brief-1', request: 'add dark mode\nit should look good', summary: 'Add dark mode',
    decisions: [{ header: 'Scope', question: 'Whole app or settings only?', answers: ['Whole app'] }],
    replies: [], skipped: false, notes: [], constraints: ['Keep the light palette'], assumptions: ['Use CSS variables'],
  };
  const prompt = buildTaskPrompt({ task: 'Implement dark mode', context: 'Files: src/theme.css', cwd: '/tmp/p', project: 'p', runId: 'r1', provider: 'codex', brief });
  const taskAt = prompt.indexOf('TASK:\nImplement dark mode');
  const briefAt = prompt.indexOf('USER BRIEF (clarified with the user before this dispatch)');
  const contextAt = prompt.indexOf('CONTEXT (from the assistant):');
  assert.ok(taskAt > 0 && briefAt > taskAt && contextAt > briefAt, 'TASK, then USER BRIEF, then CONTEXT');
  assert.match(prompt, /original request, verbatim \(it may cover more than your TASK; do your TASK\):\n> add dark mode\n> it should look good/);
  assert.match(prompt, /- Scope: Whole app \(asked: "Whole app or settings only\?"\)/);
  assert.match(prompt, /Constraints:\n- Keep the light palette/);
  assert.match(prompt, /Assumptions \(the assistant's, not confirmed by the user\):\n- Use CSS variables/);
  assert.match(prompt, /override anything in TASK or CONTEXT that contradicts them/);
  assert.ok(prompt.trimEnd().endsWith('```'), 'the result contract still closes the prompt');
  assert.equal(briefBlock(null), '');
  assert.equal(briefBlock({ briefId: 'b', decisions: [], replies: [] }), '', 'an empty brief adds nothing');
  assert.doesNotMatch(buildTaskPrompt({ task: 'x', cwd: '/tmp', runId: 'r' }), /USER BRIEF/, 'clear requests are unchanged');
});

test('route gate: open questions hold the turn; agent_clarify never needs routing (plan mode included)', () => {
  assert.equal(isExemptTool('mcp__SynaBun__agent_clarify'), true);
  assert.equal(isExemptTool('SynaBun_agent_clarify'), true);
  assert.deepEqual(gateStateFor({ ok: true, status: 'clarifying' }), { state: 'held', text: CLARIFY_HOLD_TEXT });
  const gate = createRouteGate({ sessionId: 'assistant-1' });
  gate.startTurn();
  gate.onClarify({ status: 'answered' });
  assert.equal(gate.snapshot().state, 'unrouted', 'answered in the call: route next');
  gate.onRouteResult({ ok: true, status: 'approved', routeId: 'route-1', target: { kind: 'direct' } });
  assert.equal(gate.snapshot().state, 'open');
  gate.onClarify({ status: 'pending' });
  const refused = gate.check('Bash');
  assert.equal(refused.allow, false);
  assert.match(refused.reason, /Waiting for the user's answers to your questions: end your turn now/);
  assert.equal(gate.check('mcp__SynaBun__agent_clarify').allow, true);
  assert.equal(planToolDecision('mcp__SynaBun__agent_clarify', {}, { host: 'claude-code' }) !== 'deny', true, 'asking the user is read-only');
});

test('persona: the clarify section only when wired; one targeted call, never a questionnaire', () => {
  const routing = { mode: 'ask-unsure', askBelow: 0.75, preferences: {} };
  const on = buildAssistantPersona({ assistantSessionId: 'assistant-1', routing, clarify: true });
  assert.match(on, /## Clarify first, only when it matters/);
  assert.match(on, /one mcp__SynaBun__agent_clarify call BEFORE routing: 1-3 questions \(2-4 short options each/);
  assert.match(on, /Never a questionnaire/);
  assert.match(on, /independent:true/);
  assert.match(on, /continuation, pending, declined, clarifying → nothing more/);
  assert.match(on, /After a clarification, pass its brief_id/);
  const codex = buildAssistantPersona({ assistantSessionId: 'assistant-1', routing, clarify: true, toolPrefix: 'SynaBun_', hasAskUserQuestion: false });
  assert.match(codex, /one SynaBun_agent_clarify call/);
  assert.match(codex, /Ask with SynaBun_choice \(multiple-choice elicitation\) only mid-task/);
  const off = buildAssistantPersona({ assistantSessionId: 'assistant-1', routing });
  assert.doesNotMatch(off, /agent_clarify/);
  assert.match(off, /Ask with AskUserQuestion only when materially ambiguous/);
});

function realCatalog() { return createAssistantCatalog({ fetchJson: fakeFetch(), claudePricing: PRICING }); }

test('agent_route answers "clarifying" while the user has not answered; independent work routes as usual', async () => {
  const h = harness({ waitSeconds: 0 });
  const routed = [];
  const router = createAssistantRouter({
    catalog: realCatalog(),
    configStore: { routing: () => effectiveRouting({}), setPreference() {} },
    getSession: () => ({ brain: { provider: 'claude-code', model: 'sonnet' }, routingMode: 'never' }),
    sinks: { routed: (sid, result, meta) => routed.push([result, meta]), routeEvent() {} },
    clarifier: h.clarifier,
  });
  const body = { task_class: 'code', summary: 'Add dark mode', confidence: 0.9, proposals: [{ kind: 'dispatch', provider: 'claude-code', model: 'sonnet' }] };
  await h.clarifier.ask({ sessionId: 'assistant-1', body: BODY });
  const held = await router.propose({ sessionId: 'assistant-1', body });
  assert.equal(held.status, 'clarifying');
  assert.match(held.briefId, /^brief-/);
  assert.match(held.next, /has not answered your questions yet/);
  assert.match(held.next, /independent:true/);
  assert.equal(gateStateFor(routed[0][0], routed[0][1]).state, 'held', 'the gate holds on "clarifying"');
  const free = await router.propose({ sessionId: 'assistant-1', body: { ...body, independent: true } });
  assert.equal(free.status, 'approved');
  h.clarifier.answer(h.sent[0][1].request_id, { kind: 'clarify', behavior: 'allow', answers: [['Whole app'], ['Both']] });
  assert.equal((await router.propose({ sessionId: 'assistant-1', body })).status, 'approved', 'answered: it routes');
  router.shutdown();
});

// ── End to end through the dispatcher ────────────────────────────────────────

function dispatchHarness(t, { mode = 'never' } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-clarify-dispatch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prompts = [];
  const makeAdapter = (state) => ({
    identity: () => ({ providerSessionId: `sess-${state.runId.slice(0, 4)}` }),
    isAlive: () => true,
    async runTurn(prompt) { prompts.push({ runId: state.runId, prompt }); return { text: RESULT(), costUsd: 0.01 }; },
    async abort() {}, async dispose() {},
  });
  const runtime = new NativeLoopRuntime({
    stateDir: resolve(root, 'loop'), ledgerPath: resolve(root, 'runs.json'), buildPrompt: () => 'LOOP', iterationDelayMs: 0,
    providerFactories: { codex: async (s) => makeAdapter(s), 'claude-code': async (s) => makeAdapter(s), opencode: async (s) => makeAdapter(s) },
  });
  const catalog = realCatalog();
  const cards = [];
  const mailbox = [];
  const clarifier = createAssistantClarifier({
    getSession: (id) => (id === 'assistant-1' ? { lastPrompt: 'make the app nicer', cycle: 1 } : null),
    settings: () => ({ waitSeconds: 0 }),
    sinks: { sendCard: (sid, packet) => cards.push(packet), mailbox: (sid, item) => mailbox.push(item) },
  });
  const routeCards = [];
  let dispatcher = null;
  const router = createAssistantRouter({
    catalog, configStore: { routing: () => effectiveRouting({}), setPreference() {} },
    getSession: (id) => (id === 'assistant-1' ? { brain: { provider: 'claude-code', model: 'sonnet' }, routingMode: mode } : null),
    sinks: {
      sendCard: (sid, packet) => routeCards.push(packet), routeEvent() {}, mailbox() {}, cancelCard() {},
      startHeld: (runId, target, meta) => dispatcher.resolveRoute(runId, { target, ...meta }),
      declineHeld: (runId, reason) => dispatcher.declineRoute(runId, { reason }),
    },
    clarifier,
  });
  dispatcher = createAssistantDispatcher({
    getRuntime: () => runtime, dataDir: root, loopDir: resolve(root, 'loop'), PACKAGE_ROOT: root,
    getCodexAccount: () => ({ id: 'default', home: '/tmp/codex' }), findCodexAccount: () => null, CODEX_DEFAULT_HOME: '/tmp/codex',
    detectProject: () => 'proj', limits: { minIdleTimeoutMs: 50 }, router, catalog, clarifier,
  });
  t.after(() => { router.shutdown(); clarifier.shutdown(); dispatcher.shutdown('test'); });
  const promptOf = (runId) => waitFor(() => prompts.find((p) => p.runId === runId)?.prompt);
  return { dispatcher, router, clarifier, prompts, promptOf, cards, routeCards, mailbox };
}
const POLISH = {
  summary: 'Polish the UI',
  questions: [{ id: 'area', header: 'Area', question: 'Which part of the app?', options: [{ label: 'Settings page' }, { label: 'Whole app' }] }],
  constraints: ['No new dependencies'], assumptions: ['Keep the current palette'],
};

test('a dependent dispatch waits for the answers, then the worker gets the user\'s brief', async (t) => {
  const h = dispatchHarness(t);
  const asked = await h.clarifier.ask({ sessionId: 'assistant-1', body: POLISH });
  assert.equal(asked.status, 'pending');
  const spec = { provider: 'claude-code', model: 'sonnet', task: 'Polish the settings page', confidence: 0.9 };
  await assert.rejects(
    h.dispatcher.dispatch(spec, { assistantSessionId: 'assistant-1' }),
    (error) => error instanceof DispatchError && error.code === 'CLARIFICATION_PENDING' && error.status === 409 && error.briefId === asked.briefId,
  );
  assert.equal(h.prompts.length, 0, 'no worker started');
  assert.equal(h.routeCards.length, 0, 'no route card for work that has to wait');

  // Independent work and the user's own dispatches go ahead, without the brief.
  const independent = await h.dispatcher.dispatch({ ...spec, task: 'Fix the README typo', independent: true }, { assistantSessionId: 'assistant-1' });
  assert.equal(independent.run.briefId, null);
  assert.doesNotMatch(await h.promptOf(independent.run.runId), /USER BRIEF/);
  const fromUi = await h.dispatcher.dispatch({ ...spec, task: 'Run the linter' }, { assistantSessionId: 'assistant-1', origin: 'ui' });
  assert.doesNotMatch(await h.promptOf(fromUi.run.runId), /USER BRIEF/);

  // The user answers on the card: the dependent dispatch runs, with the brief.
  h.clarifier.answer(h.cards[0].request_id, { kind: 'clarify', behavior: 'allow', answers: [['Settings page']] });
  assert.equal(h.mailbox[0].kind, 'clarify_answered');
  const started = await h.dispatcher.dispatch({ ...spec, briefId: asked.briefId }, { assistantSessionId: 'assistant-1' });
  assert.equal(started.run.briefId, asked.briefId);
  assert.equal(started.run.brief, undefined, 'views name the brief, the prompt carries it');
  assert.ok(started.run.notes.some((note) => note.includes(asked.briefId)));
  const prompt = await h.promptOf(started.run.runId);
  assert.match(prompt, /TASK:\nPolish the settings page\n\nUSER BRIEF/);
  assert.match(prompt, /> make the app nicer/);
  assert.match(prompt, /- Area: Settings page \(asked: "Which part of the app\?"\)/);
  assert.match(prompt, /Constraints:\n- No new dependencies/);
  assert.match(prompt, /not confirmed by the user\):\n- Keep the current palette/);
  // Without brief_id, the answered brief of the same request applies too.
  const auto = await h.dispatcher.dispatch({ ...spec, task: 'Review the polish' }, { assistantSessionId: 'assistant-1' });
  assert.equal(auto.run.briefId, asked.briefId);
  await assert.rejects(
    h.dispatcher.dispatch({ ...spec, briefId: 'brief-unknown' }, { assistantSessionId: 'assistant-1' }),
    (error) => error.code === 'BRIEF_UNKNOWN' && error.status === 400,
  );
});

test('a run held for the model choice keeps the brief, and an escalation carries it on', async (t) => {
  const h = dispatchHarness(t, { mode: 'always-ask' });
  const asked = await h.clarifier.ask({ sessionId: 'assistant-1', body: POLISH });
  h.clarifier.answer(h.cards[0].request_id, { kind: 'clarify', behavior: 'allow', answers: [['Whole app']] });
  const held = await h.dispatcher.dispatch({ provider: 'claude-code', task: 'Polish the whole app', title: 'Polish' }, { assistantSessionId: 'assistant-1' });
  assert.equal(held.awaitingRoute, true);
  assert.equal(held.run.briefId, asked.briefId);
  await h.router.answer(h.routeCards[0].request_id, { optionId: h.routeCards[0].request.options[0].id });
  assert.match(await h.promptOf(held.run.runId), /- Area: Whole app/);
  const child = await h.dispatcher.escalate(held.run.runId, { target: { provider: 'codex', model: 'gpt-5.6-luna' } });
  assert.equal(child.run.briefId, asked.briefId);
  const childPrompt = await h.promptOf(child.run.runId);
  assert.match(childPrompt, /USER BRIEF/);
  assert.match(childPrompt, /- Area: Whole app/);
});

// ── The runtime ──────────────────────────────────────────────────────────────

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
  packets(type) { return this.sent.filter((p) => p.type === type); }
}
function fakeBrainFactory(log) {
  return ({ session, sink }) => {
    let busy = false;
    return {
      kind: session.brain.provider,
      async start() {},
      async sendUserTurn({ text }) {
        log.push(['turn', text]);
        busy = true;
        setTimeout(() => { busy = false; sink.send({ type: 'event', event: { type: 'result', subtype: 'success', result: 'ok' } }); sink.send({ type: 'done', code: 0 }); }, 5);
      },
      async abort() { busy = false; sink.send({ type: 'aborted' }); },
      respondControl(id, response) { log.push(['brain-control', id, response]); },
      isBusy: () => busy,
      identity: () => ({ providerSessionId: 'prov-1' }),
      async dispose() {},
    };
  };
}
function runtimeHarness(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-clarify-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = [];
  let runtime = null;
  // Wired like server.js: the clarifier reaches the runtime through its sinks.
  const clarifier = createAssistantClarifier({
    getSession: (id) => runtime?.clarifySession?.(id) || null,
    settings: () => ({ waitSeconds: 0 }),
    sinks: {
      sendCard: (sid, packet) => runtime.routerSend(sid, packet),
      cancelCard: (sid, requestId, reason) => runtime.routerSend(sid, { type: 'control_cancelled', request_id: requestId, reason }),
      event: (sid, phase, brief) => runtime.clarifyEvent(sid, phase, brief),
      mailbox: (sid, item) => runtime.routerMailbox(sid, item),
      gate: (sid, result) => runtime.clarifyGate(sid, result),
    },
  });
  const router = { owns: () => false, pendingCards: () => [], cancelForSession() {}, stamp: () => ({ text: '', changed: false, commit() {} }) };
  const factory = fakeBrainFactory(log);
  runtime = createAssistantRuntime({
    dataDir: root, detectProject: () => 'proj', buildCatalog: async () => ({ models: {} }),
    brainFactories: { 'claude-code': factory, codex: factory, opencode: factory }, config: { mailboxBatchMs: 20 },
    router, clarifier, configStore: { routing: () => ({ defaultMode: 'ask-unsure', askBelow: 0.75, preferences: {} }) },
  });
  t.after(() => { clarifier.shutdown(); return runtime.shutdown(); });
  return { runtime, clarifier, log };
}
async function attach(runtime, id) {
  const ws = new FakeWs();
  await runtime.handleWebSocket(ws, { pathname: `/ws/assistant/${id}` });
  return ws;
}
const send = (ws, message) => ws.emit('message', Buffer.from(JSON.stringify(message)));

test('runtime: questions hold the gate; the user\'s next message is their reply, marked for the brain', async (t) => {
  const { runtime, clarifier, log } = runtimeHarness(t);
  const session = await runtime.createSession({ brain: { provider: 'opencode', model: 'x' } });
  const ws = await attach(runtime, session.id);
  send(ws, { type: 'query', prompt: 'add dark mode' });
  await waitFor(() => log.some(([kind, text]) => kind === 'turn' && text.endsWith('add dark mode')));
  const asked = await clarifier.ask({ sessionId: session.id, body: BODY });
  assert.equal(asked.status, 'pending');
  const card = ws.packets('control_request').find((p) => p.request?.subtype === 'clarify');
  assert.ok(card, 'the panel got the clarify card');
  const live = runtime._internals.sessions.get(session.id);
  const refusal = runtime._internals.ensureGate(live).check('Bash');
  assert.equal(refusal.allow, false);
  assert.match(refusal.reason, /Waiting for the user's answers/);
  assert.match(runtime.getSession(session.id).persona, /## Clarify first, only when it matters/);

  await waitFor(() => !live.running);
  send(ws, { type: 'query', prompt: 'whole app, follow the OS' });
  const [, text] = await waitFor(() => log.find(([kind, value]) => kind === 'turn' && value.includes('whole app, follow the OS')));
  assert.match(text, /\[SynaBun Clarify\] The user's message below replies to your open questions[^\n]*\n\nwhole app, follow the OS$/);
  const chat = ws.packets('event').find((p) => p.event?.type === 'synabun.clarify' && p.event.phase === 'chat');
  assert.equal(chat.event.brief.round.requestId, card.request_id, 'the panel locks the card');
  const brief = clarifier.forDispatch(session.id, {});
  assert.equal(brief.request, 'add dark mode');
  assert.deepEqual(brief.replies, ['whole app, follow the OS']);
  const journal = runtime.getSession(session.id).transcript.map((entry) => entry.packet?.event).filter((ev) => ev?.type === 'synabun.clarify');
  assert.deepEqual(journal.map((ev) => ev.phase), ['chat'], 'the outcome is history; the card itself is not');
});

test('runtime: clarify answers go to the clarifier, the brain\'s own question answers join the brief, open cards replay', async (t) => {
  const { runtime, clarifier, log } = runtimeHarness(t);
  const session = await runtime.createSession({ brain: { provider: 'claude-code' } });
  const ws = await attach(runtime, session.id);
  send(ws, { type: 'query', prompt: 'build the api' });
  const live = runtime._internals.sessions.get(session.id);
  await waitFor(() => log.some(([kind]) => kind === 'turn') && !live.running);
  await clarifier.ask({ sessionId: session.id, body: { summary: 'Build the API', questions: [{ id: 'db', header: 'DB', question: 'Which database?', options: ['Postgres', 'SQLite'] }] } });
  const card = ws.packets('control_request').find((p) => p.request?.subtype === 'clarify');
  const second = await attach(runtime, session.id);
  assert.ok(second.packets('control_request').some((p) => p.request_id === card.request_id), 'a second window gets the open card');

  send(ws, { type: 'control_response', request_id: card.request_id, response: { kind: 'clarify', provider: 'synabun', behavior: 'allow', answers: [['Postgres']] } });
  const [, mailboxTurn] = await waitFor(() => log.find(([kind, text]) => kind === 'turn' && text.startsWith('[SynaBun Mailbox]')));
  assert.match(mailboxTurn, /clarify_answered · brief-\S+ \("Build the API"\)/);
  assert.match(mailboxTurn, /answers: DB: Postgres/);
  assert.equal(log.filter(([kind]) => kind === 'brain-control').length, 0, 'the brain never answers a clarify card');
  await waitFor(() => !live.running);

  // The brain asks with its own tool; the user's answer reaches the brain and the brief.
  runtime._internals.onBrainPacket(live, { type: 'control_request', request_id: 'toolu_9', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which auth?', header: 'Auth', options: [{ label: 'JWT' }, { label: 'Sessions' }] }] } } });
  assert.throws(() => clarifier.forDispatch(session.id, {}), (e) => e.code === 'CLARIFICATION_PENDING');
  send(ws, { type: 'control_response', request_id: 'toolu_9', response: { behavior: 'allow', updatedInput: { answers: { 'Which auth?': 'JWT' } } } });
  await waitFor(() => log.some(([kind, id]) => kind === 'brain-control' && id === 'toolu_9'));
  const brief = clarifier.forDispatch(session.id, {});
  assert.equal(brief.request, 'build the api');
  assert.deepEqual(brief.decisions.map((d) => `${d.header}=${d.answers[0]}`), ['DB=Postgres', 'Auth=JWT']);
});

// ── REST ─────────────────────────────────────────────────────────────────────

test('API: agent_clarify waits within the caller\'s deadline, answers are UI-only, a dispatch body never carries a brief', async (t) => {
  const asks = [];
  const clarifier = {
    ask: async (args) => { asks.push(args); return { ok: true, status: 'pending', briefId: 'brief-1', next: 'end your turn' }; },
    answer: (id, response, opts) => ({ ok: true, status: 'answered', id, response, opts }),
    get: (id) => (id === 'brief-1' ? { briefId: 'brief-1', status: 'pending' } : null),
    pendingCards: (id) => (id === 'assistant-1' ? [{ type: 'control_request', request_id: 'clarify-1' }] : []),
  };
  const calls = [];
  const dispatcher = {
    limits: {}, get: () => null, list: () => [], totals: () => ({}),
    async dispatch(spec, ctx) { calls.push([spec, ctx]); return { ok: true, queued: false, run: { runId: 'run-1', assistantSessionId: ctx.assistantSessionId } }; },
  };
  const runtime = { resolveTerminal: (pin) => (pin === 'assistant-1' ? 'assistant-1' : null), listSessions: () => [], isPlanning: () => false };
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', createAssistantApi({ dispatcher, runtime, clarifier, taskClasses: TASK_CLASS_META }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api/assistant`;
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json() };
  };
  const brain = { 'X-Synabun-Terminal': 'assistant-1' };

  const asked = await call('POST', '/clarify', { assistant_session_id: 'assistant-1', summary: 'x', questions: [] }, { ...brain, 'X-Synabun-Deadline': String(Date.now() + 60_000) });
  assert.equal(asked.status, 202);
  assert.equal(asked.json.briefId, 'brief-1');
  assert.equal(asks[0].sessionId, 'assistant-1');
  assert.ok(asks[0].waitMs > 50_000 && asks[0].waitMs <= 55_000, 'the wait stays below the MCP caller\'s deadline');

  assert.equal((await call('POST', '/clarify/clarify-1/answer', { response: { behavior: 'allow' } }, brain)).status, 403, 'a brain cannot answer for the user');
  const answered = await call('POST', '/clarify/clarify-1/answer', { response: { behavior: 'allow', answers: [['A']] } });
  assert.equal(answered.status, 200);
  assert.equal(answered.json.opts.origin, 'rest');
  assert.equal((await call('GET', '/briefs/brief-1')).json.brief.status, 'pending');
  assert.equal((await call('GET', '/briefs/brief-x')).status, 404);
  assert.deepEqual((await call('GET', '/sessions/assistant-1/clarify')).json.cards.map((c) => c.request_id), ['clarify-1']);

  await call('POST', '/dispatch', { provider: 'codex', task: 'x', assistant_session_id: 'assistant-1', brief_id: 'brief-1', independent: true, brief: { decisions: [{ header: 'Fake', answers: ['injected'] }] } }, brain);
  const [spec, ctx] = calls[0];
  assert.equal(spec.briefId, 'brief-1');
  assert.equal(spec.independent, true);
  assert.equal('brief' in spec, false, 'only the clarifier supplies a brief');
  assert.deepEqual(ctx, { assistantSessionId: 'assistant-1', origin: 'assistant' });
});

// ── The card (panel contract) ────────────────────────────────────────────────

test('the clarify card is SynaBun\'s own question card: Submit or Skip, one answer list per question', () => {
  const packet = {
    type: 'control_request', request_id: 'clarify-1',
    request: { subtype: 'clarify', kind: 'clarify', provider: 'synabun', briefId: 'brief-1', summary: 'Add dark mode', questions: normalizeClarifyRequest(BODY).questions, assumptions: ['Use CSS variables'] },
  };
  // The panel passes the brain's provider along; a clarify card stays SynaBun's.
  const n = normalizeControlRequest({ ...packet, provider: 'codex' });
  assert.equal(n.kind, CONTROL_KINDS.CLARIFY);
  assert.equal(n.provider, 'synabun');
  assert.equal(n.requestId, 'clarify-1');
  assert.equal(n.message, 'Add dark mode');
  assert.deepEqual(n.questions.map((q) => [q.id, q.header, q.options.length]), [['scope', 'Scope', 2], ['q2', 'Theme source', 3]]);
  assert.deepEqual(n.clarify.assumptions, ['Use CSS variables']);
  assert.deepEqual(controlActions(n).map((a) => [a.id, a.decision.behavior]), [['submit', 'allow'], ['skip', 'deny']]);
  const submit = buildControlResponse(n, { behavior: 'allow', answers: [['Whole app'], ['Both']] });
  assert.deepEqual(submit, { kind: 'clarify', provider: 'synabun', behavior: 'allow', answers: [['Whole app'], ['Both']] });
  const skip = buildControlResponse(n, { behavior: 'deny', message: 'your call' });
  assert.deepEqual(skip, { kind: 'clarify', provider: 'synabun', behavior: 'deny', message: 'your call' });
  // What the panel sends is what the clarifier reads.
  assert.deepEqual(answersFromResponse(normalizeClarifyRequest(BODY).questions, submit).answers.map((a) => a.answers), [['Whole app'], ['Both']]);
  assert.equal(answersFromResponse(normalizeClarifyRequest(BODY).questions, skip).declined, true);
});

// A document just big enough for renderControlCard (no DOM in node).
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    const classes = () => new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = {
      add: (c) => { const s = classes(); s.add(c); this.className = [...s].join(' '); },
      remove: (c) => { const s = classes(); s.delete(c); this.className = [...s].join(' '); },
      toggle: (c, on) => { if (on ?? !classes().has(c)) this.classList.add(c); else this.classList.remove(c); },
      contains: (c) => classes().has(c),
    };
  }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ key: '', preventDefault() {}, stopPropagation() {} }); }
  get all() { return [this, ...this.children.flatMap((child) => child.all)]; }
  querySelectorAll(selector) {
    const tags = selector.split(',').map((part) => part.trim().toUpperCase());
    return this.all.filter((node) => node !== this && tags.includes(node.tagName));
  }
  querySelector() { return null; }
}

test('the clarify card renders questions and assumptions; Submit waits for every answer, Skip skips', () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new FakeNode(tag) };
  try {
    const packet = {
      type: 'control_request', request_id: 'clarify-1',
      request: { subtype: 'clarify', provider: 'synabun', briefId: 'brief-1', summary: 'Add dark mode', questions: normalizeClarifyRequest(BODY).questions, assumptions: ['Use CSS variables', 'No new dependencies'] },
    };
    const decisions = [];
    const card = renderControlCard(null, normalizeControlRequest(packet), { onRespond: (n, decision) => decisions.push([n, decision]) });
    const nodes = () => card.el.all;
    const text = (node) => node.textContent;
    assert.equal(card.el.dataset.kind, 'clarify');
    assert.ok(nodes().some((node) => text(node) === 'Before I start'));
    assert.ok(nodes().some((node) => text(node) === 'Add dark mode'), 'the summary heads the card');
    assert.ok(nodes().some((node) => text(node) === 'Otherwise I\'ll assume: Use CSS variables · No new dependencies'));
    const submit = nodes().find((node) => node.dataset.action === 'submit');
    const skip = nodes().find((node) => node.dataset.action === 'skip');
    assert.match(skip.innerHTML, /Skip — go with the assumptions/);
    assert.equal(submit.disabled, true, 'nothing answered yet');
    const option = (label) => nodes().find((node) => node.dataset.label === label);
    option('Whole app').fire('click');
    assert.equal(submit.disabled, true, 'one of two answered');
    option('Both').fire('click');
    assert.equal(submit.disabled, false);
    submit.fire('click');
    const [n, decision] = decisions[0];
    assert.deepEqual(buildControlResponse(n, decision), { kind: 'clarify', provider: 'synabun', behavior: 'allow', answers: [['Whole app'], ['Both']] });
    assert.equal(card.resolved, true);
    assert.ok(nodes().some((node) => node.className === 'asst-control-status' && text(node) === 'Answered' && !node.hidden));

    const second = renderControlCard(null, normalizeControlRequest({ ...packet, request_id: 'clarify-2' }), { onRespond: (m, d) => decisions.push([m, d]) });
    second.el.all.find((node) => node.dataset.action === 'skip').fire('click');
    assert.equal(buildControlResponse(decisions[1][0], decisions[1][1]).behavior, 'deny');
    assert.ok(second.el.all.some((node) => node.className === 'asst-control-status' && node.textContent === 'Skipped'));
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
});

test('cancel: questions closed because the user wrote something else are cancelled, not declined: nothing starts on the assumptions', async () => {
  const h = harness({ waitSeconds: 0 });
  const result = await h.clarifier.ask({ sessionId: 'assistant-1', body: BODY });
  assert.equal(result.status, 'pending');
  const requestId = h.sent[0][1].request_id;
  const SID = { sessionId: 'assistant-1' };
  // Scoped to the session: another session can neither see the card nor close it, and a cancel names its session.
  assert.equal(h.clarifier.owns(requestId, 'assistant-1'), true);
  assert.equal(h.clarifier.owns(requestId, 'assistant-2'), false, 'not that session\'s card');
  assert.equal(h.clarifier.cancel(requestId, 'superseded', { sessionId: 'assistant-2' }), false, 'another session cannot cancel it');
  assert.equal(h.clarifier.cancel(requestId, 'superseded'), false, 'a cancel names its session');
  assert.throws(() => h.clarifier.answer(requestId, { behavior: 'deny' }, { origin: 'ui', sessionId: 'assistant-2' }), (e) => e.code === 'CLARIFY_NOT_FOUND', 'nor answer it');
  assert.equal(h.clarifier.pendingCards('assistant-1').length, 1, 'still open');
  assert.deepEqual(h.cancelled, []);
  assert.equal(h.clarifier.cancel(requestId, 'superseded', SID), true);
  assert.deepEqual(h.cancelled, [['assistant-1', requestId, 'superseded']], 'every host closes the card');
  assert.equal(h.events.at(-1)[1], 'cancelled');
  assert.equal(h.mailbox.length, 0, 'no clarify_declined event: the brain is not told to go ahead on its assumptions');
  assert.equal(h.clarifier.owns(requestId), false);
  assert.deepEqual(h.clarifier.pendingCards('assistant-1'), []);
  assert.equal(h.clarifier.blocking('assistant-1'), null, 'nothing waits any more');
  assert.equal(h.clarifier.cancel(requestId, 'superseded', SID), false, 'only an open card');
  assert.throws(() => h.clarifier.answer(requestId, { behavior: 'allow' }), (e) => e.code === 'CLARIFY_NOT_FOUND');
  // While agent_clarify still waits inside the turn: it returns "cancelled" (do not start the task).
  // (ask() sends its card and registers its wait before its first await: the cancel follows at once, no sleep.)
  const waiting = harness({ waitSeconds: 5 });
  const asking = waiting.clarifier.ask({ sessionId: 'assistant-1', body: BODY });
  assert.equal(waiting.sent.length, 1, 'the card is out and the call is waiting');
  assert.equal(waiting.clarifier.cancel(waiting.sent[0][1].request_id, 'superseded', SID), true);
  const settled = await asking;
  assert.equal(settled.status, 'cancelled');
  assert.match(settled.next, /Do not start the task/);
  assert.equal(waiting.mailbox.length, 0);
});

test('a clarify card a host closes while it is being sent is not waited on: the call returns "cancelled" at once, with no "card" event after it', async () => {
  const h = harness({ waitSeconds: 5 });
  h.hooks.onSend = (sid, packet) => { assert.equal(h.clarifier.cancel(packet.request_id, 'superseded', { sessionId: sid }), true); };
  // Macrotask turns, no clock: a call that is still pending after them is waiting on its 5 s timer.
  const turns = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); return 'still waiting'; };
  const result = await Promise.race([h.clarifier.ask({ sessionId: 'assistant-1', body: BODY }), turns()]);
  assert.notEqual(result, 'still waiting', 'no wait on a round that is already cancelled');
  assert.equal(result.status, 'cancelled');
  assert.match(result.next, /Do not start the task/);
  assert.deepEqual(h.events.map((row) => row[1]), ['cancelled'], 'no "card" event after the round closed');
  assert.deepEqual(h.clarifier.pendingCards('assistant-1'), []);
  assert.equal(h.clarifier.blocking('assistant-1'), null);
  assert.equal(h.mailbox.length, 0);
  assert.equal(h.gates.length, 0, 'the route gate is not told a round is pending');
});

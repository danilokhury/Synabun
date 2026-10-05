import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTROL_KINDS,
  buildControlResponse,
  controlActions,
  elicitationQuestions,
  isRouteControlPacket,
  normalizeAnswers,
  normalizeControlRequest,
  renderControlCard,
} from '../public/shared/assistant/asst-control.js';

// ── Claude ──────────────────────────────────────────────────────────────────

test('Claude Bash permission: normalize + allow with edited command round-trips', () => {
  const n = normalizeControlRequest({
    type: 'control_request',
    request_id: 'req-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'npm test', description: 'run tests' },
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], destination: 'localSettings' }],
    },
  });
  assert.equal(n.requestId, 'req-1');
  assert.equal(n.provider, 'claude-code');
  assert.equal(n.kind, CONTROL_KINDS.PERMISSION);
  assert.equal(n.toolName, 'Bash');
  assert.equal(n.detail, 'npm test');
  assert.equal(n.origin, null);
  assert.equal(n.suggestions.length, 1);

  const allow = buildControlResponse(n, { behavior: 'allow', updatedInput: { command: 'npm test -- --watch=false' } });
  assert.deepEqual(allow, {
    behavior: 'allow',
    provider: 'claude-code',
    kind: 'permission',
    always: false,
    updatedInput: { command: 'npm test -- --watch=false' },
  });

  const always = buildControlResponse(n, { behavior: 'allow', always: true, updatedPermissions: n.suggestions });
  assert.equal(always.always, true);
  assert.deepEqual(always.updatedPermissions, n.suggestions);

  const deny = buildControlResponse(n, { behavior: 'deny', message: 'not now' });
  assert.deepEqual(deny, { behavior: 'deny', provider: 'claude-code', kind: 'permission', message: 'not now' });
});

test('Claude AskUserQuestion: answers keyed by question text, raw questions echoed', () => {
  const rawQuestions = [
    { question: 'Which framework?', header: 'Framework', options: [{ label: 'React', description: 'ui' }, { label: 'Vue' }], multiSelect: false },
    { question: 'Features?', header: 'Features', options: [{ label: 'SSR' }, { label: 'PWA' }], multiSelect: true },
  ];
  const n = normalizeControlRequest({
    request_id: 7,
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: rawQuestions } },
  });
  assert.equal(n.requestId, '7');
  assert.equal(n.kind, CONTROL_KINDS.QUESTION);
  assert.equal(n.questions.length, 2);
  assert.equal(n.questions[1].multiple, true);
  assert.deepEqual(n.questions[0].options.map(o => o.label), ['React', 'Vue']);

  const res = buildControlResponse(n, { behavior: 'allow', answers: [['Vue'], ['SSR', 'PWA']] });
  assert.equal(res.behavior, 'allow');
  assert.deepEqual(res.updatedInput.questions, rawQuestions);
  assert.deepEqual(res.updatedInput.answers, { 'Which framework?': 'Vue', 'Features?': 'SSR, PWA' });

  // Object-form answers resolve by id/text/header too
  const byKey = normalizeAnswers(n, { 'Which framework?': 'React', Features: ['PWA'] });
  assert.deepEqual(byKey, [['React'], ['PWA']]);

  const declined = buildControlResponse(n, { behavior: 'deny' });
  assert.equal(declined.behavior, 'deny');
  assert.match(declined.message, /declined/i);
});

test('Claude ExitPlanMode: approve/approve-edits/keep-planning decisions', () => {
  const n = normalizeControlRequest({
    request_id: 'plan-1',
    request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '# Plan\n1. do it' } },
  });
  assert.equal(n.kind, CONTROL_KINDS.PLAN);
  assert.equal(n.plan, '# Plan\n1. do it');
  assert.deepEqual(controlActions(n).map(a => a.id), ['approve-edits', 'approve', 'keep']);

  assert.deepEqual(buildControlResponse(n, { behavior: 'allow', planDecision: 'acceptEdits' }),
    { behavior: 'allow', provider: 'claude-code', kind: 'plan', planDecision: 'acceptEdits' });
  assert.equal(buildControlResponse(n, { behavior: 'allow' }).planDecision, 'default');
  const keep = buildControlResponse(n, { behavior: 'deny', message: 'add tests' });
  assert.equal(keep.behavior, 'deny');
  assert.equal(keep.message, 'add tests');
});

// ── Codex ───────────────────────────────────────────────────────────────────

test('Codex command approval: decision picked from availableDecisions', () => {
  const n = normalizeControlRequest({
    request_id: 42,
    provider: 'codex',
    request: {
      method: 'item/commandExecution/requestApproval',
      params: { command: 'rm -rf build', reason: 'clean', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] },
    },
  });
  assert.equal(n.provider, 'codex');
  assert.equal(n.kind, CONTROL_KINDS.PERMISSION);
  assert.equal(n.toolName, 'Bash');
  assert.equal(n.detail, 'rm -rf build');
  assert.equal(n.message, 'clean');
  assert.equal(n.method, 'item/commandExecution/requestApproval');

  const allow = buildControlResponse(n, { behavior: 'allow' });
  assert.equal(allow.behavior, 'allow');
  assert.equal(allow.decision, 'accept');
  assert.deepEqual(allow.result, { decision: 'accept' });

  const always = buildControlResponse(n, { behavior: 'allow', always: true });
  assert.equal(always.decision, 'acceptForSession');

  const deny = buildControlResponse(n, { behavior: 'deny' });
  assert.equal(deny.behavior, 'deny');
  assert.deepEqual(deny.result, { decision: 'decline' });

  const cancel = buildControlResponse(n, { behavior: 'deny', decisionId: 'cancel' });
  assert.deepEqual(cancel.result, { decision: 'cancel' });

  // Object-shaped decisions (execpolicy amendment) survive verbatim
  const amend = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm', '-rf'] } };
  const n2 = normalizeControlRequest({ request_id: 43, provider: 'codex', request: { method: 'item/commandExecution/requestApproval', params: { command: 'x', availableDecisions: ['accept', amend, 'decline'] } } });
  const amended = buildControlResponse(n2, { behavior: 'allow', always: true });
  assert.equal(amended.decision, 'acceptWithExecpolicyAmendment');
  assert.deepEqual(amended.result.decision, amend);
});

test('Codex provider is inferred from a slash method when not explicit', () => {
  const n = normalizeControlRequest({ request_id: 1, request: { method: 'item/fileChange/requestApproval', params: { grantRoot: '/repo', itemId: 'f1' } } });
  assert.equal(n.provider, 'codex');
  assert.equal(n.toolName, 'Edit');
  assert.match(n.detail, /root \/repo/);
});

test('Codex requestUserInput: answers keyed by question id', () => {
  const n = normalizeControlRequest({
    request_id: 'ui-1',
    provider: 'codex',
    request: { method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q1', question: 'Branch name?', options: [{ label: 'main' }, { label: 'dev' }] }, { id: 'q2', question: 'Notes?' }] } },
  });
  assert.equal(n.kind, CONTROL_KINDS.QUESTION);
  assert.equal(n.questions[0].id, 'q1');
  assert.equal(n.questions[1].options.length, 0);

  const res = buildControlResponse(n, { behavior: 'allow', answers: [['dev'], ['ship it']] });
  assert.equal(res.behavior, 'allow');
  assert.deepEqual(res.result, { answers: { q1: { answers: ['dev'] }, q2: { answers: ['ship it'] } } });

  const deny = buildControlResponse(n, { behavior: 'deny' });
  assert.equal(deny.behavior, 'deny');
  assert.equal(deny.error.code, -1);
});

test('Codex permissions grant + MCP elicitation shapes', () => {
  const grant = normalizeControlRequest({ request_id: 'g1', provider: 'codex', request: { method: 'item/permissions/requestApproval', params: { permissions: { network: true }, reason: 'fetch' } } });
  const ok = buildControlResponse(grant, { behavior: 'allow' });
  assert.deepEqual(ok.result, { permissions: { network: true }, scope: 'session' });
  const no = buildControlResponse(grant, { behavior: 'deny' });
  assert.deepEqual(no.result, { permissions: {}, scope: 'turn' });

  const elicit = normalizeControlRequest({ request_id: 'e1', provider: 'codex', request: { method: 'mcpServer/elicitation/request', params: { serverName: 'SynaBun', message: 'Pick one', requestedSchema: { properties: { choice: { title: 'Choice', enum: ['a', 'b'] } } } } } });
  assert.equal(elicit.kind, CONTROL_KINDS.ELICITATION);
  assert.equal(elicit.questions[0].id, 'choice');
  const answered = buildControlResponse(elicit, { behavior: 'allow', answers: [['b']] });
  assert.deepEqual(answered.result, { action: 'accept', content: { choice: 'b' }, _meta: {} });
  assert.equal(buildControlResponse(elicit, { behavior: 'deny' }).result.action, 'decline');
});

// ── OpenCode ────────────────────────────────────────────────────────────────

test('OpenCode permission: once / always / reject', () => {
  const n = normalizeControlRequest({
    request_id: 'perm-1',
    provider: 'opencode',
    request: { kind: 'permission', permission: { permission: 'bash', patterns: ['rm *'], metadata: { command: 'rm -rf dist' }, title: 'Run command' } },
  });
  assert.equal(n.provider, 'opencode');
  assert.equal(n.kind, CONTROL_KINDS.PERMISSION);
  assert.equal(n.toolName, 'bash');
  assert.equal(n.detail, 'rm -rf dist');
  assert.deepEqual(n.patterns, ['rm *']);

  assert.deepEqual(buildControlResponse(n, { behavior: 'allow' }), { behavior: 'allow', provider: 'opencode', kind: 'permission', reply: 'once' });
  assert.equal(buildControlResponse(n, { behavior: 'allow', always: true }).reply, 'always');
  assert.equal(buildControlResponse(n, { behavior: 'deny' }).reply, 'reject');
});

test('OpenCode question: answers as string[][] and reject', () => {
  const n = normalizeControlRequest({
    request_id: 'q-1',
    request: { type: 'question.asked', questions: [{ question: 'Deploy where?', options: ['staging', 'prod'], multiple: true }] },
  });
  assert.equal(n.provider, 'opencode');
  assert.equal(n.kind, CONTROL_KINDS.QUESTION);
  assert.equal(n.questions[0].multiple, true);

  const res = buildControlResponse(n, { behavior: 'allow', answers: [['staging', 'prod']] });
  assert.deepEqual(res, { behavior: 'allow', provider: 'opencode', kind: 'question', answers: [['staging', 'prod']] });
  assert.equal(buildControlResponse(n, { behavior: 'deny' }).reject, true);
});

// ── Relayed dispatch requests ──────────────────────────────────────────────

test('relayed dispatch requests carry an origin { runId, provider }', () => {
  const n = normalizeControlRequest(
    { request_id: 'r-9', request: { subtype: 'can_use_tool', tool_name: 'Edit', input: { file_path: '/a/b.js' } }, runId: 'run-77', provider: 'claude-code' },
    { origin: { runId: 'run-77', provider: 'claude-code' } },
  );
  assert.deepEqual(n.origin, { runId: 'run-77', provider: 'claude-code' });
  assert.equal(n.detail, '/a/b.js');
  const implicit = normalizeControlRequest({ request_id: 'r-10', runId: 'run-78', request: { method: 'item/commandExecution/requestApproval', params: { command: 'ls' } } });
  assert.deepEqual(implicit.origin, { runId: 'run-78', provider: 'codex' });
});

test('invalid packets normalize to null', () => {
  assert.equal(normalizeControlRequest(null), null);
  assert.equal(normalizeControlRequest({}), null);
  assert.equal(normalizeControlRequest({ request: { tool_name: 'Bash' } }), null);
  assert.equal(buildControlResponse(null, { behavior: 'allow' }), null);
});

// ── Server packet shapes (assistant-envelope / dispatch relay) ─────────────

test('Claude relayed question: toolName (camelCase) + top-level questions → QUESTION card, round trip', () => {
  // The dispatch broker relays { requestId, kind, toolName, input, questions } with no request_id at the top.
  const questions = [{ question: 'Which DB?', header: 'DB', options: [{ label: 'sqlite' }, { label: 'postgres' }] }];
  const n = normalizeControlRequest(
    { request_id: 'perm-1a2b', provider: 'claude-code', runId: 'run-5', request: { requestId: 'perm-1a2b', kind: 'question', toolName: 'AskUserQuestion', input: { questions }, questions } },
    { origin: { runId: 'run-5', provider: 'claude-code' } },
  );
  assert.equal(n.kind, CONTROL_KINDS.QUESTION);
  assert.equal(n.provider, 'claude-code');
  assert.equal(n.toolName, 'AskUserQuestion');
  assert.deepEqual(n.questions.map(q => q.text), ['Which DB?']);
  const res = buildControlResponse(n, { behavior: 'allow', answers: [['postgres']] });
  // The native relay reads reply.answers || reply.updatedInput.answers.
  assert.deepEqual(res.updatedInput.answers, { 'Which DB?': 'postgres' });
  assert.deepEqual(res.updatedInput.questions, questions);

  // kind:'question' alone (no toolName) is still a question; a relayed permission keeps its tool.
  assert.equal(normalizeControlRequest({ request_id: 'q', provider: 'claude-code', request: { kind: 'question', questions } }).kind, CONTROL_KINDS.QUESTION);
  const perm = normalizeControlRequest({ request_id: 'p', provider: 'claude-code', request: { requestId: 'p', kind: 'permission', toolName: 'Bash', input: { command: 'ls -la' } } });
  assert.equal(perm.kind, CONTROL_KINDS.PERMISSION);
  assert.equal(perm.toolName, 'Bash');
  assert.equal(perm.detail, 'ls -la');
});

test('Codex brain packet: method + brain_native.params (availableDecisions), top-level answers', () => {
  const packet = {
    request_id: '17',
    request: {
      subtype: 'can_use_tool', provider: 'codex', kind: 'permission', method: 'item/commandExecution/requestApproval', tool_name: 'Bash',
      input: { command: 'npm publish', cwd: '/repo', reason: 'release' },
      brain_native: { method: 'item/commandExecution/requestApproval', params: { command: 'npm publish', reason: 'release', availableDecisions: ['accept', 'decline'] } },
    },
  };
  const n = normalizeControlRequest(packet);
  assert.equal(n.provider, 'codex');
  assert.deepEqual(n.decisions, ['accept', 'decline']);
  assert.equal(n.detail, 'npm publish');
  assert.deepEqual(controlActions(n).map(a => a.id), ['allow', 'deny'], 'no "Always" without a session decision');

  const input = normalizeControlRequest({
    request_id: '18',
    request: { subtype: 'can_use_tool', provider: 'codex', kind: 'question', method: 'item/tool/requestUserInput', tool_name: 'AskUserQuestion', input: { questions: [{ id: 'branch', question: 'Branch?', options: [{ label: 'main' }] }] } },
  });
  const res = buildControlResponse(input, { behavior: 'allow', answers: [['release/2.0']] });
  assert.deepEqual(res.result, { answers: { branch: { answers: ['release/2.0'] } } });
  assert.deepEqual(res.answers, { branch: { answers: ['release/2.0'] } }, 'codexControlResponse reads response.answers');
});

test('Codex elicitation: oneOf/anyOf consts, enumNames, multi-select arrays, __other fields and free text', () => {
  const schema = {
    properties: {
      env: { title: 'Environment', oneOf: [{ const: 'stg', title: 'Staging' }, { const: 'prd', title: 'Production' }] },
      env__other: { type: 'string' },
      size: { type: 'string', enum: ['s', 'm'], enumNames: ['Small', 'Medium'] },
      tags: { type: 'array', items: { anyOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }] } },
      count: { type: 'integer', title: 'Count' },
      confirm: { type: 'boolean', title: 'Confirm' },
    },
    required: ['env', 'size'],
  };
  const qs = elicitationQuestions(schema);
  assert.deepEqual(qs.map(q => q.id), ['env', 'size', 'tags', 'count', 'confirm'], '__other companions are not questions');
  assert.deepEqual(qs[0].options.map(o => [o.label, o.value]), [['Staging', 'stg'], ['Production', 'prd']]);
  assert.equal(qs[0].otherField, 'env__other');
  assert.deepEqual(qs[1].options.map(o => o.label), ['Small', 'Medium']);
  assert.equal(qs[2].multiple, true);
  assert.equal(qs[3].options.length, 0);
  assert.deepEqual(qs.map(q => q.required), [true, true, false, false, false]);

  const n = normalizeControlRequest({ request_id: 'e2', provider: 'codex', request: { method: 'mcpServer/elicitation/request', params: { serverName: 'deploy', message: 'Pick', requestedSchema: schema } } });
  assert.equal(n.kind, CONTROL_KINDS.ELICITATION);
  const res = buildControlResponse(n, { behavior: 'allow', answers: [['Production'], ['Medium'], ['Alpha', 'Beta'], ['3'], ['Yes']] });
  assert.deepEqual(res.result.content, { env: 'prd', size: 'm', tags: ['a', 'b'], count: 3, confirm: true });
  assert.deepEqual(res.content, res.result.content, 'top-level content for the server translator');
  assert.deepEqual(res.answers, res.result.content);
  // A typed answer on an enum question with an __other companion.
  const custom = buildControlResponse(n, { behavior: 'allow', answers: [['canary'], ['Small']] });
  assert.deepEqual(custom.content, { env: '__synabun_other__', env__other: 'canary', size: 's' });
});

test('Codex SynaBun choice marker decodes into questions and never shows the raw marker', () => {
  const meta = { questions: [{ id: 'q1', header: 'Deploy', question: 'Where to?', options: [{ label: 'staging', description: 'safe' }, { label: 'prod' }] }] };
  const params = {
    serverName: 'SynaBun',
    message: `[SYNABUN_CHOICE_V1]${JSON.stringify(meta)}`,
    requestedSchema: { properties: { q1: { type: 'string', enum: ['staging', 'prod', '__synabun_other__'] }, q1__other: { type: 'string' } } },
  };
  const n = normalizeControlRequest({ request_id: 'c1', provider: 'codex', request: { method: 'mcpServer/elicitation/request', input: params } });
  assert.equal(n.kind, CONTROL_KINDS.ELICITATION);
  assert.equal(n.message, '', 'marker JSON is not printed');
  assert.ok(n.synabunChoice);
  assert.deepEqual(n.questions.map(q => q.text), ['Where to?']);
  assert.deepEqual(n.questions[0].options.map(o => o.label), ['staging', 'prod']);
  assert.deepEqual(buildControlResponse(n, { behavior: 'allow', answers: [['prod']] }).content, { q1: 'prod' });
  assert.deepEqual(buildControlResponse(n, { behavior: 'allow', answers: [['blue/green']] }).content, { q1: '__synabun_other__', q1__other: 'blue/green' });
  // Unparseable marker: still never printed.
  const broken = normalizeControlRequest({ request_id: 'c2', provider: 'codex', request: { method: 'mcpServer/elicitation/request', params: { message: '[SYNABUN_CHOICE_V1]{nope', requestedSchema: {} } } });
  assert.equal(broken.message, '');
});

test('OpenCode brain packets: questions under input, permission detail from input + tool_name, top-level always', () => {
  const q = normalizeControlRequest({
    request_id: 'oq1',
    request: { subtype: 'can_use_tool', provider: 'opencode', kind: 'question', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Proceed?', options: ['yes', 'no'] }] } },
  });
  assert.equal(q.kind, CONTROL_KINDS.QUESTION);
  assert.deepEqual(q.questions[0].options.map(o => o.label), ['yes', 'no']);
  // Nested { question: { questions } } too.
  assert.equal(normalizeControlRequest({ request_id: 'oq2', provider: 'opencode', request: { question: { questions: [{ question: 'A?' }] } } }).questions[0].text, 'A?');

  const p = normalizeControlRequest({
    request_id: 'op1',
    request: { subtype: 'can_use_tool', provider: 'opencode', kind: 'permission', tool_name: 'bash', input: { title: 'Run tests', patterns: ['npm *'], metadata: { command: 'npm test' }, always: ['npm *'] } },
  });
  assert.equal(p.kind, CONTROL_KINDS.PERMISSION);
  assert.equal(p.toolName, 'bash');
  assert.equal(p.detail, 'npm test');
  assert.deepEqual(p.patterns, ['npm *']);
  assert.equal(p.message, 'Run tests');
  const always = buildControlResponse(p, { behavior: 'allow', always: true });
  assert.equal(always.reply, 'always');
  assert.equal(always.always, true, 'the dispatch relay reads reply.always');
  assert.equal(buildControlResponse(p, { behavior: 'allow' }).always, undefined);

  // Relayed OpenCode permission (native event under input) keeps its detail.
  const relay = normalizeControlRequest({ request_id: 'op2', provider: 'opencode', request: { requestId: 'op2', kind: 'permission', toolName: 'edit', input: { id: 'x', permission: 'edit', patterns: ['src/**'], metadata: { filepath: '/repo/src/a.ts' }, title: 'Edit file' } } });
  assert.equal(relay.toolName, 'edit');
  assert.equal(relay.detail, '/repo/src/a.ts');
});

test('route requests go to the route card, never the generic card', () => {
  const packet = { type: 'control_request', request_id: 'route-9', request: { subtype: 'route', kind: 'route', provider: 'synabun', routeId: 'route-9', options: [] } };
  assert.equal(isRouteControlPacket(packet), true);
  assert.equal(isRouteControlPacket({ request_id: 'x', request: { subtype: 'can_use_tool', tool_name: 'Bash' } }), false);
  const n = normalizeControlRequest(packet);
  assert.equal(n.kind, CONTROL_KINDS.ROUTE);
  assert.equal(n.provider, 'synabun');
  assert.deepEqual(controlActions(n), []);
  assert.equal(buildControlResponse(n, { behavior: 'allow' }), null);
  // No DOM in node: reaching the generic path would throw on `document`.
  const calls = [];
  const entry = renderControlCard(null, n, { renderRoute: (container, normalized) => { calls.push(normalized.requestId); return { el: 'route-card', lock() {} }; } });
  assert.deepEqual(calls, ['route-9']);
  assert.equal(entry.el, 'route-card');
  assert.equal(renderControlCard(null, n, {}), null, 'no hook → nothing rendered, never a generic card');
});

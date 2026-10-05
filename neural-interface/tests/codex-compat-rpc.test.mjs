import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { CodexCapabilityRegistry, classifyCodexRpcError, validateCodexConfigRequirements } from '../lib/codex-capabilities.js';
import { buildCodexCompatParams, buildCodexReviewTarget, codexPagination, handleCodexCompatMessage, listCodexPages, validateCodexServerResponse } from '../lib/codex-compat-rpc.js';

const contracts = JSON.parse(readFileSync(new URL('./fixtures/codex-app-server-0.160.0.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, validateFormats: false });
const validators = Object.fromEntries(Object.entries(contracts.methods).map(([method, value]) => [method, ajv.compile({ ...value.params, definitions: contracts.definitions })]));

test('native compatibility requests validate against schemas emitted by the tested global CLI', () => {
  const messages = [
    ['background_list', { cursor: 'page-2', limit: 30 }],
    ['background_terminate', { processId: '12' }], ['background_clean', {}],
    ['goal_get', {}], ['goal_set', { objective: 'Finish review', tokenBudget: 10000 }],
    ['goal_set', { status: 'paused' }], ['goal_clear', {}],
    ['hooks_list', {}], ['skills_config_write', { path: '/tmp/skill/SKILL.md', enabled: false }],
    ['skills_config_write', { name: 'my-skill', enabled: true }],
    ['app_read', { appIds: ['app-1', 'app-1'], includeTools: true }],
    ['experimental_features_set', { enablement: { apps: true } }],
    ['feedback_upload', { classification: 'bug', reason: 'Feedback', includeLogs: false }],
    ['thread_settings_update', { model: 'future-model', effort: 'ultra', serviceTier: null, summary: 'auto', personality: 'pragmatic' }],
    ['collaboration_modes', {}], ['attachment_list', {}],
    ['attachment_remove', { attachmentType: 'note', identityKey: 'context' }], ['memory_status', {}],
    ['thread_settings_update', { disabledPluginIds: ['plugin-a'] }],
  ];
  const registry = new CodexCapabilityRegistry({ cliVersion: contracts.cliVersion });
  for (const [type, fields] of messages) {
    const params = buildCodexCompatParams({ type, ...fields }, { activeThreadId: 'thread-a', cwd: '/tmp' });
    const validate = validators[registry.snapshot()[type].method];
    assert.equal(validate(params), true, `${type}: ${JSON.stringify(validate.errors)}`);
  }
});

test('review target options follow the native contract and require their identifying fields', () => {
  for (const target of [{ type: 'uncommittedChanges' }, { type: 'baseBranch', branch: 'main' }, { type: 'commit', sha: 'abc' }, { type: 'custom', instructions: 'Check accessibility' }]) {
    assert.equal(validators['review/start']({ threadId: 'thread-a', delivery: 'inline', target: buildCodexReviewTarget(target) }), true);
  }
  assert.throws(() => buildCodexReviewTarget({ type: 'commit' }), /Commit is required/);
  assert.throws(() => buildCodexReviewTarget({ type: 'custom', instructions: ' ' }), /instructions is required/);
});

test('pagination preserves cursors and refuses malformed page requests', () => {
  assert.deepEqual(codexPagination({ cursor: 'opaque', limit: 20 }), { cursor: 'opaque', limit: 20 });
  assert.throws(() => codexPagination({ limit: 1.5 }), /Page size/);
  assert.throws(() => codexPagination({ cursor: {} }), /cursor/);
});

test('schema methods are available on older CLIs until an explicit unsupported failure', () => {
  const registry = new CodexCapabilityRegistry({ cliVersion: '0.121.0' });
  assert.equal(registry.snapshot().background_list.supported, true);
  assert.equal(registry.snapshot().review_start.supported, true);
  registry.observe('thread/backgroundTerminals/list');
  assert.equal(registry.snapshot().background_list.supported, true);
  registry.observe('thread/backgroundTerminals/list', { code: -32600, message: 'Invalid request: unknown variant `thread/backgroundTerminals/list`, expected one of `initialize`' });
  assert.equal(registry.snapshot().background_list.supported, false);
  assert.equal(registry.snapshot().review_start.supported, true);
  registry.reset({ cliVersion: '0.153.4' });
  assert.equal(registry.snapshot().background_list.supported, true);
  assert.equal(registry.snapshot().background_list.experimental, true);
});

test('runtime restrictions, auth, and transient failures are not mistaken for unsupported methods', () => {
  const registry = new CodexCapabilityRegistry({ cliVersion: '0.153.4' });
  for (const [message, category] of [['Authentication required', 'authentication'], ['Restricted by managed requirements', 'restricted'], ['Timed out waiting for Codex', 'transient']]) {
    assert.equal(classifyCodexRpcError({ message }).category, category);
    registry.observe('thread/backgroundTerminals/list', { message });
    assert.equal(registry.snapshot().background_list.supported, true);
  }
  registry.observe('plugin/list');
  assert.equal(registry.snapshot().plugin_list.supported, false);
  assert.match(registry.snapshot().plugin_list.reason, /under development/);
  registry.updateRequirements({ requirements: { feedback: { enabled: false } } });
  assert.equal(registry.snapshot().feedback_upload.supported, false);
});

test('managed settings and current web-search enums are enforced without rewriting unknown values', () => {
  const requirement = { requirements: { allowedApprovalPolicies: ['on-request'], allowedWebSearchModes: ['disabled', 'cached'], featureRequirements: { apps: false } } };
  assert.throws(() => validateCodexConfigRequirements({ approval_policy: 'never' }, requirement), /managed requirements/);
  assert.throws(() => validateCodexConfigRequirements({ features: { apps: true } }, requirement), /managed requirements/);
  assert.throws(() => validateCodexConfigRequirements({ web_search: 'live' }, requirement), /managed requirements/);
  assert.throws(() => validateCodexConfigRequirements({ web_search: false }, {}), /web_search must/);
  for (const mode of contracts.configEnums.WebSearchMode.enum) assert.equal(validateCodexConfigRequirements({ web_search: mode }, {}).web_search, mode);
  assert.equal(validateCodexConfigRequirements({ service_tier: 'future-tier' }, {}).service_tier, 'future-tier');
});

function context() {
  const calls = [], packets = [], writers = [];
  const registry = new CodexCapabilityRegistry({ cliVersion: '0.153.4' });
  return { calls, packets, writers, registry, activeThreadId: 'thread-a', cwd: '/tmp',
    ensureInitialized: async () => {}, capabilities: () => ({ capabilities: registry.snapshot(), runtime: registry.runtime }),
    request: async (method, params) => { calls.push([method, params]); return { data: [{ processId: 'process-1' }], nextCursor: 'next' }; },
    send: packet => packets.push(packet), withWriterOperation: async (type, operation) => { writers.push(type); return operation(); },
  };
}

test('native process list preserves the result and process termination respects thread ownership', async () => {
  const ctx = context();
  await handleCodexCompatMessage({ type: 'background_list', requestId: 'list-1' }, ctx);
  assert.deepEqual(ctx.calls[0], ['thread/backgroundTerminals/list', { threadId: 'thread-a', cursor: null, limit: 100 }]);
  assert.equal(ctx.packets[0].terminals.nextCursor, 'next');
  assert.equal(ctx.packets[0].requestId, 'list-1');
  await handleCodexCompatMessage({ type: 'background_terminate', threadId: 'thread-b', processId: 'process-1' }, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.packets[1].category, 'invalid_request');
  await handleCodexCompatMessage({ type: 'background_terminate', processId: 'process-1' }, ctx);
  assert.deepEqual(ctx.writers, ['background_terminate']);
});

test('unsupported plugin calls never invoke RPC and unsupported methods retain request correlation', async () => {
  const ctx = context();
  await handleCodexCompatMessage({ type: 'plugin_list', requestId: 'plugin-1' }, ctx);
  assert.equal(ctx.calls.length, 0);
  assert.equal(ctx.packets[0].category, 'unsupported');
  assert.equal(ctx.packets[0].requestId, 'plugin-1');
  ctx.request = async () => { const error = new Error('Invalid request: unknown variant `thread/goal/get`, expected one of `initialize`'); error.code = -32600; throw error; };
  await handleCodexCompatMessage({ type: 'goal_get', requestId: 'goal-1' }, ctx);
  assert.equal(ctx.packets[1].category, 'unsupported');
  assert.equal(ctx.packets[1].requestId, 'goal-1');
});

test('feedback does not include logs by default or accept arbitrary extra log paths', () => {
  const params = buildCodexCompatParams({ type: 'feedback_upload', classification: 'bug', extraLogFiles: ['/private/file'] });
  assert.equal(params.includeLogs, false);
  assert.equal('extraLogFiles' in params, false);
  assert.equal(buildCodexCompatParams({ type: 'feedback_upload', classification: 'bug', threadId: null }, { activeThreadId: 'private-thread' }).threadId, null);
});

test('session changes wait for the active turn and preserve explicit null service tier', async () => {
  const ctx = context();
  ctx.activeTurnId = 'turn-1';
  await handleCodexCompatMessage({ type: 'thread_settings_update', serviceTier: null }, ctx);
  assert.equal(ctx.calls.length, 0);
  ctx.activeTurnId = null;
  await handleCodexCompatMessage({ type: 'thread_settings_update', serviceTier: null }, ctx);
  assert.deepEqual(ctx.calls[0][1], { threadId: 'thread-a', serviceTier: null });
  assert.deepEqual(ctx.packets[1].overrides, { threadId: 'thread-a', serviceTier: null });
});

test('model catalogs collect all pages and detect a broken repeating cursor', async () => {
  const calls = [];
  const result = await listCodexPages(async (_method, params) => {
    calls.push(params.cursor);
    return params.cursor ? { data: [{ id: 'model-2' }], nextCursor: null } : { data: [{ id: 'model-1' }], nextCursor: 'next' };
  }, 'model/list', { includeHidden: false });
  assert.deepEqual(result.data.map(model => model.id), ['model-1', 'model-2']);
  assert.deepEqual(calls, [null, 'next']);
  await assert.rejects(listCodexPages(async () => ({ data: [], nextCursor: 'loop' }), 'model/list'), /repeated/);
});

test('approval replies honor advertised decisions and unknown methods cannot return fabricated success', () => {
  const decision = { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'allow' } } };
  const params = { availableDecisions: ['decline', decision] };
  assert.deepEqual(validateCodexServerResponse('item/commandExecution/requestApproval', params, { decision }), { decision });
  assert.throws(() => validateCodexServerResponse('item/commandExecution/requestApproval', params, { decision: 'acceptForSession' }), /not advertised/);
  assert.throws(() => validateCodexServerResponse('unknown/newRequest', {}, {}), /Unsupported request/);
  assert.throws(() => validateCodexServerResponse('item/tool/requestUserInput', { questions: [{ id: 'q' }] }, { answers: {} }), /Missing answer/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import Ajv from 'ajv';
import { CODEX_CAPABILITY_METHODS, CODEX_PROTOCOL_BASELINE } from '../lib/codex-capabilities.js';
import { automaticCodexServerReply, buildCodexCompatParams, handleCodexCompatMessage } from '../lib/codex-compat-rpc.js';
import { CodexCapabilityRegistry, classifyCodexRpcError, isCodexUnsupportedMethod } from '../lib/codex-capabilities.js';
import { revertCodexThreadHistory } from '../lib/codex-thread-history.js';
import { applyCodexThreadSettings, codexGenericCardHead, codexNotificationItem, codexReadableValue, codexTranscriptPresentation, codexRateLimitMetadata, codexModelAccessMetadata, codexSocketMessageRejectionReason, registerOwnedThreadFromItem } from '../public/shared/cdx/cdx-protocol.js';
import { contractShape, diffCodexProtocolFixtures } from '../scripts/codex-protocol-fixture.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/codex-app-server-0.160.0.json', import.meta.url)));
const ajv = new Ajv({ strict: false, validateFormats: false });
const validate = (name, value) => {
  const validator = ajv.compile({ ...fixture.definitions[name], definitions: fixture.definitions });
  assert.equal(validator(value), true, JSON.stringify(validator.errors));
};

test('native unknown-variant errors disable only the affected method and have short messages', () => {
  const method = 'thread/attachment/list';
  const error = { code: -32600, message: `Invalid request: unknown variant \`${method}\`, expected one of ${'initialize, '.repeat(400)}` };
  const registry = new CodexCapabilityRegistry();
  assert.equal(isCodexUnsupportedMethod(error), true);
  assert.deepEqual(classifyCodexRpcError(error), { code: -32600, category: 'unsupported', message: `The installed Codex CLI does not support ${method}` });
  assert.equal(registry.observe(method, error), true);
  assert.equal(registry.observe(method, error), false);
  assert.equal(registry.snapshot().attachment_list.supported, false);
  assert.equal(registry.snapshot().attachment_list.reason, `The installed Codex CLI does not support ${method}`);
  assert.equal(registry.snapshot().attachment_remove.supported, true);
  assert.equal(isCodexUnsupportedMethod({ code: -32600, message: 'Invalid request: missing field threadId' }), false);
  assert.equal(isCodexUnsupportedMethod({ code: -32000, message: 'unknown variant' }), false);
  assert.equal(isCodexUnsupportedMethod({ code: -32601, message: 'Method not found' }), true);
});

test('bridge keeps native errors for fallbacks and shortens unknown-variant errors at the client boundary', async () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const block = (start, end) => {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return source.slice(from, to);
  };
  const packets = [];
  const error = Object.assign(new Error('Invalid request: unknown variant `configRequirements/read`, expected one of `initialize`'), { code: -32600 });
  const context = vm.createContext({
    isCodexUnsupportedMethod, classifyCodexRpcError, codexCapabilities: new CodexCapabilityRegistry(),
    request: async () => { throw error; },
    wsSessionId: 's', wsConnectionEpoch: 'e', _codexOrphanBuffer: null,
    ws: { readyState: 1, send: text => packets.push(JSON.parse(text)) },
  });
  vm.runInContext(block('  async function readCodexRequirements()', '  async function beforeCodexCompatRequest(')
    + block('  function sendToClient(data)', '  function runCodexJournalOperation('), context);
  assert.equal(await context.readCodexRequirements(), null);
  assert.match(error.message, /unknown variant/, 'internal error retains native shape');
  context.sendToClient({ type: 'error', code: error.code, message: error.message, requestId: 'a' });
  context.sendToClient({ type: 'error', message: `Revert failed: ${error.message}`, requestId: 'b' });
  for (const packet of packets) {
    assert.equal(packet.category, 'unsupported');
    assert.equal(packet.message, 'The installed Codex CLI does not support configRequirements/read');
    assert.equal(packet.sessionId, 's'); assert.equal(packet.connectionEpoch, 'e');
  }
  error.message = 'Invalid request: missing field threadId';
  await assert.rejects(context.readCodexRequirements(), /missing field/);
  context.sendToClient({ type: 'error', code: error.code, message: error.message });
  assert.equal(packets.at(-1).message, error.message, 'other invalid requests remain ordinary errors');
});

test('fixture-shaped settings update catalog selections while preserving plan effort and unknown values', () => {
  const models = [{ model: 'known', supportedReasoningEfforts: [{ effort: 'low' }, { effort: 'high' }] }];
  const params = { threadId: 'a', threadSettings: {
    model: 'known', modelProvider: 'openai', effort: 'high', cwd: '/tmp',
    approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' },
    collaborationMode: { mode: 'default', settings: { model: 'known', reasoning_effort: 'high' } },
  } };
  validate('ThreadSettingsUpdatedNotification', params);
  const tab = { model: 'old', effort: 'low' };
  applyCodexThreadSettings(tab, params, models);
  assert.equal(tab.nativeSettings, params.threadSettings);
  assert.equal(tab.model, 'known'); assert.equal(tab.effort, 'high');
  tab.effort = 'low'; tab.planMode = true;
  applyCodexThreadSettings(tab, params, models);
  assert.equal(tab.effort, 'low');
  tab.planMode = false; tab.planTurnActive = true;
  applyCodexThreadSettings(tab, params, models);
  assert.equal(tab.effort, 'low');
  tab.planTurnActive = false;
  applyCodexThreadSettings(tab, { ...params, threadSettings: { ...params.threadSettings, collaborationMode: { ...params.threadSettings.collaborationMode, mode: 'plan' } } }, models);
  assert.equal(tab.effort, 'low');
  applyCodexThreadSettings(tab, { ...params, threadSettings: { ...params.threadSettings, model: 'unknown', effort: 'ultra' } }, models);
  assert.equal(tab.model, 'known'); assert.equal(tab.effort, 'low');
  applyCodexThreadSettings(tab, { ...params, threadSettings: { ...params.threadSettings, effort: 'ultra' } }, models);
  assert.equal(tab.effort, 'low');
  const source = readFileSync(new URL('../public/shared/cdx/cdx-tabs.js', import.meta.url), 'utf8');
  assert.match(source, /case 'thread\/settings\/updated':[\s\S]*?applyCodexThreadSettings\(_boundTab, params, modelListForTab\(_boundTab\)\)/);
});

test('generic card heads preserve dedicated query, image and hook previews after partial updates', () => {
  for (const [type, item, detail] of [
    ['webSearch', { query: 'latest result' }, 'latest result'],
    ['imageView', { path: '/tmp/image.png' }, '/tmp/image.png'],
    ['imageGeneration', { revisedPrompt: 'a mountain' }, 'a mountain'],
    ['hookPrompt', { fragments: [{ text: 'injected prompt' }] }, 'injected prompt'],
  ]) {
    const lastItem = { type, ...item, status: 'completed' };
    const head = codexGenericCardHead(lastItem, { detail });
    assert.equal(head.subtitle, detail, type);
    assert.ok(head.title);
  }
  assert.deepEqual(codexGenericCardHead({ type: 'functionCallOutput', name: 'tool' }, { detail: 'fallback' }), { title: 'Tool output', subtitle: 'tool' });
  const source = readFileSync(new URL('../public/shared/cdx/cdx-render.js', import.meta.url), 'utf8');
  assert.match(source, /codexGenericCardHead\(item, summary\)/);
  assert.match(source, /codexGenericCardHead\(state\._lastItem, h\)/);
});

test('contract shaping strips string annotations and preserves real title and description properties', () => {
  const shape = contractShape({ title: 'Annotation', description: 'Annotation', $schema: 'schema', properties: {
    title: { type: 'string', description: 'Field documentation' }, description: { type: 'string' }, $schema: { type: 'string' },
  }, required: ['title'] });
  assert.deepEqual(shape, { properties: { title: { type: 'string' }, description: { type: 'string' }, $schema: { type: 'string' } }, required: ['title'] });
  validate('AsyncUserInputQuestion', { title: 'Which option?', options: ['one'] });
  validate('McpServerElicitationRequestParams', { mode: 'openai/userVerification', title: 'Verify', description: 'Account verification', challenge: 'challenge', serverName: 'server', threadId: 'a' });
  const question = ajv.compile({ ...fixture.definitions.AsyncUserInputQuestion, definitions: fixture.definitions });
  assert.equal(question({ options: ['one'] }), false);
});

test('all capability methods and experimental flags match the generated 0.160 schema', () => {
  assert.equal(CODEX_PROTOCOL_BASELINE, fixture.cliVersion);
  assert.equal(Object.keys(fixture.methods).length, 167);
  assert.equal(Object.keys(fixture.notifications).length, 83);
  assert.equal(Object.keys(fixture.requests).length, 11);
  for (const descriptor of Object.values(CODEX_CAPABILITY_METHODS)) {
    assert.ok(fixture.methods[descriptor.method], descriptor.method);
    assert.equal(descriptor.experimental, fixture.methods[descriptor.method].experimental, descriptor.method);
    assert.equal('recent' in descriptor, false);
  }
  assert.equal('thread/rollback' in fixture.methods, false);
});

test('known machine requests are answered correctly and future requests cannot hang', () => {
  const reply = automaticCodexServerReply('currentTime/read', {}, 1760000000123);
  validate('CurrentTimeReadResponse', reply.result);
  assert.equal(reply.result.currentTimeAt, 1760000000);
  for (const method of Object.keys(fixture.requests)) {
    const reply = automaticCodexServerReply(method);
    if (reply?.error) assert.equal(reply.error.code, -32601);
    else if (method !== 'currentTime/read') assert.equal(reply, null);
  }
  assert.equal(automaticCodexServerReply('future/request').error.code, -32601);
  assert.equal(automaticCodexServerReply('mcpServer/elicitation/request', { mode: 'openai/userVerification' }).error.code, -32601);
  assert.equal(automaticCodexServerReply('mcpServer/elicitation/request', { mode: 'future/mode' }).error.code, -32601);
  assert.equal(automaticCodexServerReply('mcpServer/elicitation/request', { mode: 'openai/form' }), null);
});

test('turn-count reverts map to a native beforeTurnId and hydrate retained history', async () => {
  const calls = [];
  let reverted = false;
  const result = await revertCodexThreadHistory(async (method, params) => {
    calls.push([method, params]);
    if (method === 'thread/revert') { reverted = true; validate('ThreadRevertParams', params); return { thread: { id: 'a' } }; }
    if (method === 'thread/items/list') return { data: [], nextCursor: null };
    return { data: (reverted ? ['1'] : ['1', '2', '3']).map(id => ({ id })), nextCursor: null };
  }, 'a', { numTurns: 2 });
  assert.deepEqual(calls.find(([method]) => method === 'thread/revert')[1], { threadId: 'a', beforeTurnId: '2' });
  assert.deepEqual(result.thread.turns, [{ id: '1', items: [], itemsView: 'full' }]);
  await assert.rejects(revertCodexThreadHistory(async () => ({}), 'a', { numTurns: 0 }), /positive integer/);
});

test('revert fallback is restricted to method-not-found and never hides runtime errors', async () => {
  const calls = [];
  const request = async (method, params) => {
    calls.push([method, params]);
    if (method === 'thread/turns/list') return { data: [{ id: 'one' }, { id: 'two' }], nextCursor: null };
    if (method === 'thread/revert') throw Object.assign(new Error('Invalid request: unknown variant `thread/revert`, expected one of `initialize`, `thread/rollback`'), { code: -32600 });
    return { thread: { id: 'a', turns: [] } };
  };
  await revertCodexThreadHistory(request, 'a', { numTurns: 3 });
  assert.deepEqual(calls.at(-1), ['thread/rollback', { threadId: 'a', numTurns: 2 }]);
  await assert.rejects(revertCodexThreadHistory(async method => {
    if (method === 'thread/turns/list') return { data: [{ id: 'one' }], nextCursor: null };
    throw Object.assign(new Error('restricted'), { code: -32001 });
  }, 'a'), /restricted/);
});

test('attachment mutations enforce the active thread and unsupported runtimes settle with correlation', async () => {
  const packets = [], calls = [];
  const registry = new CodexCapabilityRegistry({ cliVersion: '0.153.4' });
  const context = { activeThreadId: 'a', registry, ensureInitialized: async () => {}, send: packet => packets.push(packet),
    request: async (...args) => { calls.push(args); throw Object.assign(new Error(`Invalid request: unknown variant \`${args[0]}\`, expected one of \`initialize\``), { code: -32600 }); },
    withWriterOperation: async (_type, action) => action() };
  await handleCodexCompatMessage({ type: 'attachment_remove', threadId: 'foreign', attachmentType: 'note', identityKey: 'x' }, context);
  assert.equal(packets[0].category, 'invalid_request'); assert.equal(calls.length, 0);
  await handleCodexCompatMessage({ type: 'attachment_list', requestId: 'attachment-1' }, context);
  assert.equal(packets[1].category, 'unsupported'); assert.equal(packets[1].requestId, 'attachment-1');
  assert.equal(packets[1].message, 'The installed Codex CLI does not support thread/attachment/list');
  assert.deepEqual(buildCodexCompatParams({ type: 'thread_settings_update', disabledPluginIds: ['x', 'x'] }, { activeThreadId: 'a' }), { threadId: 'a', disabledPluginIds: ['x'] });
  assert.throws(() => buildCodexCompatParams({ type: 'thread_settings_update', disabledPluginIds: [false] }, { activeThreadId: 'a' }), /plugin ids/);
});

test('transcript outputs, waiting and agent activity have readable presentations', () => {
  assert.match(codexTranscriptPresentation({ type: 'functionCallOutput', name: 'tool', output: [{ type: 'input_text', text: 'finished' }, { type: 'input_image', file_id: 'file-1' }] }).text, /finished\nImage: file-1/);
  assert.match(codexTranscriptPresentation({ type: 'subAgentActivity', agentPath: 'helper', kind: 'interrupted' }).text, /helper\nActivity: interrupted/);
  assert.match(codexTranscriptPresentation({ type: 'sleep', durationMs: 1500 }).text, /1.5 seconds/);
  assert.match(codexTranscriptPresentation({ type: 'futureItem', result: { resultText: 'Done' } }).text, /"resultText": "Done"/);
  assert.equal(codexReadableValue({ type: 'encrypted_content', encrypted_content: 'secret' }), 'Encrypted content');
  assert.ok(codexReadableValue('x'.repeat(20000)).length <= 12000);
  assert.match(codexTranscriptPresentation({ type: 'functionCallOutput', output: 'x'.repeat(20000) }).text, /Truncated/);
  assert.ok(codexReadableValue(Array.from({ length: 100 }, () => ({ output: 'x'.repeat(20000) }))).length <= 12000);
  validate('UserInput', { type: 'image', fileId: 'file-1' });
  validate('FunctionCallOutputContentItem', { type: 'input_image', file_id: 'file-1' });
});

test('hook and goal notifications update stable cards and remain bound to their thread', () => {
  const started = codexNotificationItem('hook/started', { run: { id: 'hook-1', status: 'running', entries: [] } });
  const completed = codexNotificationItem('hook/completed', { run: { id: 'hook-1', status: 'blocked', entries: [{ kind: 'stderr', text: 'Needs permission' }] } });
  assert.equal(started.id, completed.id); assert.equal(completed._synabunCompleted, true);
  assert.match(codexTranscriptPresentation(completed).text, /Needs permission/);
  assert.equal(codexNotificationItem('thread/goal/cleared', { threadId: 'a' }).status, 'cleared');
  const previous = { objective: 'Old objective', tokensUsed: 100, tokenBudget: 200, timeUsedSeconds: 30 };
  const cleared = { ...previous, ...codexNotificationItem('thread/goal/cleared', { threadId: 'a' }) };
  for (const key of Object.keys(previous)) assert.equal(cleared[key], null, key);
  assert.equal(codexTranscriptPresentation(cleared).text, 'Goal cleared');
  const tab = { id: 's', connectionEpoch: 'e', threadId: 'a' };
  assert.equal(codexSocketMessageRejectionReason({ type: 'notify', method: 'hook/started', sessionId: 's', connectionEpoch: 'e' }, tab), 'missing_thread');
  registerOwnedThreadFromItem(tab, { type: 'collabAgentToolCall', receiverThreadIds: ['helper'] });
  assert.equal(tab.ownedThreadIds.has('helper'), true);
});

test('quota aliases and access programs retain live metadata without guessed model limits', () => {
  assert.equal(codexRateLimitMetadata({ normalModelSlug: 'model-x', planType: 'promax' }), 'model model-x · plan promax');
  assert.equal(codexModelAccessMetadata({ availableAccessPrograms: { cyber: ['standard', 'daybreakBlue'] } }), 'Access programs: standard, daybreak Blue');
});

test('fixture comparisons include added, removed, changed methods and nested field contracts', () => {
  const before = { methods: { old: { params: {} }, retained: { params: {} } }, notifications: {}, requests: {}, definitions: { Model: { enum: ['a'] } } };
  const after = { methods: { retained: { params: { required: ['id'] } }, added: { params: {} } }, notifications: { notice: {} }, requests: { ask: {} }, definitions: { Model: { enum: ['a', 'b'] } } };
  const changes = diffCodexProtocolFixtures(before, after);
  assert.equal(changes.find(x => x.name === 'old').change, 'removed');
  assert.equal(changes.find(x => x.name === 'retained').change, 'changed');
  assert.ok(changes.some(x => x.surface === 'server_notification'));
  assert.ok(changes.some(x => x.surface === 'server_request'));
  assert.equal(changes.find(x => x.name === 'Model').change, 'changed');
});

test('the version ledger accounts for every surface and exposes deliberate follow-ups', () => {
  const audit = JSON.parse(readFileSync(new URL('./fixtures/codex-app-server-0.153.4-to-0.160.0.json', import.meta.url)));
  assert.equal(audit.baseline_from, '0.153.4'); assert.equal(audit.baseline_to, CODEX_PROTOCOL_BASELINE);
  assert.equal(audit.changes.length, 113);
  for (const entry of audit.changes) {
    assert.ok(['implemented', 'fixed', 'already_supported', 'not_applicable', 'follow_up'].includes(entry.action), entry.name);
    assert.ok(entry.reason.length > 20, entry.name);
  }
  for (const [surface, key] of [['methods', 'methods'], ['notifications', 'notifications'], ['requests', 'requests']]) {
    assert.deepEqual(Object.keys(audit.inventory[surface]).sort(), Object.keys(fixture[key]).sort());
  }
  assert.equal(Object.keys(audit.inventory.items).length, fixture.definitions.ThreadItem.oneOf.length);
  assert.equal(audit.changes.find(x => x.name === 'thread/rollback').action, 'fixed');
  assert.equal(audit.changes.find(x => x.name === 'userVerification/verify').action, 'implemented');
  assert.equal(audit.changes.find(x => x.name === 'mcpServer/elicitation/request').action, 'implemented');
});

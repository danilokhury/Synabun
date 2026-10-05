import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import Ajv from 'ajv';
import { CodexVerificationOperation } from '../lib/codex-user-verification.js';
import { CodexCapabilityRegistry } from '../lib/codex-capabilities.js';
import { automaticCodexServerReply, buildCodexCompatParams, handleCodexCompatMessage } from '../lib/codex-compat-rpc.js';
import { parseCodexAttachmentPayload, codexGatewayState, codexVerificationState, codexHttpsHandoff, codexVerificationResolution } from '../public/shared/cdx/cdx-protocol.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/codex-app-server-0.160.0.json', import.meta.url)));
const ajv = new Ajv({ strict: false, validateFormats: false });
const actions = {
  attachment_add: { attachmentType: 'context', identityKey: 'key', payload: { text: '<script>untrusted</script>' } },
  gateway_oauth_read: {}, gateway_oauth_login: {}, gateway_oauth_cancel: {},
  verification_status: {}, verification_enroll: {}, verification_delete: {},
  verification_verify: { challenge: 'test-challenge', title: 'Verify', description: 'Continue?' },
  verification_cancel: { verificationRequestId: 17 },
};

test('all new compat routes use exact schema params and preserve reply correlation', async () => {
  const registry = new CodexCapabilityRegistry();
  for (const [type, data] of Object.entries(actions)) {
    const params = buildCodexCompatParams({ type, ...data }, { activeThreadId: 'test-thread' });
    const method = registry.snapshot()[type].method;
    const validate = ajv.compile({ ...fixture.methods[method].params, definitions: fixture.definitions });
    assert.equal(validate(params), true, `${type}: ${JSON.stringify(validate.errors)}`);
    const calls = [], replies = [];
    await handleCodexCompatMessage({ type, ...data, requestId: 'correlation' }, {
      activeThreadId: 'test-thread', registry, ensureInitialized: async () => {},
      request: async (...args) => { calls.push(args); return {}; },
      send: reply => replies.push(reply), withWriterOperation: async (_, work) => work(),
    });
    assert.equal(calls[0][0], method, type);
    assert.deepEqual(calls[0][1], params, type);
    assert.equal(replies[0].requestId, 'correlation', type);
    assert.notEqual(replies[0].type, 'error', type);
  }
});

test('attachment JSON validation counts UTF-8 bytes and accepts every JSON value', () => {
  for (const text of ['null', 'false', '3', '"note"', '[]', '{"text":"<img>"}']) assert.deepEqual(parseCodexAttachmentPayload(text), JSON.parse(text));
  assert.throws(() => parseCodexAttachmentPayload('{nope}'), /Invalid JSON/);
  assert.throws(() => parseCodexAttachmentPayload(JSON.stringify('é'.repeat(33000))), /64 KiB/);
  assert.throws(() => buildCodexCompatParams({ type: 'attachment_add', ...actions.attachment_add, payload: 'x'.repeat(65536) }, { activeThreadId: 'a' }), /64 KiB/);
  assert.throws(() => buildCodexCompatParams({ type: 'attachment_add', attachmentType: 'context', identityKey: 'key' }, { activeThreadId: 'a' }), /payload is required/);
});

test('attachment adds retain thread ownership and serialize through writer operations', async () => {
  let calls = 0, writes = 0;
  const replies = [];
  const context = { activeThreadId: 'owned', registry: new CodexCapabilityRegistry(), ensureInitialized: async () => {},
    request: async () => { calls++; return {}; }, send: reply => replies.push(reply),
    withWriterOperation: async (_, work) => { writes++; return work(); } };
  await handleCodexCompatMessage({ type: 'attachment_add', ...actions.attachment_add, threadId: 'foreign' }, context);
  assert.equal(calls, 0); assert.equal(replies[0].category, 'invalid_request');
  await handleCodexCompatMessage({ type: 'attachment_add', ...actions.attachment_add }, context);
  assert.equal(calls, 1); assert.equal(writes, 1);
});

test('gateway and local verification states follow native readiness shapes', () => {
  assert.equal(codexGatewayState({ status: 'started' }).pending, true);
  assert.equal(codexGatewayState({ status: 'succeeded' }).label, 'Signed in');
  assert.equal(codexGatewayState({ required: false, status: null }).label, 'Not required for this provider');
  assert.equal(codexGatewayState({ status: 'failed', error: '<img>' }).label, '<img>');
  assert.equal(codexVerificationState({ credentialId: 'local' }).enrolled, true);
  assert.equal(codexVerificationState({ unavailableReason: 'credentialMissing' }).enrolled, false);
  assert.match(codexVerificationState({ unavailableReason: 'biometricsUnavailable' }).label, /Biometrics/);
  assert.equal(codexVerificationState({ unavailableMessage: 'Native message' }).label, 'Native message');
  assert.deepEqual(codexHttpsHandoff('https://login.example.test/auth'), { url: 'https://login.example.test/auth', host: 'login.example.test' });
  for (const url of ['javascript:alert(1)', 'http://example.test', '//example.test', 'file:///tmp', 'https://user:secret@example.test', null]) assert.equal(codexHttpsHandoff(url), null);
});

test('verification support is explicitly scoped to the panel connection and future modes stay terminal', () => {
  const params = { mode: 'openai/userVerification' };
  assert.equal(automaticCodexServerReply('mcpServer/elicitation/request', params).error.code, -32601);
  assert.equal(automaticCodexServerReply('mcpServer/elicitation/request', params, 0, { userVerification: true }), null);
  assert.equal(automaticCodexServerReply('mcpServer/elicitation/request', { mode: 'future/mode' }, 0, { userVerification: true }).error.code, -32601);
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /userVerification: supportsUserVerification && codexRole !== 'assistant' && ws.readyState === 1/);
  assert.match(source, /supportsUserVerification = msg.userVerification === true && msg.role !== 'assistant'/);
  assert.match(source, /msg.params\?\.mode !== 'openai\/userVerification'/);
  assert.match(source, /experimentalApi: true/);
  assert.match(source, /supportsUserVerification = capabilities.userVerification === true/);
  assert.match(source, /orphan\.swapWs\(ws, wsConnectionEpoch, wsSessionId, \{ userVerification: msg\.userVerification === true && msg\.role !== 'assistant' \}\)/);
});

test('older CLIs gate every new method only on unsupported errors with correct experimental flags', () => {
  for (const type of Object.keys(actions)) {
    for (const error of [{ code: -32601, message: 'not found' }, { code: -32600, message: 'unknown variant' }]) {
      const registry = new CodexCapabilityRegistry();
      const descriptor = registry.snapshot()[type];
      assert.equal(descriptor.supported, true);
      assert.equal(descriptor.experimental, type.startsWith('verification_'));
      registry.observe(descriptor.method, { code: -32001, message: 'Provider unavailable' });
      assert.equal(registry.snapshot()[type].supported, true);
      registry.observe(descriptor.method, error);
      assert.equal(registry.snapshot()[type].supported, false);
      assert.match(registry.snapshot()[type].reason, /does not support/);
    }
  }
});

test('verification races settle once and cancel the native RPC id rather than the elicitation id', () => {
  for (const action of ['decline', 'cancel']) {
    const op = new CodexVerificationOperation(); op.start(); op.captureRpcId(77);
    assert.throws(() => op.start(), /already/);
    assert.deepEqual(op.finish(action), { cancelId: 77, result: { action, content: null } });
    assert.equal(op.finish('decline'), null);
    assert.equal(op.complete({ proof: { credentialId: 'test', signature: 'test-signature' } }), false);
    assert.equal(op.finish('accept', { credentialId: 'test', signature: 'test-signature' }), null);
  }
  const op = new CodexVerificationOperation();
  assert.throws(() => op.finish('accept', {}), /Verify before/);
  op.start(); op.captureRpcId(78); op.complete({ proof: { credentialId: 'test', signature: 'test-signature' } });
  assert.throws(() => op.finish('accept', { credentialId: 'forged', signature: 'test-signature' }), /Verify before/);
  assert.deepEqual(op.finish('accept', { credentialId: 'test', signature: 'test-signature' }), { cancelId: null, result: { action: 'accept', content: { credentialId: 'test', signature: 'test-signature' } } });
  const ui = codexVerificationResolution(); assert.equal(ui.claim(), true); assert.equal(ui.claim(), false);
});

test('bridge terminal lifecycle cancels and replies to verification exactly once on interruption', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function settleCodexVerification(');
  const end = source.indexOf('  function logRequestLifecycle(', start);
  const op = new CodexVerificationOperation(); op.start(); op.captureRpcId(99);
  const native = [], replies = [], finished = [];
  const pendingServerRequests = new Map([['3', { rpcId: 3, verification: op, threadId: 'a', turnId: 'b' }]]);
  const context = vm.createContext({ pendingServerRequests,
    request: async (...args) => native.push(args), sendRpcResult: (...args) => { replies.push(args); return true; },
    requestCorrelation: id => ({ requestId: id }), runCodexJournalOperation: (_, __, work) => ({ ok: true, value: work() }),
    codexRequestJournal: { finish: (_, status) => { finished.push(status); return { status }; } },
    sendToClient: () => {}, logRequestLifecycle: () => {},
  });
  vm.runInContext(source.slice(start, end), context);
  context.finishPendingServerRequests('turn_canceled', 'Interrupted');
  context.finishPendingServerRequests('turn_canceled', 'Repeated');
  assert.equal(replies.length, 1); assert.equal(replies[0][0], 3);
  assert.equal(replies[0][1].action, 'cancel');
  assert.equal(native.length, 1); assert.equal(native[0][0], 'userVerification/cancel'); assert.equal(native[0][1].requestId, 99);
  assert.deepEqual(finished, ['turn_canceled']); assert.equal(pendingServerRequests.size, 0);
});

test('verification card packets contain only display fields, never challenge or opaque metadata', async () => {
  const { codexVerificationCardParams } = await import('../lib/codex-user-verification.js');
  assert.deepEqual(codexVerificationCardParams({ mode: 'openai/userVerification', title: 'Verify', description: 'Continue', challenge: 'fixture-secret', serverName: 'hidden', _meta: { hidden: true } }),
    { mode: 'openai/userVerification', title: 'Verify', description: 'Continue' });
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /params: codexVerificationCardParams\(msg.params \|\| \{\}\), resolved: true/);
  assert.match(source, /params: codexVerificationCardParams\(requestParams\)/);
  assert.match(source, /params: codexVerificationCardParams\(requestInfo.params \|\| \{\}\)/);
});

test('verification replies never reach sessionStorage on send failure, rejection or acknowledgement; resolved running pills settle', () => {
  const source = readFileSync(new URL('../public/shared/cdx/cdx-requests.js', import.meta.url), 'utf8');
  const storage = new Map(), writes = [], packets = [];
  let sendOK = false;
  const entry = { card: { querySelectorAll: () => [] }, pillEl: { textContent: 'running' }, verificationGate: { claim: () => true } };
  const tab = { id: 'session', threadId: 'thread', _notifState: { requestIds: new Set() } };
  const context = vm.createContext({ console: { info() {} }, crypto: { randomUUID: () => 'response-token' },
    codexRequestIdentityKey: (session, id) => `${session}:${id}`,
    sessionStorage: { setItem(key, value) { writes.push(value); storage.set(key, value); }, getItem: key => storage.get(key), removeItem: key => storage.delete(key) },
    notify() {}, NOTIF_TYPE: {},
  });
  vm.runInContext(source.slice(source.indexOf('const _pendingReplyAcks')).replaceAll('export function ', 'function '), context);
  context.setRequestsContext({ boundTab: tab, requestCards: new Map([['7', entry]]), scheduleThreadSnapshotSave() {}, appendSystem() {},
    sendSocket: packet => { packets.push(packet); return sendOK; }, isBlockingServerRequest: () => false, onBlockingServerRequestAnswered() {} });
  context.handleServerRequest({ requestId: 7, method: 'mcpServer/elicitation/request', params: { mode: 'openai/userVerification', title: 'Fixture' } });
  const result = { action: 'accept', content: { credentialId: 'fixture', signature: 'fixture-proof' } };
  assert.equal(context.sendServerRequestReply(7, { result }), false);
  assert.equal(writes.length, 0); assert.equal(entry.pillEl.textContent, 'delivery failed');
  sendOK = true; context.sendServerRequestReply(7, { result });
  context.handleServerRequestResponseResult({ responseToken: 'response-token', ok: false, status: 'delivery_failed' });
  assert.equal(writes.length, 0); assert.equal(storage.size, 0);
  entry.pillEl.textContent = 'running'; context.resolveRequestCard(7, 'cancelled');
  assert.equal(entry.pillEl.textContent, 'cancelled');
  context.sendServerRequestReply(7, { result, label: 'verified' });
  context.resolveRequestCard(7, 'verified');
  context.handleServerRequestResponseResult({ responseToken: 'response-token', ok: true });
  assert.equal(entry.pillEl.textContent, 'verified'); assert.equal(writes.length, 0);
  context.sendServerRequestReply(7, { result }); context.resolveRequestCard(7, 'cancelled');
  context.handleServerRequestResponseResult({ responseToken: 'response-token', ok: false, status: 'delivery_failed' });
  assert.equal(entry.pillEl.textContent, 'cancelled', 'a late failed acknowledgement cannot revive a resolved verification');
  assert.equal(packets[0].result.content.signature, 'fixture-proof');
});

test('socket closure creates the retained event buffer before verification cancellation and does not discard it later', () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const close = source.slice(source.indexOf('  const handleCodexSocketClose = () => {'), source.indexOf("  ws.on('close', handleCodexSocketClose)"));
  assert.ok(close.indexOf('_codexOrphanBuffer ||= []') < close.indexOf("settleCodexVerification(id, info, 'cancel')"));
  assert.doesNotMatch(close, /_codexOrphanBuffer = \[\]/);
});

test('correlated pending errors bypass approval buffering and inserted drafts preserve visible and background text', () => {
  const source = readFileSync(new URL('../public/shared/cdx/cdx-tabs.js', import.meta.url), 'utf8');
  const start = source.indexOf('function shouldBufferSocketMessage('), end = source.indexOf('function bufferSocketMessage(', start);
  const context = vm.createContext({ hasBlockingServerRequests: () => true, _renameRequests: new Map([['app-rpc', {}], ['verify-rpc', {}]]),
    _sessionListRequest: null, _threadStartRequest: null, _pendingQueryRequestId: null });
  vm.runInContext(source.slice(start, end), context);
  for (const requestId of ['app-rpc', 'verify-rpc']) assert.equal(context.shouldBufferSocketMessage('error', { requestId }), false);
  assert.equal(context.shouldBufferSocketMessage('error', { requestId: 'unrelated' }), true);
  const draftStart = source.indexOf('function setMcpAppDraft('), draftEnd = source.indexOf('function currentComposerPayload(', draftStart);
  const input = { value: 'Visible owner draft' }, values = [];
  const drafts = vm.createContext({ panelEl: () => input, isActiveTab: tab => tab.active, consumeComposer: (_, tab, options) => values.push([tab.id, options.value]) });
  vm.runInContext(source.slice(draftStart, draftEnd), drafts);
  drafts.setMcpAppDraft({ id: 'active', active: true, draft: 'old snapshot' }, 'Inserted');
  drafts.setMcpAppDraft({ id: 'background', active: false, draft: 'Saved owner draft' }, 'Inserted');
  drafts.setMcpAppDraft({ id: 'empty', active: false, draft: '' }, 'Inserted');
  assert.deepEqual(values, [['active', 'Visible owner draft\n\nInserted'], ['background', 'Saved owner draft\n\nInserted'], ['empty', 'Inserted']]);
});

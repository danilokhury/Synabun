import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleOpencodeV2Request, opencodeV2WsCapabilities, ownsOpencodeV2Request,
  OPENCODE_V2_WS_INLINE_TYPES, OPENCODE_V2_WS_MODULE_TYPES, OPENCODE_V2_WS_FEATURES,
  contextRows, statusForSession, lastModelOf, buildOpencodeRuntimeMcpConfig, shouldRelayOpencodeV2Message,
  buildSessionListQuery, mapSessionListRow, sharePolicyOf, OPENCODE_V2_WS_MUTATION_TYPES, SESSION_LIST_MAX,
  commandRow, FIND_FILES_LIMIT, capFileDiffs, FILE_DIFF_MAX_FILES, FILE_DIFF_MAX_PATCH_CHARS,
  mcpRows, MANAGED_MCP_NAMES,
} from '../lib/opencode-v2-ws-requests.js';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const ok = (data, status = 200) => Promise.resolve({ status, data });
function sdkError(message, status, tag) {
  const err = new Error(message);
  err.status = status;
  if (tag) err.tag = tag;
  return err;
}

// One fake socket + one fake client per role. `calls` records
// [role, 'group.method', params] in order.
function harness(answers = {}) {
  const sent = [];
  const calls = [];
  // `client.<group>.<method>` and `client.extra.<group>.<method>` are recorded
  // under distinct keys, so a test pins which surface a request uses.
  const groups = (role, prefix) => new Proxy({}, {
    get: (_t, group) => (prefix === '' && group === 'extra' ? groups(role, 'extra.') : new Proxy({}, {
      get: (_g, method) => async (params, options) => {
        const key = `${prefix}${String(group)}.${String(method)}`;
        calls.push(options ? [role, key, params, options] : [role, key, params]);
        const answer = answers[`${role}:${key}`] ?? answers[key];
        if (!answer) return { status: 200, data: {} };
        return answer(params, calls);
      },
    })),
  });
  const client = (role) => groups(role, '');
  const proxied = [];
  const deps = {
    send: (data) => sent.push(data),
    shared: client('shared'),
    bound: (sessionId) => { calls.push(['resolve', 'bound', sessionId]); return client('bound'); },
    turn: async (sessionId, profile) => { calls.push(['resolve', 'turn', [sessionId, profile]]); return client('turn'); },
    isTurnActive: (sessionId) => (answers.activeTurns || []).includes(sessionId),
    turnScope: (sessionId) => {
      const signal = new AbortController().signal;
      calls.push(['scope', 'begin', sessionId]);
      return { signal, end: () => calls.push(['scope', 'end', sessionId]) };
    },
    proxy: async (...args) => { proxied.push(args); return (answers.proxy || (() => ({ status: 200, data: true })))(...args); },
    baseUrlFor: (sessionId) => `http://serve-of/${sessionId || 'shared'}`,
    directoryQuery: (cwd) => (cwd ? `?directory=${encodeURIComponent(cwd)}` : ''),
  };
  return { sent, calls, proxied, deps };
}

test('capabilities list every inline and module type exactly once', () => {
  const caps = opencodeV2WsCapabilities();
  assert.equal(new Set(caps).size, caps.length);
  for (const type of [...OPENCODE_V2_WS_INLINE_TYPES, ...OPENCODE_V2_WS_MODULE_TYPES]) assert.ok(caps.includes(type), type);
  // The four request bodies moved out of server.js stay advertised.
  for (const type of ['session:context', 'session:compact', 'permission:reply', 'question:reply']) {
    assert.ok(ownsOpencodeV2Request(type), type);
  }
  for (const type of OPENCODE_V2_WS_INLINE_TYPES) assert.equal(ownsOpencodeV2Request(type), false, type);
  // Feature tokens are advertised but are never request types.
  for (const feature of OPENCODE_V2_WS_FEATURES) {
    assert.ok(caps.includes(feature), feature);
    assert.match(feature, /^feature:/);
    assert.equal(ownsOpencodeV2Request(feature), false);
  }
});

test('a type the module does not own is left to the caller, with nothing sent', async () => {
  const h = harness();
  assert.equal(await handleOpencodeV2Request({ type: 'message:send', id: 1 }, h.deps), false);
  assert.equal(await handleOpencodeV2Request({ type: 'nope', id: 2 }, h.deps), false);
  assert.equal(await handleOpencodeV2Request({ type: 'constructor', id: 3 }, h.deps), false);
  assert.deepEqual(h.sent, []);
});

test('session-scoped requests are refused without a sessionId', async () => {
  for (const type of ['session:context', 'session:compact', 'session:status']) {
    const h = harness();
    assert.equal(await handleOpencodeV2Request({ type, id: 9 }, h.deps), true);
    assert.deepEqual(h.sent, [{ type: `${type}:result`, id: 9, ok: false, status: 400, error: 'sessionId is required' }]);
    assert.deepEqual(h.calls, []);
  }
});

test('session:context drops the directory and unwraps the 1.18 { data } body', async () => {
  const rows = [{ id: 'm1' }];
  const h = harness({ 'session.context': () => ok({ data: rows }) });
  await handleOpencodeV2Request({ type: 'session:context', id: 1, sessionId: 'ses_1', cwd: '/p' }, h.deps);
  assert.deepEqual(h.calls, [['shared', 'session.context', { sessionID: 'ses_1' }]]);
  assert.deepEqual(h.sent, [{ type: 'session:context:result', id: 1, status: 200, data: rows }]);
  assert.deepEqual(contextRows(rows), rows);
  assert.deepEqual(contextRows({ data: rows }), rows);
  assert.deepEqual(contextRows(undefined), []);
});

test('session:compact uses the session serve and reports which endpoint ran', async () => {
  const h = harness({ 'session.compact': () => ok(undefined, 204) });
  await handleOpencodeV2Request({ type: 'session:compact', id: 4, sessionId: 'ses_1', cwd: '/p', mcpProfile: 'memory' }, h.deps);
  assert.deepEqual(h.calls, [
    ['resolve', 'turn', ['ses_1', 'memory']],
    ['turn', 'session.compact', { sessionID: 'ses_1', directory: '/p' }],
  ]);
  assert.deepEqual(h.sent, [{ type: 'session:compact:result', id: 4, status: 204, data: undefined, via: 'compact' }]);
});

test('session:compact falls back to summarize when OpenCode answers "not available yet"', async () => {
  const unavailable = () => { throw sdkError('Session compact is not available yet', 503, 'ServiceUnavailableError'); };
  const h = harness({ 'session.compact': unavailable, 'extra.session.summarize': () => ok(true) });
  await handleOpencodeV2Request({
    type: 'session:compact', id: 5, sessionId: 'ses_1', cwd: '/p',
    model: { providerID: 'anthropic', modelID: 'claude-x' },
  }, h.deps);
  assert.deepEqual(h.calls.slice(1), [
    ['turn', 'session.compact', { sessionID: 'ses_1', directory: '/p' }],
    ['turn', 'extra.session.summarize', { sessionID: 'ses_1', directory: '/p', providerID: 'anthropic', modelID: 'claude-x' }],
  ]);
  assert.deepEqual(h.sent, [{ type: 'session:compact:result', id: 5, status: 200, data: true, via: 'summarize' }]);
});

test('session:compact fallback reads the model from the transcript, or says what is missing', async () => {
  const unavailable = () => { throw sdkError('Session compact is not available yet', 503); };
  const withHistory = harness({
    'session.compact': unavailable,
    'session.messages': () => ok([
      { info: { role: 'user', model: { providerID: 'openai', modelID: 'gpt-old' } } },
      { info: { role: 'assistant', providerID: 'openai', modelID: 'gpt-new' } },
      { info: { role: 'user' } },
    ]),
    'extra.session.summarize': () => ok(true),
  });
  await handleOpencodeV2Request({ type: 'session:compact', id: 6, sessionId: 'ses_1' }, withHistory.deps);
  assert.deepEqual(withHistory.calls.at(-1), ['turn', 'extra.session.summarize', { sessionID: 'ses_1', directory: undefined, providerID: 'openai', modelID: 'gpt-new' }]);

  const empty = harness({ 'session.compact': unavailable, 'session.messages': () => ok([]) });
  await handleOpencodeV2Request({ type: 'session:compact', id: 7, sessionId: 'ses_1' }, empty.deps);
  assert.equal(empty.calls.some(([, key]) => key === 'extra.session.summarize'), false);
  assert.equal(empty.sent[0].ok, false);
  assert.equal(empty.sent[0].status, 400);
  assert.match(empty.sent[0].error, /Pick a model first/);

  assert.deepEqual(lastModelOf([{ info: { model: { providerID: 'a', modelID: 'b' } } }]), { providerID: 'a', modelID: 'b' });
  assert.equal(lastModelOf([{ info: { providerID: 'a' } }]), null);
  assert.equal(lastModelOf(null), null);
});

test('session:compact reports any other failure with its status and tag', async () => {
  const h = harness({ 'session.compact': () => { throw sdkError('Session not found: ses_1', 404, 'SessionNotFoundError'); } });
  await handleOpencodeV2Request({ type: 'session:compact', id: 8, sessionId: 'ses_1' }, h.deps);
  assert.deepEqual(h.sent, [{
    type: 'session:compact:result', id: 8, ok: false, status: 404,
    error: 'Session not found: ses_1', tag: 'SessionNotFoundError',
  }]);
  assert.equal(h.calls.some(([, key]) => key === 'extra.session.summarize'), false);
});

test('session:status asks the serve hosting the session and defaults to idle', async () => {
  const busy = harness({ 'extra.session.status': () => ok({ ses_1: { type: 'retry', attempt: 2, message: 'Overloaded', next: 123 }, ses_2: { type: 'busy' } }) });
  await handleOpencodeV2Request({ type: 'session:status', id: 1, sessionId: 'ses_1', cwd: '/p' }, busy.deps);
  assert.deepEqual(busy.calls, [
    ['resolve', 'bound', 'ses_1'],
    ['bound', 'extra.session.status', { directory: '/p' }],
  ]);
  assert.deepEqual(busy.sent, [{
    type: 'session:status:result', id: 1, status: 200,
    data: { status: { type: 'retry', attempt: 2, message: 'Overloaded', next: 123 } },
  }]);

  // The live serve answers `{}` when nothing is running.
  assert.deepEqual(statusForSession({}, 'ses_1'), { type: 'idle' });
  assert.deepEqual(statusForSession(undefined, 'ses_1'), { type: 'idle' });
  assert.deepEqual(statusForSession({ ses_1: 'busy' }, 'ses_1'), { type: 'idle' });
});

test('permission:reply sends requestID / reply / directory and a reason only on reject', async () => {
  const h = harness({ 'permission.reply': () => ok(true) });
  await handleOpencodeV2Request({
    type: 'permission:reply', id: 1, sessionId: 'ses_1', permissionId: 'per_1', response: 'once', cwd: '/p', message: 'ignored',
  }, h.deps);
  await handleOpencodeV2Request({
    type: 'permission:reply', id: 2, sessionId: 'ses_1', permissionId: 'per_2', response: 'reject', message: '  use rg instead  ',
  }, h.deps);
  assert.deepEqual(h.calls.filter(([role]) => role === 'bound'), [
    ['bound', 'permission.reply', { requestID: 'per_1', reply: 'once', message: undefined, directory: '/p' }],
    ['bound', 'permission.reply', { requestID: 'per_2', reply: 'reject', message: 'use rg instead', directory: undefined }],
  ]);
  assert.deepEqual(h.sent, [
    { type: 'permission:reply:result', id: 1, status: 200, data: true },
    { type: 'permission:reply:result', id: 2, status: 200, data: true },
  ]);
});

test('permission:reply retries once without the directory on 404 and never invents a route', async () => {
  let attempt = 0;
  const h = harness({
    'permission.reply': () => {
      attempt += 1;
      if (attempt === 1) throw sdkError('Permission request not found: per_1', 404, 'PermissionNotFoundError');
      return ok(true);
    },
  });
  await handleOpencodeV2Request({ type: 'permission:reply', id: 1, sessionId: 'ses_1', permissionId: 'per_1', response: 'always', cwd: '/p' }, h.deps);
  assert.deepEqual(h.calls.filter(([role]) => role === 'bound').map(([, , params]) => params), [
    { requestID: 'per_1', reply: 'always', message: undefined, directory: '/p' },
    { requestID: 'per_1', reply: 'always', message: undefined },
  ]);
  assert.deepEqual(h.sent, [{ type: 'permission:reply:result', id: 1, status: 200, data: true }]);
  assert.deepEqual(h.proxied, [], 'no raw HTTP fallback paths');

  // Without a directory there is nothing to retry: the 404 is the answer.
  const gone = harness({ 'permission.reply': () => { throw sdkError('Permission request not found: per_9', 404, 'PermissionNotFoundError'); } });
  await handleOpencodeV2Request({ type: 'permission:reply', id: 2, sessionId: 'ses_1', permissionId: 'per_9', response: 'once' }, gone.deps);
  assert.equal(gone.calls.filter(([role]) => role === 'bound').length, 1);
  assert.deepEqual(gone.sent, [{
    type: 'permission:reply:result', id: 2, ok: false, status: 404,
    error: 'Permission request not found: per_9', tag: 'PermissionNotFoundError',
  }]);
});

test('permission:reply validates the id and the reply before calling OpenCode', async () => {
  const h = harness();
  await handleOpencodeV2Request({ type: 'permission:reply', id: 1, sessionId: 'ses_1', response: 'once' }, h.deps);
  await handleOpencodeV2Request({ type: 'permission:reply', id: 2, sessionId: 'ses_1', permissionId: 'per_1', response: 'allow' }, h.deps);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sent.map((m) => [m.status, m.ok]), [[400, false], [400, false]]);
});

test('permission:list returns the pending requests of the session serve', async () => {
  const pending = [{ id: 'per_1', sessionID: 'ses_1' }, { id: 'per_2', sessionID: 'ses_child' }];
  const h = harness({ 'extra.permission.list': () => ok(pending) });
  await handleOpencodeV2Request({ type: 'permission:list', id: 3, sessionId: 'ses_1', cwd: '/p' }, h.deps);
  assert.deepEqual(h.calls, [['resolve', 'bound', 'ses_1'], ['bound', 'extra.permission.list', { directory: '/p' }]]);
  assert.deepEqual(h.sent, [{ type: 'permission:list:result', id: 3, status: 200, data: pending }]);

  const odd = harness({ 'extra.permission.list': () => ok({ nope: true }) });
  await handleOpencodeV2Request({ type: 'permission:list', id: 4 }, odd.deps);
  assert.deepEqual(odd.sent[0].data, []);
});

test('question:reply posts to the one real route on the serve hosting the session', async () => {
  const h = harness();
  await handleOpencodeV2Request({
    type: 'question:reply', id: 1, sessionId: 'ses_1', requestId: 'que/1', answers: [['Yes']], cwd: '/my project',
  }, h.deps);
  assert.deepEqual(h.proxied, [[
    'POST', '/question/que%2F1/reply?directory=%2Fmy%20project', { answers: [['Yes']] }, 10000, 'http://serve-of/ses_1',
  ]]);
  assert.deepEqual(h.sent, [{ type: 'question:reply:result', id: 1, status: 200, data: true }]);
});

test('question:reply passes a 404 through and refuses an HTML answer', async () => {
  const missing = harness({ proxy: () => ({ status: 404, data: { name: 'NotFoundError', data: { message: 'nope' } } }) });
  await handleOpencodeV2Request({ type: 'question:reply', id: 1, requestId: 'que_1', answers: [] }, missing.deps);
  assert.equal(missing.proxied.length, 1, 'no second path is tried');
  assert.equal(missing.sent[0].status, 404);

  const html = harness({ proxy: () => ({ status: 200, data: '<!doctype html>\n<html lang="en">' }) });
  await handleOpencodeV2Request({ type: 'question:reply', id: 2, requestId: 'que_1', answers: [] }, html.deps);
  assert.deepEqual(html.sent, [{ type: 'question:reply:result', id: 2, ok: false, status: 502, error: 'OpenCode did not accept the question reply' }]);

  const noId = harness();
  await handleOpencodeV2Request({ type: 'question:reply', id: 3, answers: [] }, noId.deps);
  assert.deepEqual(noId.proxied, []);
  assert.equal(noId.sent[0].status, 400);
});

test('runtime MCP register body is McpLocalConfig / McpRemoteConfig, never type stdio', () => {
  assert.deepEqual(
    buildOpencodeRuntimeMcpConfig({ command: 'node', args: ['/x/index.js'], env: { A: '1' } }),
    { type: 'local', command: ['node', '/x/index.js'], environment: { A: '1' }, enabled: true },
  );
  assert.deepEqual(
    buildOpencodeRuntimeMcpConfig({ command: ['npx', '-y', 'srv'], enabled: false }),
    { type: 'local', command: ['npx', '-y', 'srv'], enabled: false },
  );
  assert.deepEqual(
    buildOpencodeRuntimeMcpConfig({ url: 'https://mcp.example/sse', headers: { Authorization: 'x' } }),
    { type: 'remote', url: 'https://mcp.example/sse', headers: { Authorization: 'x' }, enabled: true },
  );
  const already = { type: 'local', command: ['node'], environment: {} };
  assert.deepEqual(buildOpencodeRuntimeMcpConfig(already), already);
});

test('permission:saved:list reads the saved rules from the shared serve', async () => {
  const rows = [{ id: 'psv_1', projectID: 'prj', action: 'bash', resource: 'git status *' }];
  const h = harness({ proxy: () => ({ status: 200, data: { data: rows } }) });
  await handleOpencodeV2Request({ type: 'permission:saved:list', id: 1, projectID: 'prj 1' }, h.deps);
  assert.deepEqual(h.proxied, [['GET', '/api/permission/saved?projectID=prj%201', null, 10000, 'http://serve-of/shared']]);
  assert.deepEqual(h.sent, [{ type: 'permission:saved:list:result', id: 1, status: 200, data: rows }]);

  const all = harness({ proxy: () => ({ status: 200, data: { data: [] } }) });
  await handleOpencodeV2Request({ type: 'permission:saved:list', id: 2 }, all.deps);
  assert.equal(all.proxied[0][1], '/api/permission/saved');
  assert.deepEqual(all.sent[0].data, []);

  // An older `opencode serve` answers an unknown route with its web UI.
  const html = harness({ proxy: () => ({ status: 404, data: '<!doctype html><html>' }) });
  await handleOpencodeV2Request({ type: 'permission:saved:list', id: 3 }, html.deps);
  assert.deepEqual(html.sent, [{ type: 'permission:saved:list:result', id: 3, ok: false, status: 404, error: 'Could not list saved approvals' }]);
});

test('permission:saved:remove deletes one rule by id and reports a refusal', async () => {
  const h = harness({ proxy: () => ({ status: 204, data: '' }) });
  await handleOpencodeV2Request({ type: 'permission:saved:remove', id: 1, savedId: 'psv/1' }, h.deps);
  assert.deepEqual(h.proxied, [['DELETE', '/api/permission/saved/psv%2F1', null, 10000, 'http://serve-of/shared']]);
  assert.deepEqual(h.sent, [{ type: 'permission:saved:remove:result', id: 1, status: 204, data: true }]);

  const missing = harness({ proxy: () => ({ status: 404, data: { _tag: 'NotFound', message: 'Saved permission not found' } }) });
  await handleOpencodeV2Request({ type: 'permission:saved:remove', id: 2, savedId: 'psv_9' }, missing.deps);
  assert.deepEqual(missing.sent, [{ type: 'permission:saved:remove:result', id: 2, ok: false, status: 404, error: 'Saved permission not found' }]);

  const noId = harness();
  await handleOpencodeV2Request({ type: 'permission:saved:remove', id: 3 }, noId.deps);
  assert.deepEqual(noId.proxied, []);
  assert.equal(noId.sent[0].status, 400);
});

test('the relay drops sync mirrors and forwards everything else', () => {
  assert.equal(shouldRelayOpencodeV2Message({ type: 'event', eventType: 'sync', event: { type: 'sync', syncEvent: {} } }), false);
  assert.equal(shouldRelayOpencodeV2Message({ type: 'event', eventType: 'message.part.delta', event: {} }), true);
  assert.equal(shouldRelayOpencodeV2Message({ type: 'event', eventType: 'extra.session.status', event: {} }), true);
  assert.equal(shouldRelayOpencodeV2Message({ type: 'server:status', status: 'ready' }), true);
  assert.equal(shouldRelayOpencodeV2Message({ type: 'providers:changed' }), true);
  assert.equal(shouldRelayOpencodeV2Message(null), true);
});

test('server.js wires the module in front of its own switch and advertises capabilities', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  // The handler ends where the next top-level declaration starts.
  const handlerStart = server.indexOf('function handleOpencodeV2Ws(ws) {');
  const handlerEnd = server.indexOf('async function checkOpencodeHealth() {');
  assert.ok(handlerStart > 0 && handlerEnd > handlerStart, 'both ends of the v2 handler are found');
  const handler = server.slice(handlerStart, handlerEnd);
  // The native-run and history-clear guards run first, then the module, then the switch.
  const guard = handler.indexOf('const refused = guardOpencodeV2Request(msg, {');
  const delegate = handler.indexOf('if (await handleOpencodeV2Request(msg, requestDeps)) return;');
  const inline = handler.indexOf('switch (type) {');
  assert.ok(guard > 0 && guard < delegate && delegate < inline, 'guards → module → switch');
  assert.match(handler, /send\(\{ type: 'capabilities', capabilities: opencodeV2WsCapabilities\(\) \}\)/);
  assert.match(handler, /capabilities: opencodeV2WsCapabilities\(\),\s+\}\);\s+break;/);
  // Each moved body is gone from the switch, so there is one implementation.
  for (const type of OPENCODE_V2_WS_MODULE_TYPES) {
    assert.equal(handler.includes(`case '${type}':`), false, `${type} is not answered twice`);
  }
  for (const type of OPENCODE_V2_WS_INLINE_TYPES.filter((t) => t !== 'identify')) {
    assert.equal(handler.includes(`case '${type}':`), true, `${type} is answered inline`);
  }
  // Guards that key on the type name still cover the moved mutations.
  const guards = server.slice(server.indexOf('const OPENCODE_NATIVE_MUTATION_TYPES'), server.indexOf('function broadcastToOpencodeV2Clients'));
  for (const type of ['session:compact', 'permission:reply', 'question:reply']) {
    assert.equal((guards.match(new RegExp(`'${type}'`, 'g')) || []).length, 2, `${type} is in both guard sets`);
  }
  // Mutations the module added join both sets by name.
  assert.equal((guards.match(/\.\.\.OPENCODE_V2_WS_MUTATION_TYPES,/g) || []).length, 2);
  assert.match(handler, /isTurnActive: \(sessionId\) => sendAborts\.has\(sessionId\)/);
  assert.match(server, /if \(!shouldRelayOpencodeV2Message\(data\)\) return;/);
});

test('one event stream on the shared serve: the retired client is gone and the v2 client carries the serve lifecycle', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  // The legacy wrapper (lib/opencode-client.js), its /ws/opencode-skin handler
  // and its client set were removed; nothing may bring them back by name.
  assert.equal(existsSync(new URL('../lib/opencode-client.js', import.meta.url)), false, 'the legacy wrapper is deleted');
  assert.equal(server.includes('opencode-client.js'), false, 'server.js does not import the legacy wrapper');
  assert.equal(server.includes('opencodeClient.'), false, 'no call on the retired client, so no second SSE subscription');
  assert.equal(/installOpencodeClientListener|function handleOpencodeWs\b|_ocpWsClients|broadcastToOpencodeClients\(/.test(server), false);
  assert.equal(server.includes('/ws/opencode-skin'), false);

  // Start: both ways of becoming ready install the v2 listener, connect the
  // v2 client, tell the panel and prewarm MCP, in that order.
  const boot = server.slice(server.indexOf('async function ensureOpencodeServer('), server.indexOf('function stopOpencodeServer('));
  assert.equal((boot.match(/await opencodeV2Client\.connect\(\{ port: _ocpPort \}\)/g) || []).length, 2);
  assert.equal((boot.match(/installOpencodeV2Listener\(\);\s+await opencodeV2Client\.connect\(\{ port: _ocpPort \}\);\s+broadcastToOpencodeV2Clients\(\{ type: 'server:status', status: 'ready', version: _ocpVersion, port: _ocpPort, managed: (?:true|false) \}\);/g) || []).length, 2);
  assert.equal((boot.match(/prewarmOpencodeMcpServers\(\);\s+return true;/g) || []).length, 2);
  // Stop: the managed serve exiting and an explicit stop both disconnect the
  // v2 client and tell the panel the serve is offline.
  const offline = /opencodeV2Client\.disconnect\(\)\.catch\(\(\) => \{\}\);[\s\S]*?broadcastToOpencodeV2Clients\(\{ type: 'server:status', status: 'offline', port: _ocpPort \}\);/;
  const exit = boot.slice(boot.indexOf("_ocpProc.on('exit'"), boot.indexOf('// 3. Poll until ready'));
  assert.match(exit, /_ocpReady = false;\s+clearOpencodeManagedPid\(\);/);
  assert.match(exit, offline);
  const stop = server.slice(server.indexOf('function stopOpencodeServer('), server.indexOf('async function takeoverOpencodeServer('));
  assert.match(stop, offline);
  assert.match(stop, /if \(stopManagedOllama\) \{\s+try \{ stopOllama\(\); \} catch \{\}/);
  // Health is one probe of the shared serve, used by start, takeover and the status routes.
  assert.match(server, /async function checkOpencodeHealth\(\) \{\s+try \{\s+const resp = await fetch\(`\$\{_ocpBaseUrl\(\)\}\/global\/health`/);
  // What the legacy broadcast still did for the live panel: a provider change
  // (five places restart the serve for one) and a history wipe reach it.
  assert.equal((server.match(/broadcastToOpencodeV2Clients\(\{ type: 'providers:changed' \}\);/g) || []).length, 5);
  assert.match(server, /broadcastToOpencodeV2Clients\(\{ type: 'history:cleared', restarted \}\);/);

  const prewarm = server.slice(server.indexOf('async function prewarmOpencodeMcpServers()'), server.indexOf('async function ensureOpencodeServer('));
  assert.match(prewarm, /opencodeV2Client\.mcp\.status\(\)/);
  assert.match(prewarm, /opencodeV2Client\.mcp\.connect\(\{ name \}\)/);
  assert.match(server, /config: buildOpencodeRuntimeMcpConfig\(mcpConfig\)/);
  assert.equal(server.includes("type: 'stdio', ...mcpConfig"), false);
});

// ── Cluster 3: session lifecycle ────────────────────────────────────────────

// The `session` and `message` tables as OpenCode 1.18.34 creates them (the
// columns the query reads).
function openSessionDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE session (
      id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text,
      slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL, version text NOT NULL,
      share_url text, time_created integer NOT NULL, time_updated integer NOT NULL,
      time_compacting integer, time_archived integer
    );
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  `);
  const add = db.prepare('INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, share_url, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  add.run('ses_root', 'p', null, 'calm-river', '/work/app', 'Fix the login bug', '1', null, 100, 500, null);
  add.run('ses_child', 'p', 'ses_root', 'wild-fox', '/work/app', 'explore: find callers', '1', null, 200, 400, null);
  add.run('ses_shared', 'q', null, 'red-moon', '/work/site', '100% coverage_plan', '1', 'https://opncd.ai/s/abc', 300, 300, 0);
  add.run('ses_archived', 'q', null, 'old-tree', '/work/site', 'Old work', '1', null, 50, 200, 1791058500000);
  const msg = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, 1, 1, ?)');
  msg.run('m1', 'ses_root', '{}');
  msg.run('m2', 'ses_root', '{}');
  return db;
}
const listIds = (db, options) => {
  const q = buildSessionListQuery(options);
  return db.prepare(q.sql).all(...q.params).map((row) => row.id);
};

test('session list: default is every live session, newest first, un-archived (0) included', () => {
  const db = openSessionDb();
  assert.deepEqual(listIds(db, {}), ['ses_root', 'ses_child', 'ses_shared']);
  assert.deepEqual(listIds(db, undefined), ['ses_root', 'ses_child', 'ses_shared']);
  assert.deepEqual(listIds(db, { archived: true }), ['ses_archived']);
  assert.deepEqual(listIds(db, { roots: true }), ['ses_root', 'ses_shared']);
  db.close();
});

test('session list: search matches title, slug and directory, with LIKE wildcards taken literally', () => {
  const db = openSessionDb();
  assert.deepEqual(listIds(db, { search: 'LOGIN' }), ['ses_root']);
  assert.deepEqual(listIds(db, { search: 'wild-fox' }), ['ses_child']);
  assert.deepEqual(listIds(db, { search: '/work/site' }), ['ses_shared']);
  assert.deepEqual(listIds(db, { search: '/work/site', archived: true }), ['ses_archived']);
  assert.deepEqual(listIds(db, { search: '100%' }), ['ses_shared']);
  assert.deepEqual(listIds(db, { search: 'coverage_plan' }), ['ses_shared']);
  assert.deepEqual(listIds(db, { search: '%' }), ['ses_shared'], 'a bare % is not match-everything');
  assert.deepEqual(listIds(db, { search: '_' }), ['ses_shared']);
  assert.deepEqual(listIds(db, { search: "x' OR 1=1 --" }), []);
  assert.deepEqual(listIds(db, { search: '   ' }), ['ses_root', 'ses_child', 'ses_shared']);
  db.close();
});

test('session list: limit is bounded and optional', () => {
  const db = openSessionDb();
  assert.deepEqual(listIds(db, { limit: 2 }), ['ses_root', 'ses_child']);
  assert.deepEqual(listIds(db, { limit: 0 }), ['ses_root', 'ses_child', 'ses_shared']);
  assert.deepEqual(listIds(db, { limit: 'all' }), ['ses_root', 'ses_child', 'ses_shared']);
  assert.equal(buildSessionListQuery({ limit: 10 ** 9 }).params.at(-1), SESSION_LIST_MAX);
  assert.deepEqual(buildSessionListQuery({}).params, []);
  db.close();
});

test('session list rows carry parentID, share, archive time and the message count', () => {
  const db = openSessionDb();
  const q = buildSessionListQuery({});
  const rows = db.prepare(q.sql).all(...q.params).map(mapSessionListRow);
  assert.deepEqual(rows[0], {
    id: 'ses_root', title: 'Fix the login bug', slug: 'calm-river', directory: '/work/app', projectID: 'p',
    messageCount: 2, time: { created: 100, updated: 500 },
  });
  assert.equal(rows[1].parentID, 'ses_root');
  assert.deepEqual(rows[2].share, { url: 'https://opncd.ai/s/abc' });
  assert.equal('archived' in rows[2].time, false, 'archived = 0 means live');
  const qa = buildSessionListQuery({ archived: true });
  assert.equal(mapSessionListRow(db.prepare(qa.sql).all(...qa.params)[0]).time.archived, 1791058500000);
  db.close();
});

test('the mutations the module adds are named for the server guard sets', () => {
  assert.deepEqual([...OPENCODE_V2_WS_MUTATION_TYPES].sort(), [
    'command:run', 'mcp:add', 'mcp:authenticate', 'mcp:connect', 'mcp:disconnect', 'message:delete', 'session:fork',
    'session:revert', 'session:share', 'session:shell', 'session:unrevert', 'session:unshare',
  ]);
  for (const type of OPENCODE_V2_WS_MUTATION_TYPES) assert.ok(opencodeV2WsCapabilities().includes(type), type);
});

test('session:revert and session:unrevert run on the serve hosting the session', async () => {
  const session = { id: 'ses_1', revert: { messageID: 'msg_2', snapshot: 'abc', diff: '' } };
  const h = harness({ 'extra.session.revert': () => ok(session), 'extra.session.unrevert': () => ok({ id: 'ses_1' }) });
  await handleOpencodeV2Request({ type: 'session:revert', id: 1, sessionId: 'ses_1', messageID: 'msg_2', cwd: '/p' }, h.deps);
  await handleOpencodeV2Request({ type: 'session:revert', id: 2, sessionId: 'ses_1', messageId: 'msg_2', partID: 'prt_1' }, h.deps);
  await handleOpencodeV2Request({ type: 'session:unrevert', id: 3, sessionId: 'ses_1' }, h.deps);
  assert.deepEqual(h.calls.filter(([role]) => role !== 'resolve'), [
    ['bound', 'extra.session.revert', { sessionID: 'ses_1', messageID: 'msg_2', partID: undefined, directory: '/p' }],
    ['bound', 'extra.session.revert', { sessionID: 'ses_1', messageID: 'msg_2', partID: 'prt_1', directory: undefined }],
    ['bound', 'extra.session.unrevert', { sessionID: 'ses_1', directory: undefined }],
  ]);
  assert.deepEqual(h.sent[0], { type: 'session:revert:result', id: 1, status: 200, data: session });
  assert.deepEqual(h.sent[2], { type: 'session:unrevert:result', id: 3, status: 200, data: { id: 'ses_1' } });

  const noMessage = harness();
  await handleOpencodeV2Request({ type: 'session:revert', id: 4, sessionId: 'ses_1' }, noMessage.deps);
  assert.deepEqual(noMessage.sent, [{ type: 'session:revert:result', id: 4, ok: false, status: 400, error: 'messageID is required' }]);
});

test('revert, restore and message delete are refused while a turn is running', async () => {
  const h = harness({ activeTurns: ['ses_busy'] });
  for (const [i, msg] of [
    { type: 'session:revert', sessionId: 'ses_busy', messageID: 'm' },
    { type: 'session:unrevert', sessionId: 'ses_busy' },
    { type: 'message:delete', sessionId: 'ses_busy', messageID: 'm' },
  ].entries()) {
    await handleOpencodeV2Request({ ...msg, id: i }, h.deps);
    assert.equal(h.sent[i].status, 409, msg.type);
    assert.equal(h.sent[i].ok, false);
    assert.match(h.sent[i].error, /^Stop the running turn before you /);
  }
  assert.deepEqual(h.calls, [], 'OpenCode is not called');
});

test('session:fork and session:children use the shared serve', async () => {
  const forked = { id: 'ses_fork', title: 'T (fork #1)' };
  const h = harness({ 'extra.session.fork': () => ok(forked), 'extra.session.children': () => ok([{ id: 'ses_c', parentID: 'ses_1' }]) });
  await handleOpencodeV2Request({ type: 'session:fork', id: 1, sessionId: 'ses_1', messageID: 'msg_3', cwd: '/p' }, h.deps);
  await handleOpencodeV2Request({ type: 'session:fork', id: 2, sessionId: 'ses_1' }, h.deps);
  await handleOpencodeV2Request({ type: 'session:children', id: 3, sessionId: 'ses_1' }, h.deps);
  assert.deepEqual(h.calls, [
    ['shared', 'extra.session.fork', { sessionID: 'ses_1', messageID: 'msg_3', directory: '/p' }],
    ['shared', 'extra.session.fork', { sessionID: 'ses_1', messageID: undefined, directory: undefined }],
    ['shared', 'extra.session.children', { sessionID: 'ses_1', directory: undefined }],
  ]);
  assert.deepEqual(h.sent[0], { type: 'session:fork:result', id: 1, status: 200, data: forked });
  assert.deepEqual(h.sent[2].data, [{ id: 'ses_c', parentID: 'ses_1' }]);
});

test('message:delete removes one message on the serve hosting the session', async () => {
  const h = harness({ 'extra.session.deleteMessage': () => ok(true) });
  await handleOpencodeV2Request({ type: 'message:delete', id: 1, sessionId: 'ses_1', messageID: 'msg_9', cwd: '/p' }, h.deps);
  assert.deepEqual(h.calls.at(-1), ['bound', 'extra.session.deleteMessage', { sessionID: 'ses_1', messageID: 'msg_9', directory: '/p' }]);
  assert.deepEqual(h.sent, [{ type: 'message:delete:result', id: 1, status: 200, data: true }]);
  const noId = harness();
  await handleOpencodeV2Request({ type: 'message:delete', id: 2, sessionId: 'ses_1' }, noId.deps);
  assert.equal(noId.sent[0].status, 400);
});

test('session:share is refused when the OpenCode config disables sharing', async () => {
  const disabled = harness({ 'extra.config.get': () => ok({ share: 'disabled' }) });
  await handleOpencodeV2Request({ type: 'session:share', id: 1, sessionId: 'ses_1' }, disabled.deps);
  assert.deepEqual(disabled.sent, [{ type: 'session:share:result', id: 1, ok: false, status: 403, error: 'Sharing is disabled in the OpenCode config.' }]);
  assert.equal(disabled.calls.some(([, key]) => key === 'extra.session.share'), false);

  const shared = { id: 'ses_1', share: { url: 'https://opncd.ai/s/xyz' } };
  const manual = harness({ 'extra.config.get': () => ok({}), 'extra.session.share': () => ok(shared), 'extra.session.unshare': () => ok({ id: 'ses_1' }) });
  await handleOpencodeV2Request({ type: 'session:share', id: 2, sessionId: 'ses_1', cwd: '/p' }, manual.deps);
  await handleOpencodeV2Request({ type: 'session:unshare', id: 3, sessionId: 'ses_1' }, manual.deps);
  assert.deepEqual(manual.calls, [
    ['shared', 'extra.config.get', { directory: '/p' }],
    ['shared', 'extra.session.share', { sessionID: 'ses_1', directory: '/p' }],
    ['shared', 'extra.session.unshare', { sessionID: 'ses_1', directory: undefined }],
  ]);
  assert.deepEqual(manual.sent[0], { type: 'session:share:result', id: 2, status: 200, data: shared });
});

test('session:share:policy reports manual unless the config says otherwise', async () => {
  for (const [config, expected] of [[{}, 'manual'], [{ share: 'auto' }, 'auto'], [{ share: 'disabled' }, 'disabled'], [{ share: 'nonsense' }, 'manual'], [null, 'manual']]) {
    const h = harness({ 'extra.config.get': () => ok(config) });
    await handleOpencodeV2Request({ type: 'session:share:policy', id: 1 }, h.deps);
    assert.deepEqual(h.sent, [{ type: 'session:share:policy:result', id: 1, status: 200, data: { share: expected } }]);
  }
  assert.equal(sharePolicyOf(undefined), 'manual');
});

// ── Cluster 4: composer ─────────────────────────────────────────────────────

test('command:list is asked for the session directory and never ships the templates', async () => {
  const big = 'x'.repeat(16000);
  const h = harness({
    'extra.command.list': () => ok([
      { name: 'init', description: 'guided AGENTS.md setup', source: 'command', template: big, hints: ['$ARGUMENTS'] },
      { name: 'review', description: 'review changes', source: 'command', subtask: true, agent: 'plan', template: big, hints: [] },
      { name: 'customize-opencode', description: 'skill', source: 'skill', template: big },
      { name: 'docs', source: 'weird', template: big },
      { description: 'no name' },
    ]),
  });
  await handleOpencodeV2Request({ type: 'command:list', id: 1, cwd: '/work/app' }, h.deps);
  assert.deepEqual(h.calls, [['shared', 'extra.command.list', { directory: '/work/app' }]]);
  assert.deepEqual(h.sent[0].data, [
    { name: 'init', description: 'guided AGENTS.md setup', source: 'command', hints: ['$ARGUMENTS'] },
    { name: 'review', description: 'review changes', source: 'command', agent: 'plan', subtask: true },
    { name: 'customize-opencode', description: 'skill', source: 'skill' },
    { name: 'docs', description: '', source: 'command' },
  ]);
  assert.ok(JSON.stringify(h.sent[0]).length < 600);
  assert.equal(commandRow(null), null);
});

test('command:run runs session.command on the session serve inside the turn bookkeeping', async () => {
  const reply = { info: { id: 'msg_a', role: 'assistant' }, parts: [] };
  const h = harness({ 'extra.session.command': () => ok(reply) });
  await handleOpencodeV2Request({
    type: 'command:run', id: 1, sessionId: 'ses_1', command: '/review', arguments: 'main', agent: 'plan',
    model: { providerID: 'anthropic', modelID: 'claude-x' }, variant: 'high', cwd: '/work/app', mcpProfile: 'memory',
    parts: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,AA' }],
  }, h.deps);
  const [scopeBegin, resolveTurn, call, scopeEnd] = h.calls;
  assert.deepEqual(scopeBegin, ['scope', 'begin', 'ses_1']);
  assert.deepEqual(resolveTurn, ['resolve', 'turn', ['ses_1', 'memory']]);
  assert.deepEqual(call.slice(0, 3), ['turn', 'extra.session.command', {
    sessionID: 'ses_1', command: 'review', arguments: 'main', agent: 'plan', model: 'anthropic/claude-x',
    variant: 'high', parts: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,AA' }], directory: '/work/app',
  }]);
  assert.ok(call[3].signal instanceof AbortSignal, 'the abort signal of the turn scope is passed on');
  assert.deepEqual(scopeEnd, ['scope', 'end', 'ses_1']);
  assert.deepEqual(h.sent, [{ type: 'command:run:result', id: 1, status: 200, data: reply }]);

  // Defaults: no agent / model / variant / parts are sent as undefined, arguments as ''.
  const bare = harness({ 'extra.session.command': () => ok(reply) });
  await handleOpencodeV2Request({ type: 'command:run', id: 2, sessionId: 'ses_1', command: 'init' }, bare.deps);
  assert.deepEqual(bare.calls[2][2], {
    sessionID: 'ses_1', command: 'init', arguments: '', agent: undefined, model: undefined, variant: undefined, parts: undefined, directory: undefined,
  });
});

test('a failed command still closes its turn scope; a missing command never opens one', async () => {
  const boom = () => { const e = new Error('Command not found: nope'); e.status = 404; throw e; };
  const h = harness({ 'extra.session.command': boom });
  await handleOpencodeV2Request({ type: 'command:run', id: 1, sessionId: 'ses_1', command: 'nope' }, h.deps);
  assert.deepEqual(h.calls.at(-1), ['scope', 'end', 'ses_1']);
  assert.deepEqual(h.sent, [{ type: 'command:run:result', id: 1, ok: false, status: 404, error: 'Command not found: nope' }]);

  const empty = harness();
  await handleOpencodeV2Request({ type: 'command:run', id: 2, sessionId: 'ses_1', command: '  /  ' }, empty.deps);
  await handleOpencodeV2Request({ type: 'session:shell', id: 3, sessionId: 'ses_1', command: '   ' }, empty.deps);
  await handleOpencodeV2Request({ type: 'session:shell', id: 4, sessionId: 'ses_1', command: 'x'.repeat(20001) }, empty.deps);
  assert.deepEqual(empty.calls, []);
  assert.deepEqual(empty.sent.map((m) => m.status), [400, 400, 400]);
});

test('session:shell runs one command on the session serve with the model as an object', async () => {
  const reply = { info: { id: 'msg_a', role: 'assistant' }, parts: [{ type: 'tool', tool: 'bash' }] };
  const h = harness({ 'extra.session.shell': () => ok(reply) });
  await handleOpencodeV2Request({
    type: 'session:shell', id: 1, sessionId: 'ses_1', command: '  git status  ', agent: 'plan',
    model: { providerID: 'opencode', modelID: 'big-pickle' }, cwd: '/work/app',
  }, h.deps);
  await handleOpencodeV2Request({ type: 'session:shell', id: 2, sessionId: 'ses_1', command: 'ls' }, h.deps);
  const shellCalls = h.calls.filter(([, key]) => key === 'extra.session.shell').map(([, , params]) => params);
  assert.deepEqual(shellCalls, [
    { sessionID: 'ses_1', command: 'git status', agent: 'plan', model: { providerID: 'opencode', modelID: 'big-pickle' }, directory: '/work/app' },
    { sessionID: 'ses_1', command: 'ls', agent: 'build', model: undefined, directory: undefined },
  ]);
  assert.equal(h.calls.filter(([role, key]) => role === 'scope' && key === 'end').length, 2);
  assert.deepEqual(h.sent[0], { type: 'session:shell:result', id: 1, status: 200, data: reply });
});

test('find:files searches files and directories of the project, bounded', async () => {
  const many = Array.from({ length: 80 }, (_, i) => `src/file-${i}.js`);
  const h = harness({ 'extra.find.files': () => ok([...many, 7, '']) });
  await handleOpencodeV2Request({ type: 'find:files', id: 1, query: '  file ', cwd: '/work/app' }, h.deps);
  await handleOpencodeV2Request({ type: 'find:files', id: 2, dirs: false }, h.deps);
  assert.deepEqual(h.calls, [
    ['shared', 'extra.find.files', { query: 'file', dirs: 'true', limit: FIND_FILES_LIMIT, directory: '/work/app' }],
    ['shared', 'extra.find.files', { query: '', dirs: 'false', limit: FIND_FILES_LIMIT, directory: undefined }],
  ]);
  assert.equal(h.sent[0].data.length, FIND_FILES_LIMIT);
  assert.equal(h.sent[0].data[0], 'src/file-0.js');
});

// ── Cluster 5: transcript ───────────────────────────────────────────────────

test('session:todo reads the todo list from the serve hosting the session', async () => {
  const todos = [{ content: 'Step 1', status: 'in_progress', priority: 'high' }];
  const h = harness({ 'extra.session.todo': () => ok(todos) });
  await handleOpencodeV2Request({ type: 'session:todo', id: 1, sessionId: 'ses_1', cwd: '/p' }, h.deps);
  assert.deepEqual(h.calls, [['resolve', 'bound', 'ses_1'], ['bound', 'extra.session.todo', { sessionID: 'ses_1', directory: '/p' }]]);
  assert.deepEqual(h.sent, [{ type: 'session:todo:result', id: 1, status: 200, data: todos }]);
  const odd = harness({ 'extra.session.todo': () => ok(null) });
  await handleOpencodeV2Request({ type: 'session:todo', id: 2, sessionId: 'ses_1' }, odd.deps);
  assert.deepEqual(odd.sent[0].data, []);
});

// ── Cluster 6: changes and VCS ──────────────────────────────────────────────

test('file diffs are null-checked and bounded before they go to the panel', () => {
  const big = 'x'.repeat(FILE_DIFF_MAX_PATCH_CHARS + 10);
  const rows = capFileDiffs([
    { file: 'a.js', patch: 'diff --git a/a.js b/a.js', additions: 2, deletions: 1, status: 'modified' },
    { additions: 3, deletions: 0 },                       // SnapshotFileDiff.file and .patch are optional
    { file: 'gen.js', patch: big, additions: '7', deletions: null },
    null, 'nope',
  ]);
  assert.deepEqual(rows[0], { file: 'a.js', patch: 'diff --git a/a.js b/a.js', additions: 2, deletions: 1, status: 'modified' });
  assert.deepEqual(rows[1], { file: '', patch: '', additions: 3, deletions: 0 });
  assert.equal(rows[2].patch.length, FILE_DIFF_MAX_PATCH_CHARS);
  assert.equal(rows[2].patchTruncated, true);
  assert.deepEqual([rows[2].additions, rows[2].deletions], [7, 0]);
  assert.equal(rows.length, 3);
  assert.equal(capFileDiffs(Array.from({ length: FILE_DIFF_MAX_FILES + 50 }, (_, i) => ({ file: `f${i}` }))).length, FILE_DIFF_MAX_FILES);
  assert.deepEqual(capFileDiffs(undefined), []);
});

test('session:diff asks the serve hosting the session, for the session or one message', async () => {
  const diff = [{ file: 'a.js', patch: 'p', additions: 1, deletions: 0, status: 'added' }];
  const h = harness({ 'extra.session.diff': () => ok(diff) });
  await handleOpencodeV2Request({ type: 'session:diff', id: 1, sessionId: 'ses_1', cwd: '/p' }, h.deps);
  await handleOpencodeV2Request({ type: 'session:diff', id: 2, sessionId: 'ses_1', messageID: 'msg_3' }, h.deps);
  assert.deepEqual(h.calls.filter(([role]) => role === 'bound').map(([, , params]) => params), [
    { sessionID: 'ses_1', messageID: undefined, directory: '/p' },
    { sessionID: 'ses_1', messageID: 'msg_3', directory: undefined },
  ]);
  assert.deepEqual(h.sent[0], { type: 'session:diff:result', id: 1, status: 200, data: diff });
});

test('vcs:get / vcs:status / vcs:diff answer for the project directory', async () => {
  // Shapes captured from a live 1.18.34 serve.
  const status = [{ file: 'added.txt', additions: 1, deletions: 0, status: 'added' }];
  const diff = [{ file: 'added.txt', patch: 'diff --git a/added.txt b/added.txt\n+new\n', additions: 1, deletions: 0, status: 'added' }];
  const h = harness({
    'extra.vcs.get': () => ok({ branch: 'main', default_branch: null }),
    'extra.vcs.status': () => ok(status),
    'extra.vcs.diff': () => ok(diff),
  });
  await handleOpencodeV2Request({ type: 'vcs:get', id: 1, cwd: '/work/app' }, h.deps);
  await handleOpencodeV2Request({ type: 'vcs:status', id: 2, cwd: '/work/app' }, h.deps);
  await handleOpencodeV2Request({ type: 'vcs:diff', id: 3, cwd: '/work/app' }, h.deps);
  await handleOpencodeV2Request({ type: 'vcs:diff', id: 4, cwd: '/work/app', mode: 'branch' }, h.deps);
  await handleOpencodeV2Request({ type: 'vcs:diff', id: 5, cwd: '/work/app', mode: 'rm -rf' }, h.deps);
  assert.deepEqual(h.calls, [
    ['shared', 'extra.vcs.get', { directory: '/work/app' }],
    ['shared', 'extra.vcs.status', { directory: '/work/app' }],
    ['shared', 'extra.vcs.diff', { mode: 'git', directory: '/work/app' }],
    ['shared', 'extra.vcs.diff', { mode: 'branch', directory: '/work/app' }],
    ['shared', 'extra.vcs.diff', { mode: 'git', directory: '/work/app' }],
  ]);
  assert.deepEqual(h.sent[0].data, { branch: 'main', defaultBranch: '' });
  assert.deepEqual(h.sent[1].data, status);
  assert.deepEqual(h.sent[2].data, diff);
});

test('worktree:list and worktree:create need the project and a plain name', async () => {
  const tree = { name: 'calm-river', branch: 'opencode/calm-river', directory: '/data/worktree/app/calm-river' };
  // worktree.list answers directory strings on a live 1.18.34 serve; create answers the object.
  const h = harness({ 'extra.worktree.list': () => ok([tree.directory, { name: 'broken' }, '']), 'extra.worktree.create': () => ok(tree) });
  await handleOpencodeV2Request({ type: 'worktree:list', id: 1, cwd: '/work/app' }, h.deps);
  await handleOpencodeV2Request({ type: 'worktree:create', id: 2, cwd: '/work/app', name: 'fix-login' }, h.deps);
  await handleOpencodeV2Request({ type: 'worktree:create', id: 3, cwd: '/work/app' }, h.deps);
  assert.deepEqual(h.calls, [
    ['shared', 'extra.worktree.list', { directory: '/work/app' }],
    ['shared', 'extra.worktree.create', { directory: '/work/app', worktreeCreateInput: { name: 'fix-login' } }],
    ['shared', 'extra.worktree.create', { directory: '/work/app', worktreeCreateInput: {} }],
  ]);
  assert.deepEqual(h.sent[0].data, [{ name: 'calm-river', branch: '', directory: tree.directory }]);
  assert.deepEqual(h.sent[1], { type: 'worktree:create:result', id: 2, status: 200, data: tree });

  const bad = harness();
  await handleOpencodeV2Request({ type: 'worktree:list', id: 4 }, bad.deps);
  await handleOpencodeV2Request({ type: 'worktree:create', id: 5, cwd: '/work/app', name: '../../etc' }, bad.deps);
  await handleOpencodeV2Request({ type: 'worktree:create', id: 6, cwd: '/work/app', name: 'a b; rm -rf /' }, bad.deps);
  assert.deepEqual(bad.calls, []);
  assert.deepEqual(bad.sent.map((m) => m.status), [400, 400, 400]);
});

test('worktree:remove deletes only a directory OpenCode lists as a worktree of that project', async () => {
  const tree = { name: 'calm-river', directory: '/data/worktree/app/calm-river' };
  const h = harness({ 'extra.worktree.list': () => ok([tree.directory]), 'extra.worktree.remove': () => ok(true) });
  await handleOpencodeV2Request({ type: 'worktree:remove', id: 1, cwd: '/work/app', directory: tree.directory }, h.deps);
  assert.deepEqual(h.calls, [
    ['shared', 'extra.worktree.list', { directory: '/work/app' }],
    ['shared', 'extra.worktree.remove', { directory: '/work/app', worktreeRemoveInput: { directory: tree.directory } }],
  ]);
  assert.deepEqual(h.sent, [{ type: 'worktree:remove:result', id: 1, status: 200, data: true }]);

  for (const directory of ['/Users/me', '/work/app', '/data/worktree/app/calm-river/..', '']) {
    const refused = harness({ 'extra.worktree.list': () => ok([tree.directory]), 'extra.worktree.remove': () => ok(true) });
    await handleOpencodeV2Request({ type: 'worktree:remove', id: 2, cwd: '/work/app', directory }, refused.deps);
    assert.equal(refused.calls.some(([, key]) => key === 'extra.worktree.remove'), false, directory || '(empty)');
    assert.equal(refused.sent[0].ok, false);
  }
});

// ── Cluster 7: environment ──────────────────────────────────────────────────

test('mcp:status lists the servers of the session serve, SynaBun first and marked managed', async () => {
  const h = harness({
    'mcp.status': () => ok({
      github: { status: 'needs_auth' },
      SynaBun: { status: 'connected' },
      broken: { status: 'failed', error: 'spawn ENOENT' },
      odd: { status: 'whatever' },
    }),
  });
  await handleOpencodeV2Request({ type: 'mcp:status', id: 1, sessionId: 'ses_1', cwd: '/p' }, h.deps);
  assert.deepEqual(h.calls, [['resolve', 'bound', 'ses_1'], ['bound', 'mcp.status', { directory: '/p' }]]);
  assert.deepEqual(h.sent[0].data, [
    { name: 'SynaBun', status: 'connected', managed: true },
    { name: 'broken', status: 'failed', managed: false, error: 'spawn ENOENT' },
    { name: 'github', status: 'needs_auth', managed: false },
    { name: 'odd', status: 'failed', managed: false },
  ]);
  assert.deepEqual(mcpRows(null), []);
  assert.deepEqual(mcpRows([]), []);
  assert.deepEqual([...MANAGED_MCP_NAMES], ['SynaBun']);
});

test('mcp:connect / mcp:disconnect switch a server and answer the new status; SynaBun is read-only', async () => {
  const h = harness({ 'mcp.status': () => ok({ github: { status: 'connected' } }), 'mcp.connect': () => ok(true), 'mcp.disconnect': () => ok(true) });
  await handleOpencodeV2Request({ type: 'mcp:connect', id: 1, sessionId: 'ses_1', name: 'github', cwd: '/p' }, h.deps);
  await handleOpencodeV2Request({ type: 'mcp:disconnect', id: 2, sessionId: 'ses_1', name: 'github' }, h.deps);
  assert.deepEqual(h.calls.filter(([role]) => role === 'bound').map(([, key, params]) => [key, params]), [
    ['mcp.connect', { name: 'github', directory: '/p' }],
    ['mcp.status', { directory: '/p' }],
    ['mcp.disconnect', { name: 'github', directory: undefined }],
    ['mcp.status', { directory: undefined }],
  ]);
  assert.deepEqual(h.sent[0], { type: 'mcp:connect:result', id: 1, status: 200, data: [{ name: 'github', status: 'connected', managed: false }] });

  const pinned = harness();
  await handleOpencodeV2Request({ type: 'mcp:disconnect', id: 3, sessionId: 'ses_1', name: 'SynaBun' }, pinned.deps);
  await handleOpencodeV2Request({ type: 'mcp:connect', id: 4, sessionId: 'ses_1', name: 'SynaBun' }, pinned.deps);
  await handleOpencodeV2Request({ type: 'mcp:authenticate', id: 5, sessionId: 'ses_1', name: 'SynaBun' }, pinned.deps);
  await handleOpencodeV2Request({ type: 'mcp:connect', id: 6, sessionId: 'ses_1', name: '  ' }, pinned.deps);
  assert.deepEqual(pinned.calls.filter(([role]) => role !== 'resolve'), []);
  assert.deepEqual(pinned.proxied, []);
  assert.deepEqual(pinned.sent.map((m) => m.status), [403, 403, 403, 400]);
});

test('mcp:authenticate posts to the serve hosting the session and reports a failure', async () => {
  const h = harness({ proxy: () => ({ status: 200, data: { status: 'connected' } }) });
  await handleOpencodeV2Request({ type: 'mcp:authenticate', id: 1, sessionId: 'ses_1', name: 'git hub', cwd: '/p' }, h.deps);
  assert.deepEqual(h.proxied, [['POST', '/mcp/git%20hub/auth/authenticate?directory=%2Fp', {}, 300000, 'http://serve-of/ses_1']]);
  assert.deepEqual(h.sent, [{ type: 'mcp:authenticate:result', id: 1, status: 200, data: { status: 'connected' } }]);

  const refused = harness({ proxy: () => ({ status: 400, data: { name: 'McpUnsupportedOAuthError', data: { message: 'This server does not support OAuth' } } }) });
  await handleOpencodeV2Request({ type: 'mcp:authenticate', id: 2, sessionId: 'ses_1', name: 'github' }, refused.deps);
  assert.deepEqual(refused.sent, [{ type: 'mcp:authenticate:result', id: 2, ok: false, status: 400, error: 'This server does not support OAuth' }]);
});

test('env:status reads language servers, formatters and references, each on its own', async () => {
  const h = harness({
    'extra.lsp.status': () => ok([{ id: 'typescript', name: 'typescript', root: '/p', status: 'connected' }]),
    'extra.formatter.status': () => { throw new Error('boom'); },
    proxy: () => ({ status: 200, data: { location: {}, data: [
      { name: 'style-guide', path: '/p/docs/style.md', description: 'House style', source: {} },
      { name: 'internal', path: '/p/x', hidden: true },
      { path: '/p/no-name' },
    ] } }),
  });
  await handleOpencodeV2Request({ type: 'env:status', id: 1, sessionId: 'ses_1', cwd: '/p' }, h.deps);
  assert.deepEqual(h.proxied, [['GET', '/api/reference?directory=%2Fp&location%5Bdirectory%5D=%2Fp', null, 10000, 'http://serve-of/ses_1']]);
  assert.deepEqual(h.sent, [{
    type: 'env:status:result', id: 1, status: 200,
    data: {
      references: [{ name: 'style-guide', description: 'House style', path: '/p/docs/style.md' }],
      lsp: [{ id: 'typescript', name: 'typescript', root: '/p', status: 'connected' }],
      formatter: [],
    },
  }]);
  const fmt = harness({ 'extra.lsp.status': () => ok(null), 'extra.formatter.status': () => ok([{ name: 'prettier', extensions: ['.js', 5], enabled: true }]) });
  await handleOpencodeV2Request({ type: 'env:status', id: 2 }, fmt.deps);
  // The default proxy answer in this harness is not a reference list: none are reported.
  assert.deepEqual(fmt.sent[0].data, { references: [], lsp: [], formatter: [{ name: 'prettier', extensions: ['.js'], enabled: true }] });
});

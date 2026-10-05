// Code review 1 of the OpenCode panel rebuild, server side (F02) and the request
// types the second run added (agents per directory, symbols, MCP resources,
// references, adding an MCP server).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  handleOpencodeV2Request, canonicalizeOpencodeV2Message, guardOpencodeV2Request,
  opencodeV2WsCapabilities, OPENCODE_V2_WS_MUTATION_TYPES, OPENCODE_V2_WS_MODULE_TYPES,
  symbolRow, resourceRows, referenceRows, runtimeMcpConfigFor, MANAGED_MCP_NAMES,
} from '../lib/opencode-v2-ws-requests.js';

function harness(answers = {}) {
  const sent = [];
  const calls = [];
  const groups = (role, prefix) => new Proxy({}, {
    get: (_t, group) => (prefix === '' && group === 'extra' ? groups(role, 'extra.') : new Proxy({}, {
      get: (_g, method) => async (params) => {
        const key = `${prefix}${String(group)}.${String(method)}`;
        calls.push([role, key, params]);
        const answer = answers[key];
        return answer ? answer(params) : { status: 200, data: {} };
      },
    })),
  });
  const proxied = [];
  const deps = {
    send: (data) => sent.push(data),
    shared: groups('shared', ''),
    bound: (sessionId) => { calls.push(['resolve', 'bound', sessionId]); return groups('bound', ''); },
    turn: async (sessionId, profile) => { calls.push(['resolve', 'turn', [sessionId, profile]]); return groups('turn', ''); },
    isTurnActive: () => false,
    turnScope: (sessionId) => { calls.push(['scope', 'begin', sessionId]); return { signal: null, end: () => {} }; },
    proxy: async (...args) => { proxied.push(args); return (answers.proxy || (() => ({ status: 200, data: {} })))(...args); },
    baseUrlFor: (sessionId) => `http://serve-of/${sessionId || 'shared'}`,
    directoryQuery: (cwd) => (cwd ? `?directory=${encodeURIComponent(cwd)}` : ''),
  };
  return { sent, calls, proxied, deps };
}

// ── F02 ─────────────────────────────────────────────────────────────────────

test('F02: a session id is canonicalised once, in place, before anything reads it', () => {
  const padded = { type: 'session:share', sessionId: '  ses_abc123  ' };
  assert.equal(canonicalizeOpencodeV2Message(padded), null);
  assert.equal(padded.sessionId, 'ses_abc123');

  const absent = { type: 'permission:list' };
  assert.equal(canonicalizeOpencodeV2Message(absent), null);
  assert.equal('sessionId' in absent && absent.sessionId != null, false);

  for (const empty of ['', '   ', null]) {
    const msg = { type: 'permission:list', sessionId: empty };
    assert.equal(canonicalizeOpencodeV2Message(msg), null);
    assert.equal(msg.sessionId, undefined, 'an empty id is no id');
  }
  for (const bad of [42, {}, ['ses_x'], 'ses x', 'ses_x\nses_y', 'ses/../x', 'a'.repeat(200)]) {
    const msg = { type: 'session:share', sessionId: bad };
    const refused = canonicalizeOpencodeV2Message(msg);
    assert.equal(refused?.status, 400, `refuses ${JSON.stringify(bad)}`);
  }
});

test('F02: a body may not carry a second session id past the guards', () => {
  const msg = { type: 'session:update', sessionId: 'ses_mine', body: { title: 'x', sessionID: 'ses_protected', sessionId: 'ses_protected' } };
  assert.equal(canonicalizeOpencodeV2Message(msg), null);
  assert.deepEqual(msg.body, { title: 'x' });
});

test('F02: the native-run guards see the same id the SDK call will use', () => {
  const run = { id: 'run-1', claimedBy: 'window-A' };
  const ctx = (overrides = {}) => ({
    historyClearing: false,
    historyWriteTypes: new Set(['session:share', 'session:update']),
    nativeMutationTypes: new Set(['session:share', 'session:update', 'message:send']),
    protectedRunFor: (sessionId) => (sessionId === 'ses_protected' ? run : null),
    ownsRun: () => false,
    ...overrides,
  });
  // A stranger, exact id: refused (this already worked).
  assert.equal(guardOpencodeV2Request({ type: 'session:share', sessionId: 'ses_protected' }, ctx())?.status, 409);
  // A stranger, padded id: this slipped through both guards before.
  for (const padded of [' ses_protected', 'ses_protected ', '\tses_protected\n']) {
    const msg = { type: 'session:share', sessionId: padded };
    const refused = guardOpencodeV2Request(msg, ctx());
    assert.ok(refused, `padded id ${JSON.stringify(padded)} is refused`);
    assert.ok(refused.status === 409 || refused.status === 400);
  }
  // The owner may read, but not mutate, while the automation runs.
  const owner = ctx({ ownsRun: () => true });
  assert.equal(guardOpencodeV2Request({ type: 'session:messages', sessionId: 'ses_protected ' }, owner), null);
  assert.match(guardOpencodeV2Request({ type: 'message:send', sessionId: ' ses_protected' }, owner).error, /Stop the native automation/);
  // An unprotected session passes, and its id comes out trimmed.
  const free = { type: 'session:share', sessionId: ' ses_free ' };
  assert.equal(guardOpencodeV2Request(free, ctx()), null);
  assert.equal(free.sessionId, 'ses_free');
  // History clearing refuses writes.
  assert.equal(guardOpencodeV2Request({ type: 'session:share', sessionId: 'ses_free' }, ctx({ historyClearing: true }))?.status, 409);
  // A malformed id is refused before any lookup.
  let looked = false;
  const refused = guardOpencodeV2Request({ type: 'session:share', sessionId: { toString: () => 'ses_protected' } },
    ctx({ protectedRunFor: () => { looked = true; return null; } }));
  assert.equal(refused.status, 400);
  assert.equal(looked, false);
});

test('F02: every module handler resolves its client with the canonical id', async () => {
  // Types that resolve a per-session client. Each is sent with a padded id; the
  // id the resolver sees and the id the SDK call carries must be the trimmed one.
  const sessionTypes = OPENCODE_V2_WS_MODULE_TYPES.filter((type) => !['permission:saved:list', 'permission:saved:remove',
    'session:share:policy', 'command:list', 'find:files', 'vcs:get', 'vcs:status', 'vcs:diff',
    'worktree:list', 'worktree:create', 'worktree:remove', 'agent:list', 'reference:list'].includes(type));
  for (const type of sessionTypes) {
    const h = harness({
      'extra.config.get': async () => ({ status: 200, data: { share: 'manual' } }),
    });
    await handleOpencodeV2Request({
      type, id: 1, sessionId: '  ses_pad  ', cwd: '/p', messageID: 'msg_1', command: 'review', name: 'ctx7',
      permissionId: 'per_1', response: 'once', requestId: 'q_1', query: 'ab',
      config: { url: 'https://example.test/mcp' },
    }, h.deps);
    for (const call of h.calls) {
      if (call[0] === 'resolve') {
        const seen = Array.isArray(call[2]) ? call[2][0] : call[2];
        assert.equal(seen, 'ses_pad', `${type}: ${call[1]}() got the canonical id`);
      } else if (call[2] && typeof call[2] === 'object' && 'sessionID' in call[2]) {
        assert.equal(call[2].sessionID, 'ses_pad', `${type}: ${call[1]} got the canonical id`);
      }
    }
    for (const args of h.proxied) assert.equal(String(args[4]).includes(' '), false, `${type}: proxy base has no padded id`);
    assert.equal(h.sent.length, 1, `${type} answered once`);
  }
});

test('F02: server.js runs one guard function before the module and the switch, and spreads no body over the id', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  // The handler ends where the next top-level declaration starts.
  const handlerStart = server.indexOf('function handleOpencodeV2Ws(ws) {');
  const handlerEnd = server.indexOf('async function checkOpencodeHealth() {');
  assert.ok(handlerStart > 0 && handlerEnd > handlerStart, 'both ends of the v2 handler are found');
  const handler = server.slice(handlerStart, handlerEnd);
  const guard = handler.indexOf('guardOpencodeV2Request(msg, {');
  const delegate = handler.indexOf('if (await handleOpencodeV2Request(msg, requestDeps)) return;');
  assert.ok(guard > 0 && guard < delegate, 'guard → module');
  // No second, raw lookup left behind.
  assert.equal(handler.includes('activeNativeOpenCodeRunForSession(msg.sessionId)'), false);
  assert.match(handler, /protectedRunFor: activeNativeOpenCodeRunForSession,/);
  // session:update / session:create: the body cannot override the guarded id.
  assert.equal(/sessionID: msg\.sessionId, \.\.\.\(msg\.body/.test(handler), false);
  assert.match(handler, /\.\.\.\(msg\.body \|\| \{\}\), sessionID: msg\.sessionId/);
});

// ── New request types ───────────────────────────────────────────────────────

test('new types are advertised; only mcp:add mutates', () => {
  const caps = opencodeV2WsCapabilities();
  for (const type of ['agent:list', 'find:symbols', 'resource:list', 'reference:list', 'mcp:add']) {
    assert.ok(caps.includes(type), `${type} is advertised`);
  }
  assert.ok(OPENCODE_V2_WS_MUTATION_TYPES.includes('mcp:add'));
  for (const type of ['agent:list', 'find:symbols', 'resource:list', 'reference:list']) {
    assert.equal(OPENCODE_V2_WS_MUTATION_TYPES.includes(type), false);
  }
});

test('agent:list asks for the project directory and returns what the picker needs', async () => {
  const h = harness({
    'extra.app.agents': async () => ({ status: 200, data: [
      { name: 'build', mode: 'primary', description: 'd', permission: { huge: true }, prompt: 'x'.repeat(5000) },
      { name: 'helper', mode: 'subagent', hidden: true },
      null,
    ] }),
  });
  await handleOpencodeV2Request({ type: 'agent:list', id: 3, cwd: '/proj' }, h.deps);
  assert.deepEqual(h.calls[0], ['shared', 'extra.app.agents', { directory: '/proj' }]);
  assert.deepEqual(h.sent[0].data, [
    { name: 'build', mode: 'primary', description: 'd', hidden: false, color: '' },
    { name: 'helper', mode: 'subagent', description: '', hidden: true, color: '' },
  ]);
});

test('find:symbols answers rows with a path and a range; a too-short query asks nothing', async () => {
  assert.deepEqual(symbolRow({ name: 'run', kind: 12, location: { uri: 'file:///p/src/a%20b.js', range: { start: { line: 3, character: 0 }, end: { line: 9, character: 1 } } } }), {
    name: 'run', kind: 12, path: '/p/src/a b.js', range: { start: { line: 3, character: 0 }, end: { line: 9, character: 1 } },
  });
  assert.equal(symbolRow({ name: 'x', location: { uri: 'https://elsewhere/x' } }), null);
  assert.equal(symbolRow({ name: '', location: { uri: 'file:///p/a.js' } }), null);

  const h = harness({
    'extra.find.symbols': async () => ({ status: 200, data: [
      { name: 'run', kind: 12, location: { uri: 'file:///p/a.js', range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } } } },
      { name: 'bad' },
    ] }),
  });
  await handleOpencodeV2Request({ type: 'find:symbols', id: 4, sessionId: 'ses_1', query: 'ru', cwd: '/p' }, h.deps);
  assert.deepEqual(h.calls.find((c) => c[1] === 'extra.find.symbols'), ['bound', 'extra.find.symbols', { query: 'ru', directory: '/p' }]);
  assert.equal(h.sent[0].data.length, 1);

  const empty = harness();
  await handleOpencodeV2Request({ type: 'find:symbols', id: 5, sessionId: 'ses_1', query: ' ' }, empty.deps);
  assert.deepEqual(empty.sent[0].data, []);
  assert.equal(empty.calls.some((c) => c[1] === 'extra.find.symbols'), false);
});

test('resource:list reads the MCP resources of the serve hosting the session', async () => {
  assert.deepEqual(resourceRows({
    'docs:readme': { name: 'readme', uri: 'docs://readme', client: 'docs', description: 'd', mimeType: 'text/markdown' },
    broken: { name: 'x' },
  }), [{ name: 'readme', uri: 'docs://readme', client: 'docs', description: 'd', mimeType: 'text/markdown' }]);
  assert.deepEqual(resourceRows('<!doctype html>'), []);

  const h = harness({ proxy: () => ({ status: 200, data: { a: { name: 'n', uri: 'u://1', client: 'c' } } }) });
  await handleOpencodeV2Request({ type: 'resource:list', id: 6, sessionId: 'ses_1', cwd: '/p' }, h.deps);
  assert.deepEqual(h.proxied[0], ['GET', '/experimental/resource?directory=%2Fp', null, 10000, 'http://serve-of/ses_1']);
  assert.deepEqual(h.sent[0].data, [{ name: 'n', uri: 'u://1', client: 'c', description: '', mimeType: '' }]);
});

test('reference:list drops hidden references and answers name, path, description', async () => {
  assert.deepEqual(referenceRows({ data: [
    { name: 'docs', path: '/refs/docs', description: 'the docs', source: { type: 'local' } },
    { name: 'secret', path: '/refs/secret', hidden: true },
    { name: '', path: '/x' },
  ] }), [{ name: 'docs', path: '/refs/docs', description: 'the docs' }]);
  const h = harness({ proxy: () => ({ status: 200, data: { data: [{ name: 'docs', path: '/refs/docs' }] } }) });
  await handleOpencodeV2Request({ type: 'reference:list', id: 7, sessionId: 'ses_1', cwd: '/p' }, h.deps);
  assert.equal(h.proxied[0][1], '/api/reference?directory=%2Fp&location%5Bdirectory%5D=%2Fp');
  assert.deepEqual(h.sent[0].data, [{ name: 'docs', path: '/refs/docs', description: '' }]);
});

test('mcp:add registers a validated config on the session serve; SynaBun stays read-only', async () => {
  assert.deepEqual(runtimeMcpConfigFor({ command: 'npx', args: ['-y', 'ctx7'], env: { A: '1' } }),
    { ok: true, config: { type: 'local', command: ['npx', '-y', 'ctx7'], environment: { A: '1' }, enabled: true } });
  assert.deepEqual(runtimeMcpConfigFor({ url: 'https://example.test/mcp', headers: { Authorization: 'Bearer x' } }),
    { ok: true, config: { type: 'remote', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer x' }, enabled: true } });
  for (const bad of [null, {}, { url: 'ftp://x' }, { url: 'javascript:alert(1)' }, { command: '' }, { command: ['', ' '] }, { command: 'x', env: { A: 1 } }]) {
    assert.equal(runtimeMcpConfigFor(bad).ok, false, `refuses ${JSON.stringify(bad)}`);
  }

  for (const name of MANAGED_MCP_NAMES) {
    const managed = harness();
    await handleOpencodeV2Request({ type: 'mcp:add', id: 8, sessionId: 'ses_1', name, config: { url: 'https://x.test' } }, managed.deps);
    assert.equal(managed.sent[0].status, 403);
    assert.equal(managed.calls.some((c) => c[1] === 'extra.mcp.add'), false);
  }
  // Case and padding do not get around the managed name.
  const sneaky = harness();
  await handleOpencodeV2Request({ type: 'mcp:add', id: 8, sessionId: 'ses_1', name: ' synabun ', config: { url: 'https://x.test' } }, sneaky.deps);
  assert.equal(sneaky.sent[0].status, 403);

  const badName = harness();
  await handleOpencodeV2Request({ type: 'mcp:add', id: 9, sessionId: 'ses_1', name: 'a b/c', config: { url: 'https://x.test' } }, badName.deps);
  assert.equal(badName.sent[0].status, 400);

  const h = harness({
    'extra.mcp.add': async () => ({ status: 200, data: { ctx7: { status: 'connected' }, SynaBun: { status: 'connected' } } }),
  });
  await handleOpencodeV2Request({ type: 'mcp:add', id: 10, sessionId: 'ses_1', name: 'ctx7', cwd: '/p', config: { command: 'npx', args: ['ctx7'] } }, h.deps);
  assert.deepEqual(h.calls.find((c) => c[1] === 'extra.mcp.add'), ['bound', 'extra.mcp.add', {
    name: 'ctx7', config: { type: 'local', command: ['npx', 'ctx7'], enabled: true }, directory: '/p',
  }]);
  assert.deepEqual(h.sent[0].data.map((row) => row.name), ['SynaBun', 'ctx7']);
});

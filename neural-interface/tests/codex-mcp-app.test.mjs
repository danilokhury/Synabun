import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  APP_RESOURCE_LIMIT, APP_MESSAGE_LIMIT, APP_ARGUMENT_DISPLAY_LIMIT, appArgumentDisplay, appProxyOrigin, filterAppDomains, approvedAppCsp,
  buildAppCsp, buildAppSrcdoc, acceptAppResource, validateAppResources,
  validAppMessage, validAppEvent, validAppResponse, appMethodRoute, APP_METHOD_ROUTES, createAppCallGate, appToolOutcome,
} from '../public/shared/cdx/cdx-mcp-app.js';
import { findCodexAppCard, createCodexAppBoundary } from '../lib/codex-mcp-apps.js';
import { handleCodexCompatMessage, buildCodexCompatParams } from '../lib/codex-compat-rpc.js';
import { CodexCapabilityRegistry } from '../lib/codex-capabilities.js';

const uri = 'ui://fixture/app';
const resource = (text = '<h1>Hello</h1>', extra = {}) => ({ contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text, ...extra }] });

test('proxy origin is the opposite HTTP loopback hostname and never a same-origin fallback', () => {
  assert.equal(appProxyOrigin('http://localhost:3344'), 'http://127.0.0.1:3344');
  assert.equal(appProxyOrigin('http://127.0.0.1:3344'), 'http://localhost:3344');
  for (const origin of ['https://localhost:3344', 'http://[::1]:3344', 'https://example.com', 'bad']) assert.equal(appProxyOrigin(origin), null);
});

test('CSP domains reject HTTP, credentials, paths, private/loopback/IP literals and own origins', () => {
  const rejected = ['http://public.example', 'https://localhost', 'https://a.localhost', 'https://a.local',
    'https://127.0.0.1', 'https://127.1', 'https://2130706433', 'https://0x7f000001', 'https://10.1.2.3',
    'https://172.16.0.1', 'https://192.168.1.1', 'https://169.254.1.1', 'https://100.64.1.1', 'https://0.0.0.0',
    'https://[::1]', 'https://[fc00::1]', 'https://[fe80::1]', 'https://[::ffff:127.0.0.1]',
    'https://user:pass@public.example', 'https://public.example/path', 'https://public.example?q=1',
    'https://public.example#hash', 'https://own.example', 'https://*.own.example'];
  assert.deepEqual(filterAppDomains(rejected, ['http://own.example:3344', 'http://app.own.example:3344']), []);
  assert.deepEqual(filterAppDomains(['https://public.example', 'https://cdn.public.example:443', 'https://public.example/']), ['https://public.example', 'https://cdn.public.example']);
});

test('every wildcard is ignored and CSP caps the combined exact-origin list at 20', () => {
  assert.deepEqual(filterAppDomains(['https://*.public.example', 'https://*.*.public.example', 'https://public.*.example', 'https://*public.example', 'https://*.co.uk', 'https://*.github.io']), []);
  const domains = Array.from({ length: 30 }, (_, i) => `https://d${i}.example`);
  assert.equal(filterAppDomains(domains).length, 20);
  const approved = approvedAppCsp({ csp: { connectDomains: domains.slice(0, 12), resourceDomains: domains.slice(12) } });
  assert.equal(approved.connectDomains.length + approved.resourceDomains.length, 20);
});

test('CSP is deny-by-default, permits only approved origins, ignores frame/base domains and permissions', () => {
  assert.equal(buildAppCsp(), "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; webrtc 'block'");
  const policy = buildAppCsp({ connectDomains: ['https://api.example', 'http://localhost'], resourceDomains: ['https://cdn.example'], frameDomains: ['https://frames.example'], baseUriDomains: ['https://base.example'] });
  assert.match(policy, /connect-src https:\/\/api.example/);
  assert.match(policy, /script-src 'unsafe-inline' https:\/\/cdn.example/);
  assert.doesNotMatch(policy, /localhost|frames\.example|base\.example|'self'/);
});

test('srcdoc puts the host doctype and policy before every untrusted resource byte', () => {
  for (const html of ['<!doctype html><html><head></head></html>', '<meta http-equiv="Content-Security-Policy" content="default-src *">', '<base href="http://localhost"><script>test()</script>']) {
    const doc = buildAppSrcdoc(html);
    assert.ok(doc.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"'));
    assert.ok(doc.indexOf("form-action 'none'") < doc.indexOf(html));
    assert.ok(doc.endsWith(`${html}</body></html>`));
  }
  assert.throws(() => buildAppSrcdoc('x'.repeat(APP_RESOURCE_LIMIT + 1)), /2 MB/);
});

test('app resource acceptance requires ui URI, exact MIME, matching content and bounded decoded UTF-8', () => {
  assert.equal(acceptAppResource(resource(), uri).html, '<h1>Hello</h1>');
  const meta = { csp: { connectDomains: ['https://api.example'] }, permissions: { camera: true } };
  assert.deepEqual(acceptAppResource(resource('html', { _meta: { ui: meta } }), uri).meta, meta);
  assert.equal(acceptAppResource(resource(undefined, { text: undefined, blob: Buffer.from('é').toString('base64') }), uri).html, 'é');
  for (const value of [resource('html', { mimeType: 'text/html' }), resource('html', { uri: 'ui://other' }), resource('html', { blob: 'aA==' }), resource('é'.repeat(APP_RESOURCE_LIMIT / 2 + 1)), resource(undefined, { text: undefined, blob: '!!!!' }), resource(undefined, { text: undefined, blob: '/w==' })]) assert.throws(() => acceptAppResource(value, uri));
  assert.throws(() => acceptAppResource(resource(), 'file:///app'));
  assert.throws(() => acceptAppResource(resource(undefined, { text: undefined, blob: Buffer.alloc(APP_RESOURCE_LIMIT + 1).toString('base64') }), uri));
  assert.equal(acceptAppResource(resource('x'.repeat(APP_RESOURCE_LIMIT)), uri).html.length, APP_RESOURCE_LIMIT);
  assert.equal(acceptAppResource(resource(undefined, { text: undefined, blob: Buffer.alloc(APP_RESOURCE_LIMIT, 65).toString('base64') }), uri).html.length, APP_RESOURCE_LIMIT);
});

test('view resources enforce a cumulative cap for text and binary blobs', () => {
  assert.equal(validateAppResources({ contents: [{ uri: 'file://binary', blob: '/w==' }] }).contents.length, 1);
  assert.throws(() => validateAppResources({ contents: [{ uri, text: 'a'.repeat(APP_RESOURCE_LIMIT) }, { uri, text: 'b' }] }), /2 MB/);
  assert.throws(() => validateAppResources({ contents: [{ uri, blob: 'invalid' }] }));
});

test('message validation rejects malformed objects, ids, method lengths and overlarge params', () => {
  const message = { jsonrpc: '2.0', id: 1, method: 'ping', params: {} };
  assert.equal(validAppMessage(message), true);
  assert.equal(validAppMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }), true);
  for (const data of [null, [], 'json', Object.create({ jsonrpc: '2.0', method: 'ping' }), { ...message, jsonrpc: '1' }, { ...message, id: null }, { ...message, id: false }, { ...message, id: Infinity }, { ...message, method: 'x'.repeat(101) }, { ...message, params: { x: 'x'.repeat(APP_MESSAGE_LIMIT) } }]) assert.equal(validAppMessage(data), false);
  const circular = {}; circular.self = circular;
  assert.equal(validAppMessage({ ...message, params: circular }), false);
  const source = {};
  assert.equal(validAppEvent({ source, origin: 'http://127.0.0.1:1', data: message }, source, 'http://127.0.0.1:1'), true);
  assert.equal(validAppEvent({ source: {}, origin: 'http://127.0.0.1:1', data: message }, source, 'http://127.0.0.1:1'), false);
  assert.equal(validAppEvent({ source, origin: 'null', data: message }, source, 'http://127.0.0.1:1'), false);
});

test('method routing advertises only implemented host methods', () => {
  for (const [method, route] of Object.entries(APP_METHOD_ROUTES)) assert.equal(appMethodRoute(method), route);
  for (const method of ['sampling/createMessage', 'ui/update-model-context', 'ui/download-file', 'tools/list', 'resources/list', 'anything', 'toString', '__proto__']) assert.equal(appMethodRoute(method), 'unsupported');
});

test('teardown responses are structured, correlated, finite and bounded', () => {
  assert.equal(validAppResponse({ jsonrpc: '2.0', id: 'teardown', result: {} }), true);
  for (const value of [[], { jsonrpc: '2.0', id: null, result: {} }, { jsonrpc: '2.0', id: Infinity, result: {} },
    { jsonrpc: '2.0', id: 'x', method: 'ping', result: {} }, { jsonrpc: '2.0', id: 'x' },
    { jsonrpc: '2.0', id: 'x', result: 'x'.repeat(APP_MESSAGE_LIMIT) }]) assert.equal(validAppResponse(value), false);
});

test('explicit single-use approval ignores AUTO, limits pending/in-flight calls and rate', async () => {
  let time = 0, calls = 0, settle;
  const gate = createAppCallGate({ now: () => time, limit: 2 });
  const bridge = () => { calls++; return new Promise(resolve => { settle = resolve; }); };
  await assert.rejects(gate.allow(bridge), /approval/);
  assert.equal(gate.offer({ autoAccept: true }), true); assert.equal(calls, 0);
  assert.equal(gate.offer({}), false); gate.decline(); assert.equal(calls, 0);
  assert.equal(gate.offer({}), true);
  const approved = gate.allow(bridge); assert.equal(calls, 1); assert.equal(gate.offer({}), false);
  settle('ok'); assert.equal(await approved, 'ok');
  await assert.rejects(gate.allow(bridge)); assert.equal(gate.offer({}), false);
  time = 10001; assert.equal(gate.offer({}), true);
});

test('tool lifecycle preserves MCP content and maps failure and pending states', () => {
  assert.equal(appToolOutcome({ status: 'inProgress' }), null);
  assert.equal(appToolOutcome({ status: 'failed' }).method, 'ui/notifications/tool-cancelled');
  assert.equal(appToolOutcome({ status: 'declined' }).method, 'ui/notifications/tool-cancelled');
  const result = { content: [{ type: 'text', text: 'hello' }], structuredContent: { ok: true }, _meta: { extra: true } };
  assert.deepEqual(appToolOutcome({ status: 'completed', result }).params, result);
});

const item = { type: 'mcpToolCall', id: 'call-1', server: 'fixture', mcpAppUi: { resourceUri: uri } };
const packet = { type: 'mcp_app_resource_read', originCallId: item.id, server: 'fixture', threadId: 'thread-1', uri, appResource: true };
const context = (extra = {}) => {
  const calls = [], packets = [];
  return { calls, packets, activeThreadId: 'thread-1', ensureInitialized: async () => {}, registry: new CodexCapabilityRegistry(),
    resolveAppCard: async id => findCodexAppCard({ turns: [{ items: [item] }] }, id),
    request: async (method, params) => { calls.push({ method, params }); return method === 'mcpServer/resource/read' ? resource() : { content: [] }; },
    send: data => packets.push(data), withWriterOperation: async (_, work) => work(), ...extra };
};

test('compat requests bind server and thread to authoritative app cards and reject Assistant', async () => {
  const ctx = context(); await handleCodexCompatMessage(packet, ctx);
  assert.deepEqual(ctx.calls[0], { method: 'mcpServer/resource/read', params: { threadId: 'thread-1', server: 'fixture', uri, originCallId: 'call-1' } });
  for (const [message, extra] of [[{ ...packet, server: 'other' }, {}], [{ ...packet, threadId: 'thread-2' }, {}], [{ ...packet, originCallId: 'missing' }, {}], [packet, { role: 'assistant' }], [packet, { getActiveThreadId: () => 'changed' }], [{ ...packet, uri: 'ui://other' }, {}]]) {
    const denied = context(extra); await handleCodexCompatMessage(message, denied);
    assert.equal(denied.calls.length, 0); assert.equal(denied.packets[0].type, 'error');
  }
});

test('compat tools require explicit approval and strip untrusted routing/metadata', async () => {
  const tool = { ...packet, type: 'mcp_app_tool_call', tool: 'write', arguments: { a: 1 }, _meta: { spoof: true } };
  const denied = context(); await handleCodexCompatMessage(tool, denied); assert.equal(denied.calls.length, 0);
  const allowed = context(); await handleCodexCompatMessage({ ...tool, approved: true }, allowed);
  assert.deepEqual(allowed.calls[0], { method: 'mcpServer/tool/call', params: { threadId: 'thread-1', server: 'fixture', tool: 'write', arguments: { a: 1 } } });
  assert.throws(() => buildCodexCompatParams({ ...tool, approved: true, arguments: [] }), /object/);
  assert.throws(() => buildCodexCompatParams({ ...tool, approved: true, arguments: { a: 'x'.repeat(APP_MESSAGE_LIMIT) } }), /64 KiB/);
});

test('bridge rejects invalid app resources before returning resource bytes', async () => {
  const ctx = context({ request: async () => resource('secret', { mimeType: 'text/html' }) });
  await handleCodexCompatMessage(packet, ctx);
  assert.equal(ctx.packets[0].type, 'error'); assert.equal('resource' in ctx.packets[0], false);
});

test('old CLI and observed unsupported RPCs hide app capabilities', () => {
  for (const cliVersion of ['0.153.4', '0.159.99']) assert.equal(new CodexCapabilityRegistry({ cliVersion }).snapshot().mcp_app_resource_read.supported, false);
  for (const cliVersion of ['0.160.0', '0.161.0', '1.0.0']) assert.equal(new CodexCapabilityRegistry({ cliVersion }).snapshot().mcp_app_resource_read.supported, true);
  const registry = new CodexCapabilityRegistry({ cliVersion: '0.160.0' });
  registry.observe('mcpServer/resource/read', { code: -32601 }); assert.equal(registry.snapshot().mcp_app_resource_read.supported, false);
});

test('complete approval display snapshots exactly what is sent, counting UTF-8 and refusing oversized JSON', () => {
  const original = { tail: 'x'.repeat(3000) + 'END', unicode: 'é', nested: { enabled: true } };
  const display = appArgumentDisplay(original);
  assert.equal(display.text, JSON.stringify(original, null, 2));
  assert.equal(display.size, Buffer.byteLength(display.text));
  assert.deepEqual(display.arguments, original);
  original.nested.enabled = false;
  assert.equal(display.arguments.nested.enabled, true);
  assert.throws(() => appArgumentDisplay({ huge: 'é'.repeat(APP_ARGUMENT_DISPLAY_LIMIT / 2) }), /64 KiB/);
});

test('server card bindings coalesce reads, reject stale work and invalidate on thread changes or rollback', async () => {
  const boundary = createCodexAppBoundary(); let reads = 0;
  const read = async () => { reads++; return { thread: { turns: [{ items: [item] }] } }; };
  const [a, b] = await Promise.all([boundary.resolve('t', item.id, read), boundary.resolve('t', item.id, read)]);
  assert.equal(reads, 1); assert.equal(a, b);
  await boundary.resolve('t', item.id, read); assert.equal(reads, 1);
  boundary.invalidate(); await boundary.resolve('t', item.id, read); assert.equal(reads, 2);
  await boundary.resolve('other', item.id, read); assert.equal(reads, 3);
  let finish;
  const pending = boundary.resolve('t', 'missing', () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve(); boundary.invalidate(); finish({ thread: { turns: [{ items: [{ ...item, id: 'missing' }] }] } });
  await assert.rejects(pending, /binding changed/);
});

test('server connection and card rates run before initialization and authoritative history reads', async () => {
  let time = 0, initialized = 0, reads = 0;
  const boundary = createCodexAppBoundary({ now: () => time, connectionLimit: 3, cardLimit: 2 });
  const ctx = context({ limitAppCall: message => boundary.consume('thread-1', message.originCallId),
    ensureInitialized: async () => { initialized++; },
    resolveAppCard: async () => { reads++; return { server: 'fixture', uri }; } });
  await handleCodexCompatMessage(packet, ctx); await handleCodexCompatMessage(packet, ctx);
  await handleCodexCompatMessage(packet, ctx);
  assert.equal(ctx.packets.at(-1).type, 'error'); assert.equal(reads, 2); assert.equal(initialized, 2);
  await handleCodexCompatMessage({ ...packet, originCallId: 'two' }, ctx);
  await handleCodexCompatMessage({ ...packet, originCallId: 'three' }, ctx);
  assert.equal(ctx.packets.at(-1).type, 'error'); assert.equal(reads, 3);
  time = 10001; await handleCodexCompatMessage(packet, ctx); assert.equal(reads, 4);
});

test('prompt activation waits 800 ms, rearms for geometry and rejects multi-clicks while allowing keyboard clicks', () => {
  const source = readFileSync(new URL('../public/shared/cdx/cdx-mcp-app-host.js', import.meta.url), 'utf8');
  const start = source.indexOf('function armPrompt('), end = source.indexOf('function promptText(', start);
  let time = 0, tick, x = 0, click;
  const box = { getBoundingClientRect: () => ({ x, y: 0, width: 100, height: 50 }) };
  const control = { ...box, disabled: false, addEventListener: (_, handler) => { click = handler; } };
  const context = vm.createContext({ performance: { now: () => time }, requestAnimationFrame: fn => { tick = fn; return 1; }, cancelAnimationFrame: () => {} });
  vm.runInContext(source.slice(start, end), context);
  const stop = context.armPrompt(box, [control], () => null);
  const activate = detail => { let blocked = false; click({ detail, preventDefault() { blocked = true; }, stopImmediatePropagation() {} }); return !blocked; };
  assert.equal(control.disabled, true); assert.equal(activate(0), false);
  time = 799; tick(); assert.equal(control.disabled, true);
  time = 800; tick(); assert.equal(control.disabled, false);
  assert.equal(activate(2), false); assert.equal(activate(0), true); assert.equal(activate(1), true);
  x = 20; assert.equal(activate(1), false); assert.equal(control.disabled, true);
  time = 1599; tick(); assert.equal(control.disabled, true);
  time = 1600; tick(); assert.equal(activate(0), true);
  stop(); assert.equal(control.disabled, true); assert.equal(activate(1), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

process.env.SYNABUN_TYPESAFE = 'off';
const { createWhatsAppApi } = await import('../lib/whatsapp/api.js');

function whatsappError(status, code, message, extra = {}) { return Object.assign(new Error(message), { status, code, ...extra }); }

function fakeOps({ fake = false } = {}) {
  const calls = [];
  const ops = {
    calls,
    status: () => ({ ok: true, v: 1, state: 'connected', mode: 'self', account: { masked: '••••1111', name: 'Me' }, owner: { masked: '••••1111', boundAt: 1 }, counters: { sent: 2 } }),
    setup: async (body) => { calls.push(['setup', body]); if (body.mode === 'bad') throw whatsappError(400, 'BAD_MODE', 'mode must be "self" or "dedicated"', { field: 'mode' }); return { ok: true, next: 'link' }; },
    installConnector: async (body) => { calls.push(['install', body]); return { ok: true, started: true }; },
    cancelInstall: async () => { calls.push(['cancelInstall']); return { ok: true, cancelled: true }; },
    removeConnector: async () => { throw whatsappError(409, 'STILL_LINKED', 'Unlink WhatsApp before removing the connector.'); },
    connectorLog: ({ limit }) => ({ ok: true, lines: ['one'], limit }),
    link: async (body, open) => {
      calls.push(['link', body]);
      if (body.method === 'code' && !body.phone) throw whatsappError(400, 'BAD_PHONE', 'That number is too short.', { field: 'phone' });
      if (body.busy) throw whatsappError(409, 'LINK_BUSY', 'Another SynaBun tab is already linking WhatsApp.');
      const stream = open();
      stream.write({ type: 'state', state: 'linking', phase: 'starting', method: body.method || 'qr' });
      stream.write({ type: 'qr', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', expiresAt: 123 });
      if (body.hold) { stream.onAbort(() => calls.push(['link-aborted'])); calls.push(['link-open']); return; }
      stream.write({ type: 'state', state: 'linking', phase: 'scanned' });
      stream.end({ type: 'linked', mode: 'self' });
      stream.write({ type: 'late' }); // after end: dropped
    },
    confirmOwner: async (body) => { calls.push(['confirm', body]); return { ok: true }; },
    claimOwner: async (body, open) => { const s = open(); s.write({ type: 'claim', code: 'SB-123456', sendTo: '••••1111', waMeUrl: 'https://wa.me/15550001111?text=SB-123456', qrSvg: '<svg/>', expiresAt: 5, attemptsLeft: 5 }); s.end({ type: 'bound', masked: '••••3333' }); },
    resetOwner: async () => ({ ok: true }),
    test: async () => { throw whatsappError(429, 'RATE_LIMITED', 'Wait a few seconds.', { retryAfterMs: 12_400 }); },
    pause: (opts) => { calls.push(['pause', opts]); return { ok: true }; },
    resume: async () => { calls.push(['resume']); return { ok: true }; },
    reconnect: async () => ({ ok: true }),
    unlink: async () => { calls.push(['unlink']); return { ok: true, loggedOut: true }; },
    remove: async (body) => { calls.push(['remove', body]); return { ok: true }; },
    getConfig: () => ({ ok: true, config: { level: 'ask' }, version: 3 }),
    putConfig: async (body) => { calls.push(['putConfig', body]); if (body.expectedVersion === 1) throw whatsappError(409, 'VERSION_CONFLICT', 'WhatsApp settings changed elsewhere; reload and try again.', { version: 3, field: 'version' }); return { ok: true, version: 4 }; },
    listActivity: ({ limit }) => ({ ok: true, entries: [], limit }),
    clearActivity: () => ({ ok: true }),
    newSession: async () => ({ ok: true, session: { id: 'assistant-2', title: 'WhatsApp' } }),
    fakeEnabled: () => fake,
    fake: async (body) => ({ ok: true, action: body.action }),
    boom: () => { throw new Error('kaboom'); },
  };
  return ops;
}

async function startApp(t, { isGuestRequest = () => false, fake = false } = {}) {
  const service = fakeOps({ fake });
  const app = express();
  app.use(express.json());
  let port = 0;
  app.use('/api/whatsapp', createWhatsAppApi({ service, isGuestRequest, port: () => port }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  port = server.address().port;
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const good = () => ({ Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-SynaBun-UI': '1' });
  /** Raw request so Host, Origin and friends can be anything. */
  const call = (method, path, { headers = {}, body, raw } = {}) => new Promise((resolve, reject) => {
    const payload = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: `/api/whatsapp${path}`, headers: { ...headers, ...(payload !== undefined ? { 'Content-Length': Buffer.byteLength(payload) } : {}) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  return { service, call, good, port: () => port };
}

const MUTATING = [
  ['POST', '/setup', { mode: 'self', method: 'qr' }], ['POST', '/connector/install', {}], ['DELETE', '/connector/install', {}], ['DELETE', '/connector', {}],
  ['POST', '/link', { method: 'qr' }], ['POST', '/owner/confirm', { accept: true }], ['POST', '/owner/claim', {}], ['DELETE', '/owner', {}],
  ['POST', '/test', {}], ['POST', '/resume', {}], ['POST', '/reconnect', {}], ['POST', '/unlink', {}], ['POST', '/remove', { deleteConversation: false }],
  ['PUT', '/config', { config: { maxMessages: 5 } }], ['DELETE', '/activity', {}], ['POST', '/session/new', {}],
];
const READS = ['/status', '/connector/log', '/config', '/activity'];

test('guests, tunnels and foreign Host headers never reach any route; nothing is cached; no CORS', async (t) => {
  const guest = await startApp(t, { isGuestRequest: () => true });
  for (const path of READS) assert.equal((await guest.call('GET', path)).json.code, 'GUEST_FORBIDDEN', path);
  assert.equal((await guest.call('POST', '/pause', { headers: { 'Content-Type': 'application/json' }, body: {} })).json.code, 'GUEST_FORBIDDEN');
  const { call, port } = await startApp(t);
  for (const header of ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'via']) {
    const r = await call('GET', '/status', { headers: { [header]: '203.0.113.9' } });
    assert.equal(r.status, 403, header);
    assert.equal(r.json.code, 'REMOTE_FORBIDDEN');
  }
  for (const host of ['evil.example', `evil.example:${port()}`, 'localhost:1', 'localhost', `127.0.0.1.nip.io:${port()}`]) {
    const r = await call('GET', '/status', { headers: { Host: host } });
    assert.equal(r.status, 403, host);
    assert.equal(r.json.code, 'BAD_HOST');
  }
  for (const host of [`localhost:${port()}`, `127.0.0.1:${port()}`, `[::1]:${port()}`]) assert.equal((await call('GET', '/status', { headers: { Host: host } })).status, 200, host);
  const ok = await call('GET', '/status');
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal(ok.json.state, 'connected');
  const refused = await call('GET', '/status', { headers: { 'x-forwarded-for': '1.2.3.4' } });
  assert.equal(refused.headers['cache-control'], 'no-store', 'refusals are not cached either');
  const preflight = await call('OPTIONS', '/setup', { headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-synabun-ui' } });
  for (const r of [ok, refused, preflight]) assert.equal(r.headers['access-control-allow-origin'], undefined);
});

test('every state-changing route needs our Origin, JSON and X-SynaBun-UI, and refuses agent headers', async (t) => {
  const { call, good, port } = await startApp(t);
  for (const [method, path, body] of MUTATING) {
    const label = `${method} ${path}`;
    const { Origin: _origin, ...noOrigin } = good();
    assert.equal((await call(method, path, { headers: noOrigin, body })).json.code, 'BAD_ORIGIN', `${label} without Origin`);
    assert.equal((await call(method, path, { headers: { ...good(), Origin: 'null' }, body })).json.code, 'BAD_ORIGIN', `${label} Origin null`);
    assert.equal((await call(method, path, { headers: { ...good(), Origin: 'https://evil.example' }, body })).json.code, 'BAD_ORIGIN', `${label} cross-site`);
    assert.equal((await call(method, path, { headers: { ...good(), Origin: `http://localhost:${port() + 1}` }, body })).json.code, 'BAD_ORIGIN', `${label} other port`);
    assert.equal((await call(method, path, { headers: { ...good(), 'Sec-Fetch-Site': 'cross-site' }, body })).json.code, 'CROSS_SITE', `${label} sec-fetch-site`);
    const plain = await call(method, path, { headers: { ...good(), 'Content-Type': 'text/plain' }, raw: JSON.stringify(body) });
    assert.equal(plain.status, 415, `${label} text/plain`);
    const { 'X-SynaBun-UI': _ui, ...noUi } = good();
    assert.equal((await call(method, path, { headers: noUi, body })).json.code, 'UI_HEADER_REQUIRED', `${label} without X-SynaBun-UI`);
    for (const agent of ['X-Synabun-Desktop-Grant', 'X-Synabun-Terminal', 'X-Synabun-Role', 'X-Synabun-Assistant']) {
      const r = await call(method, path, { headers: { ...good(), [agent]: 'x' }, body });
      assert.equal(r.status, 403, `${label} ${agent}`);
      assert.equal(r.json.code, 'UI_ONLY', `${label} ${agent}`);
    }
  }
  // …and with everything right, they reach the service.
  assert.equal((await call('POST', '/setup', { headers: good(), body: { mode: 'self', method: 'qr' } })).json.next, 'link');
  assert.equal((await call('POST', '/unlink', { headers: good(), body: {} })).json.loggedOut, true);
});

test('POST /pause is open to agents (it only lowers privileges) but still local-only and JSON-only', async (t) => {
  const { call, service } = await startApp(t);
  const agent = await call('POST', '/pause', { headers: { 'Content-Type': 'application/json', 'X-Synabun-Terminal': 'assistant-1' }, body: {} });
  assert.equal(agent.status, 200);
  assert.deepEqual(service.calls.find(([k]) => k === 'pause')[1], { by: 'agent' });
  const ui = await call('POST', '/pause', { headers: { 'Content-Type': 'application/json' }, body: {} });
  assert.equal(ui.status, 200);
  assert.deepEqual(service.calls.filter(([k]) => k === 'pause')[1][1], { by: 'desktop' });
  assert.equal((await call('POST', '/pause', { headers: { 'Content-Type': 'text/plain' }, raw: '{}' })).status, 415, 'a simple cross-site form post cannot pause');
  assert.equal((await call('POST', '/pause', { headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '1.2.3.4' }, body: {} })).json.code, 'REMOTE_FORBIDDEN');
});

test('POST /link streams NDJSON to the tab that asked; errors before the stream are plain JSON', async (t) => {
  const { call, good } = await startApp(t);
  const r = await call('POST', '/link', { headers: good(), body: { method: 'qr' } });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^application\/x-ndjson/);
  assert.equal(r.headers['cache-control'], 'no-store, no-transform');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.ok(r.text.endsWith('\n'), 'every line ends with a newline');
  const lines = r.text.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((l) => l.type), ['state', 'qr', 'state', 'linked'], 'nothing after end');
  assert.equal(lines[1].svg.startsWith('<svg'), true);
  const bad = await call('POST', '/link', { headers: good(), body: { method: 'code' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json, { ok: false, code: 'BAD_PHONE', error: 'That number is too short.', field: 'phone' });
  const busy = await call('POST', '/link', { headers: good(), body: { busy: true } });
  assert.equal(busy.status, 409);
  assert.equal(busy.json.code, 'LINK_BUSY');
  const claim = await call('POST', '/owner/claim', { headers: good(), body: {} });
  assert.deepEqual(claim.text.trim().split('\n').map((line) => JSON.parse(line).type), ['claim', 'bound']);
});

test('closing the link response tells the service (the tab went away: cancel linking)', async (t) => {
  const { service, good, port } = await startApp(t);
  await new Promise((resolve, reject) => {
    const payload = JSON.stringify({ method: 'qr', hold: true });
    const req = http.request({ host: '127.0.0.1', port: port(), method: 'POST', path: '/api/whatsapp/link', headers: { ...good(), 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      res.setEncoding('utf8');
      let seen = '';
      res.on('data', (chunk) => {
        seen += chunk;
        if (seen.includes('"qr"')) req.destroy();
      });
      res.on('error', () => {});
      res.on('close', resolve);
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
    setTimeout(() => reject(new Error('stream never produced a QR line')), 3000).unref();
  });
  for (let i = 0; i < 50 && !service.calls.some(([k]) => k === 'link-aborted'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(service.calls.some(([k]) => k === 'link-aborted'), 'the service heard the tab leave');
});

test('errors keep their status, code, field, version and retry hint', async (t) => {
  const { call, good } = await startApp(t);
  const linked = await call('DELETE', '/connector', { headers: good(), body: {} });
  assert.deepEqual([linked.status, linked.json.code], [409, 'STILL_LINKED']);
  const slow = await call('POST', '/test', { headers: good(), body: {} });
  assert.equal(slow.status, 429);
  assert.equal(slow.json.code, 'RATE_LIMITED');
  assert.equal(slow.json.retryAfterMs, 12_400);
  assert.equal(slow.headers['retry-after'], '13');
  const stale = await call('PUT', '/config', { headers: good(), body: { config: { maxMessages: 5 }, expectedVersion: 1 } });
  assert.deepEqual([stale.status, stale.json.code, stale.json.version, stale.json.field], [409, 'VERSION_CONFLICT', 3, 'version']);
  const badMode = await call('POST', '/setup', { headers: good(), body: { mode: 'bad' } });
  assert.deepEqual(badMode.json, { ok: false, code: 'BAD_MODE', error: 'mode must be "self" or "dedicated"', field: 'mode' });
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/connector/log?limit=7')).json.limit, '7');
});

test('POST /__fake exists only with SYNABUN_WHATSAPP_FAKE=1 (and keeps the UI guards)', async (t) => {
  const off = await startApp(t);
  assert.equal((await off.call('POST', '/__fake', { headers: off.good(), body: { action: 'scan' } })).status, 404);
  const on = await startApp(t, { fake: true });
  assert.equal((await on.call('POST', '/__fake', { headers: on.good(), body: { action: 'scan' } })).json.action, 'scan');
  const { 'X-SynaBun-UI': _ui, ...noUi } = on.good();
  assert.equal((await on.call('POST', '/__fake', { headers: noUi, body: { action: 'scan' } })).status, 403);
});

test('the real service behind the router: /status carries masked data only, never a secret', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-api-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { createWhatsAppService } = await import('../lib/whatsapp/service.js');
  const listeners = new Map();
  let conn = { state: 'idle', mode: null, registered: false, me: null, owner: null, lastDisconnect: null, retryInMs: null, counters: {}, paused: false, awaitingConfirmUntil: null, claim: null, lastError: null };
  const manager = {
    status: () => ({ host: { state: 'running', pid: 1, restarts: 0, lastError: null }, conn: { ...conn }, runtime: { loaded: true, version: 'fake', fake: true, error: null } }),
    on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); },
    emit: (name, payload) => { for (const fn of listeners.get(name) || []) fn(payload); },
    start: async () => ({ ok: true }), connect: async () => { conn = { ...conn, state: 'connecting' }; manager.emit('state', manager.status()); return { ok: true }; },
    disconnect: async () => ({ ok: true }), stop: async () => ({ ok: true }), killNow: () => {}, send: async () => ({ ok: true, id: 'X' }),
  };
  let kv = null;
  let port = 0;
  const service = createWhatsAppService({
    dataHome: dir, port: () => port, getKvConfig: () => kv, setKvConfig: (_k, v) => { kv = v; },
    managerFactory: () => manager,
    installerFactory: () => ({ status: () => ({ installed: true, version: '7.0.0-rc14', pinned: '7.0.0-rc14', outdated: false }), logTail: () => [] }),
    bridgeFactory: () => ({ onInbound() {}, onConnection() {}, status: () => ({ sessionId: null }), shutdown: async () => {} }),
    env: {},
  });
  const app = express();
  app.use(express.json());
  app.use('/api/whatsapp', service.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  port = server.address().port;
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  // Start linking in-process (a stream the test holds), show a QR and a pairing code.
  const events = [];
  const linking = service._internals.ops.link({ method: 'code', phone: '+1 555 000 1111' }, () => ({ write: (e) => events.push(e), end: (e) => e && events.push(e), onAbort() {}, closed: false }));
  await linking;
  manager.emit('pairing_code', { code: 'ABCD2345', expiresAt: Date.now() + 60_000 });
  manager.emit('qr', { qr: '2@SECRETREF1234567890abcdefXYZ,more', expiresAt: Date.now() + 60_000 });
  conn = { ...conn, me: { masked: '••••1111', name: 'Fake Account' } };
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/whatsapp/status' }, (res) => { let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve(text)); }).on('error', reject);
  });
  assert.ok(events.some((e) => e.type === 'pairing_code' && e.code === 'ABCD-2345'), 'the code went to the stream');
  const json = JSON.parse(status);
  assert.equal(json.state, 'linking');
  for (const secret of ['ABCD2345', 'ABCD-2345', 'SECRETREF', '15550001111', '5550001111', '<svg', '2@']) assert.equal(status.includes(secret), false, secret);
  const keys = [];
  (function walk(value) { if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { keys.push(k); walk(v); } })(json);
  for (const key of ['qr', 'svg', 'qrSvg', 'code', 'number', 'phone', 'text', 'waMeUrl']) assert.equal(keys.includes(key), false, key);
  await service.shutdown({ timeoutMs: 100 });
});

test('the computer-use switch: PUT /config from the page on this computer only (no guest, no agent, no cross-site, no missing UI header)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-api-cu-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { createWhatsAppService } = await import('../lib/whatsapp/service.js');
  const conn = { state: 'open', mode: 'self', registered: true, me: { masked: '••••1111', name: 'Me' }, owner: { bound: true, masked: '••••1111' }, lastDisconnect: null, retryInMs: null, counters: {}, paused: false, awaitingConfirmUntil: null, claim: null, lastError: null };
  const manager = {
    status: () => ({ host: { state: 'running', pid: 1, restarts: 0, lastError: null }, conn: { ...conn }, runtime: { loaded: true, version: 'fake', fake: true, error: null } }),
    on: () => () => {}, start: async () => ({ ok: true }), connect: async () => ({ ok: true }), disconnect: async () => ({ ok: true }), stop: async () => ({ ok: true }), killNow: () => {}, send: async () => ({ ok: true, id: 'X' }),
  };
  let kv = JSON.stringify({ enabled: true, level: 'ask', mode: 'self', owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } });
  let port = 0;
  let guest = false;
  const service = createWhatsAppService({
    dataHome: dir, port: () => port, getKvConfig: () => kv, setKvConfig: (_k, v) => { kv = v; }, isGuestRequest: () => guest,
    managerFactory: () => manager,
    installerFactory: () => ({ status: () => ({ installed: true, version: '7.0.0-rc14', pinned: '7.0.0-rc14', outdated: false }), logTail: () => [] }),
    bridgeFactory: () => ({ onInbound() {}, onConnection() {}, status: () => ({ sessionId: null }), refresh() {}, shutdown: async () => {} }),
    env: {},
  });
  t.after(() => service.killNow());
  const app = express();
  app.use(express.json());
  app.use('/api/whatsapp', service.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  port = server.address().port;
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  await service.start();
  const good = () => ({ Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-SynaBun-UI': '1' });
  const put = (headers, body = { config: { computerUse: true } }) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: '/api/whatsapp/config', headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
  const stored = () => JSON.parse(kv).computerUse === true;
  // A guest (an invite link), whatever headers it sends.
  guest = true;
  assert.deepEqual([(await put(good())).status, (await put(good())).json.code], [403, 'GUEST_FORBIDDEN']);
  guest = false;
  // Not the page: no UI header, another origin, no origin, a tunnel, an agent's own headers.
  const { 'X-SynaBun-UI': _ui, ...noUi } = good();
  assert.equal((await put(noUi)).json.code, 'UI_HEADER_REQUIRED');
  assert.equal((await put({ ...good(), Origin: 'https://evil.example' })).json.code, 'BAD_ORIGIN');
  const { Origin: _origin, ...noOrigin } = good();
  assert.equal((await put(noOrigin)).json.code, 'BAD_ORIGIN');
  assert.equal((await put({ ...good(), 'cf-connecting-ip': '203.0.113.9' })).json.code, 'REMOTE_FORBIDDEN');
  for (const agent of ['X-Synabun-Desktop-Grant', 'X-Synabun-Terminal', 'X-Synabun-Role', 'X-Synabun-Assistant']) {
    const r = await put({ ...good(), [agent]: 'x' });
    assert.deepEqual([r.status, r.json.code], [403, 'UI_ONLY'], agent);
  }
  assert.equal(stored(), false, 'none of them changed it');
  // A non-boolean from the page itself is a 400 naming the field.
  const bad = await put(good(), { config: { computerUse: 'yes' } });
  assert.deepEqual([bad.status, bad.json.code, bad.json.field], [400, 'CONFIG_INVALID', 'computerUse']);
  assert.equal(stored(), false);
  // The page on this computer: saved.
  const ok = await put(good());
  assert.deepEqual([ok.status, ok.json.ok, ok.json.config.computerUse], [200, true, true]);
  assert.equal(stored(), true);
  await service.shutdown({ timeoutMs: 100 });
});

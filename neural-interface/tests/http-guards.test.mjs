// Local-only HTTP guards (lib/http-guards.js): loopback addresses, proxy and
// tunnel headers, Host and Origin checks, the JSON + X-SynaBun-UI gate, agent
// headers, guests, no-store — and never a CORS header on any response.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { hostname } from 'node:os';
import express from 'express';
import {
  AGENT_HEADERS, PROXY_HEADERS, guestForbidden, isLoopbackAddress, noStore, requireJson,
  requireLocal, requireLocalHost, requireSameOriginJson, sendGuardError, uiOnly,
} from '../lib/http-guards.js';

const ok = (req, res) => res.json({ ok: true });

function assertNoCors(headers, label) {
  for (const name of Object.keys(headers)) assert.ok(!name.toLowerCase().startsWith('access-control-'), `${label} carried ${name}`);
}

// Express on 127.0.0.1:0; `mount(app, port)` runs after listen so the guards get the real port.
// call() uses fetch. raw() uses node:http, which sends exactly the headers given (fetch picks its
// own Host) and can send a POST with neither Content-Length nor Transfer-Encoding.
// Every response either returns is checked for Access-Control-* headers.
async function startApp(t, mount) {
  const app = express();
  app.use(express.json());
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const { port } = server.address();
  mount(app, port);
  const finish = (label, status, headers, text) => {
    assertNoCors(headers, label);
    const json = String(headers['content-type'] || '').includes('json') && text ? JSON.parse(text) : null;
    return { status, headers, json };
  };
  const call = async (method, path, { headers = {}, body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
    return finish(`${method} ${path}`, response.status, Object.fromEntries(response.headers), await response.text());
  };
  const raw = async (method, path, headers = {}, { noBody = false } = {}) => {
    const { status, resHeaders, text } = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, resHeaders: res.headers, text }));
      });
      req.on('error', reject);
      if (noBody) { req.removeHeader('content-length'); req.removeHeader('transfer-encoding'); }
      req.end();
    });
    return finish(`${method} ${path} (raw)`, status, resHeaders, text);
  };
  return { port, call, raw };
}

function fakeReq({ remoteAddress, ip, headers = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return { method: 'GET', ip, socket: { remoteAddress }, headers: lower, get(name) { return lower[String(name).toLowerCase()]; } };
}

function fakeRes() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(name, value) { this.headers[String(name).toLowerCase()] = value; return this; },
  };
}

function runGuard(guard, req) {
  const res = fakeRes();
  let passed = false;
  guard(req, res, () => { passed = true; });
  return { passed, status: res.statusCode, body: res.body, headers: res.headers };
}

const REMOTE_FORBIDDEN = { ok: false, code: 'REMOTE_FORBIDDEN', error: 'Only available on the computer running SynaBun.' };
const LOCAL_ONLY = { ok: false, code: 'LOCAL_ONLY', error: 'Open SynaBun on this computer to see this.' };

test('PROXY_HEADERS and AGENT_HEADERS are frozen lower-case lists', () => {
  assert.deepEqual([...PROXY_HEADERS], ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'via']);
  assert.deepEqual([...AGENT_HEADERS], ['x-synabun-desktop-grant', 'x-synabun-terminal', 'x-synabun-role', 'x-synabun-assistant']);
  for (const list of [PROXY_HEADERS, AGENT_HEADERS]) {
    assert.ok(Object.isFrozen(list));
    for (const name of list) assert.equal(name, name.toLowerCase());
  }
});

test('isLoopbackAddress accepts loopback socket addresses and nothing else', () => {
  for (const addr of ['127.0.0.1', '127.1.2.3', '127.0.0.0', '127.255.255.255', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::FFFF:127.0.0.5', '::fFfF:127.9.9.9']) {
    assert.equal(isLoopbackAddress(addr), true, addr);
  }
  const rejects = [
    '::ffff:10.0.0.2', '10.0.0.2', '192.168.1.10', '172.16.0.1', 'fe80::1', '::', '0.0.0.0', '', null, undefined,
    2130706433, {}, ['127.0.0.1'], true, new String('127.0.0.1'),
    'localhost', '127.0.0.256', '127.0.0.1.evil', '::ffff:7f00:1',
    // never what a socket reports: padding, prefixes, zones, leading zeros, other spellings, a second mapping
    ' 127.0.0.1', '127.0.0.1\n', '127.0.0.1/8', '127.0.0', '128.0.0.1', '127.0.0.01', '0127.0.0.1',
    '::1%lo0', '::0:1', '0:0:0:0:0:ffff:127.0.0.1', '::ffff:::ffff:127.0.0.1', '::ffff:localhost',
  ];
  for (const addr of rejects) assert.equal(isLoopbackAddress(addr), false, String(addr));
});

test('requireLocal: a loopback request passes; any proxy or tunnel header refuses, even empty', async (t) => {
  const { call, raw } = await startApp(t, (app) => {
    app.set('trust proxy', true); // must not matter: requireLocal never reads req.ip
    app.get('/local', requireLocal, ok);
  });
  assert.equal((await call('GET', '/local')).status, 200);
  assert.equal((await raw('GET', '/local')).status, 200);
  const values = { 'cf-connecting-ip': '127.0.0.1', 'cf-ray': '8c1f2e3d4a5b6c7d-LHR', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost:3344', 'x-forwarded-proto': 'http', forwarded: 'for=127.0.0.1', 'x-real-ip': '127.0.0.1', via: '1.1 localhost' };
  for (const name of PROXY_HEADERS) {
    for (const value of [values[name] ?? 'x', '']) {
      const r = await raw('GET', '/local', { [name]: value });
      assert.equal(r.status, 403, `${name}: ${JSON.stringify(value)}`);
      assert.deepEqual(r.json, REMOTE_FORBIDDEN);
    }
  }
});

test('requireLocal reads only req.socket.remoteAddress: a LAN client is LOCAL_ONLY whatever req.ip says', () => {
  for (const remoteAddress of ['192.168.1.5', '10.0.0.2', '::ffff:10.0.0.2', 'fe80::1', '::ffff:7f00:1', undefined]) {
    const r = runGuard(requireLocal, fakeReq({ remoteAddress }));
    assert.deepEqual([r.passed, r.status, r.body], [false, 403, LOCAL_ONLY], String(remoteAddress));
  }
  const spoofed = runGuard(requireLocal, fakeReq({ remoteAddress: '192.168.1.5', ip: '127.0.0.1' }));
  assert.deepEqual([spoofed.passed, spoofed.status, spoofed.body], [false, 403, LOCAL_ONLY], 'req.ip is never consulted');
  assert.equal(runGuard(requireLocal, fakeReq({ remoteAddress: '::ffff:127.0.0.1', ip: '10.0.0.2' })).passed, true);
  assert.equal(runGuard(requireLocal, fakeReq({ remoteAddress: '::1' })).passed, true);
  assert.equal(runGuard(requireLocal, { headers: {} }).passed, false, 'no socket: refused');
  const both = runGuard(requireLocal, fakeReq({ remoteAddress: '192.168.1.5', headers: { 'X-Forwarded-For': '127.0.0.1' } }));
  assert.deepEqual(both.body, REMOTE_FORBIDDEN, 'proxy headers are checked first');
});

test('requireLocalHost refuses any Host but localhost / 127.0.0.1 / [::1] on our port (DNS rebinding)', async (t) => {
  const { port, raw } = await startApp(t, (app, port) => app.get('/host', requireLocalHost(port), ok));
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `LocalHost:${port}`]) {
    const r = await raw('GET', '/host', { Host: host });
    assert.equal(r.status, 200, host);
  }
  // Stricter than the WebSocket rule's isAllowedHost on purpose: LAN IPs, other loopback
  // addresses, *.localhost and this machine's name are ours there, never here.
  const machine = hostname().toLowerCase().replace(/\.$/, '').replace(/\.local$/, '');
  const lanAndNames = [`192.168.1.20:${port}`, `127.0.0.2:${port}`, `[fe80::1]:${port}`, `[::ffff:127.0.0.1]:${port}`, `synabun.localhost:${port}`];
  if (/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(machine)) lanAndNames.push(`${machine}:${port}`, `${machine}.local:${port}`);
  for (const host of [`evil.example:${port}`, 'localhost:1', 'localhost', `127.0.0.1.nip.io:${port}`, `localhost.:${port}`, `localhost:${port}.evil.example`, `localhost:0${port}`, '127.0.0.1', '[::1]', ...lanAndNames]) {
    const r = await raw('GET', '/host', { Host: host });
    assert.equal(r.status, 403, host);
    assert.deepEqual(r.json, { ok: false, code: 'BAD_HOST', error: 'Unexpected Host header.' });
  }
  for (const headers of [{}, { host: '' }]) {
    const r = runGuard(requireLocalHost(port), fakeReq({ remoteAddress: '127.0.0.1', headers }));
    assert.deepEqual([r.passed, r.status, r.body?.code], [false, 403, 'BAD_HOST'], JSON.stringify(headers));
  }
  assert.equal(runGuard(requireLocalHost(String(port)), fakeReq({ headers: { host: `localhost:${port}` } })).passed, true, 'a numeric string port works');
  for (const bad of [0, -1, 65536, 3344.5, NaN, '', 'abc', '33 44', null, undefined]) {
    assert.throws(() => requireLocalHost(bad), TypeError, String(bad));
    assert.throws(() => requireSameOriginJson(bad), TypeError, String(bad));
  }
});

test('requireJson accepts JSON bodies only', async (t) => {
  const { call, raw } = await startApp(t, (app) => app.post('/json', requireJson, ok));
  assert.equal((await call('POST', '/json', { headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
  assert.equal((await call('POST', '/json', { headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{"a":1}' })).status, 200);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp']) {
    const r = await call('POST', '/json', { headers: { 'Content-Type': type }, body: 'a=1' });
    assert.equal(r.status, 415, type);
    assert.deepEqual(r.json, { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', error: 'Send JSON (Content-Type: application/json).' });
  }
  const bodiless = await raw('POST', '/json', { 'Content-Type': 'application/json' }, { noBody: true });
  assert.equal(bodiless.status, 415, 'no body: req.is() is null even with a JSON Content-Type');
});

test('requireSameOriginJson: our Origin, then Sec-Fetch-Site, then a JSON body, then X-SynaBun-UI: 1', async (t) => {
  const { port, call, raw } = await startApp(t, (app, port) => {
    app.use('/api', requireSameOriginJson(port));
    app.get('/api/state', ok);
    app.post('/api/state', ok);
    app.delete('/api/state', ok);
  });
  const good = { Origin: `http://localhost:${port}`, 'Content-Type': 'application/json', 'X-SynaBun-UI': '1' };
  const without = (name) => Object.fromEntries(Object.entries(good).filter(([key]) => key !== name));
  const post = (headers, body = '{}') => call('POST', '/api/state', { headers, body });
  const refused = (r, status, code, label = code) => {
    assert.equal(r.status, status, label);
    assert.equal(r.json?.ok, false, label);
    assert.equal(r.json?.code, code, label);
    assert.equal(typeof r.json?.error, 'string', label);
  };

  for (const origin of [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]) {
    const r = await post({ ...good, Origin: origin });
    assert.equal(r.status, 200, origin);
    assert.deepEqual(r.json, { ok: true });
  }
  refused(await post(without('Origin')), 403, 'BAD_ORIGIN', 'no Origin');
  for (const origin of ['null', 'http://evil.example', 'http://localhost:1', `https://localhost:${port}`, `http://localhost:${port}.evil.example`, `http://127.0.0.1.nip.io:${port}`]) {
    refused(await post({ ...good, Origin: origin }), 403, 'BAD_ORIGIN', origin);
  }

  for (const site of ['cross-site', 'same-site', 'none']) refused(await post({ ...good, 'Sec-Fetch-Site': site }), 403, 'CROSS_SITE', site);
  assert.equal((await post({ ...good, 'Sec-Fetch-Site': 'same-origin' })).status, 200);

  refused(await post({ ...good, 'Content-Type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE', 'text/plain');
  refused(await call('POST', '/api/state', { headers: without('Content-Type') }), 415, 'UNSUPPORTED_MEDIA_TYPE', 'fetch POST without a body or Content-Type');
  refused(await raw('POST', '/api/state', good, { noBody: true }), 415, 'UNSUPPORTED_MEDIA_TYPE', 'POST without a body');

  refused(await post(without('X-SynaBun-UI')), 403, 'UI_HEADER_REQUIRED', 'no X-SynaBun-UI');
  for (const value of ['0', 'true', '']) refused(await post({ ...good, 'X-SynaBun-UI': value }), 403, 'UI_HEADER_REQUIRED', `X-SynaBun-UI: ${value}`);

  refused(await post({ Origin: 'http://evil.example', 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain' }), 403, 'BAD_ORIGIN', 'Origin is checked first');
  refused(await post({ Origin: good.Origin, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'text/plain' }), 403, 'CROSS_SITE', 'then Sec-Fetch-Site');
  refused(await post({ Origin: good.Origin, 'Content-Type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE', 'then the body type, before X-SynaBun-UI');

  refused(await call('DELETE', '/api/state'), 403, 'BAD_ORIGIN', 'DELETE is state-changing too');
  assert.equal((await call('DELETE', '/api/state', { headers: good, body: '{}' })).status, 200);

  assert.equal((await call('GET', '/api/state')).status, 200, 'GET needs none of it');
  assert.equal((await call('HEAD', '/api/state')).status, 200, 'HEAD needs none of it');
  assert.equal((await call('OPTIONS', '/api/state', { headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } })).status, 200, 'OPTIONS passes (and gets no CORS grant)');
});

test('uiOnly refuses every agent header, even empty', async (t) => {
  const { call, raw } = await startApp(t, (app) => app.get('/ui', uiOnly, ok));
  assert.equal((await call('GET', '/ui')).status, 200);
  for (const name of AGENT_HEADERS) {
    for (const value of ['assistant-1', '']) {
      const r = await raw('GET', '/ui', { [name]: value });
      assert.equal(r.status, 403, `${name}: ${JSON.stringify(value)}`);
      assert.deepEqual(r.json, { ok: false, code: 'UI_ONLY', error: 'This control is reserved for the user.' });
    }
  }
});

test('guestForbidden refuses guests and fails closed', async (t) => {
  const { call } = await startApp(t, (app) => {
    app.get('/guest', guestForbidden(() => true), ok);
    app.get('/throws', guestForbidden(() => { throw new Error('invite store unavailable'); }), ok);
    app.get('/checked', guestForbidden((req) => req.get('x-test-guest') === '1'), ok);
    app.get('/none', guestForbidden(), ok);
  });
  for (const path of ['/guest', '/throws']) {
    const r = await call('GET', path);
    assert.equal(r.status, 403, path);
    assert.deepEqual(r.json, { ok: false, code: 'GUEST_FORBIDDEN', error: 'Available to the owner only.' });
  }
  assert.equal((await call('GET', '/checked')).status, 200);
  assert.equal((await call('GET', '/checked', { headers: { 'X-Test-Guest': '1' } })).status, 403);
  assert.equal((await call('GET', '/none')).status, 200, 'no predicate: nobody is a guest');
  assert.equal(runGuard(guestForbidden('not a function'), fakeReq()).status, 403, 'an uncallable predicate fails closed');
});

test('noStore sets Cache-Control: no-store; no response ever carries a CORS header', async (t) => {
  const { port, call } = await startApp(t, (app, port) => {
    app.get('/fresh', noStore, ok);
    app.get('/fresh-refused', noStore, guestForbidden(() => true), ok);
    app.use('/api', requireSameOriginJson(port));
    app.post('/api/state', ok);
  });
  const fresh = await call('GET', '/fresh');
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers['cache-control'], 'no-store');
  const refusedFresh = await call('GET', '/fresh-refused');
  assert.equal(refusedFresh.status, 403);
  assert.equal(refusedFresh.headers['cache-control'], 'no-store');
  const unit = runGuard(noStore, fakeReq());
  assert.equal(unit.passed, true);
  assert.equal(unit.headers['cache-control'], 'no-store');

  const good = { Origin: `http://localhost:${port}`, 'Content-Type': 'application/json', 'X-SynaBun-UI': '1' };
  const responses = {
    refusal: await call('POST', '/api/state', { headers: { ...good, Origin: 'http://evil.example' }, body: '{}' }),
    success: await call('POST', '/api/state', { headers: good, body: '{}' }),
    preflight: await call('OPTIONS', '/api/state', { headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-synabun-ui' } }),
  };
  assert.equal(responses.refusal.status, 403);
  assert.equal(responses.success.status, 200);
  for (const [kind, r] of Object.entries(responses)) assert.equal(r.headers['access-control-allow-origin'], undefined, kind);
  // (call() and raw() also assert that no response in this file carries any Access-Control-* header)
});

test('sendGuardError: { ok: false, code, error }, plus field only when given', () => {
  const plain = fakeRes();
  sendGuardError(plain, 403, 'LOCAL_ONLY', 'Open SynaBun on this computer to see this.');
  assert.equal(plain.statusCode, 403);
  assert.deepEqual(plain.body, LOCAL_ONLY);
  const withField = fakeRes();
  sendGuardError(withField, 400, 'NEEDS_COUNTRY_CODE', 'Add your country code first.', 'phone');
  assert.equal(withField.statusCode, 400);
  assert.deepEqual(withField.body, { ok: false, code: 'NEEDS_COUNTRY_CODE', error: 'Add your country code first.', field: 'phone' });
});

// WebSocket upgrade Origin check (cross-site WebSocket hijacking, DNS
// rebinding): the rule in lib/http-guards.js, a live upgrade through a real
// `ws` server gated the way server.js gates it, and a contract that server.js
// applies it to every /ws/* path before any handoff.
process.env.SYNABUN_TYPESAFE = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
// A namespace import: were an export missing, only the tests that call it would fail, not the file.
import * as guards from '../lib/http-guards.js';

const { isAllowedHost, isAllowedWebSocketOrigin, refuseUpgrade } = guards;
const SERVER = readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');
const TUNNEL = 'https://quiet-river-1234.trycloudflare.com';
const req = (headers) => ({ headers });
/** A page served from `host` connecting back to it: Host and Origin name the same server (what a DNS-rebound page sends too). */
const sameOrigin = (host, scheme = 'http') => req({ host, origin: `${scheme}://${host}` });
/** This machine's name without ".local" (os.hostname()), or null when it is not a DNS name a browser could send. */
const MACHINE = (() => {
  const name = String(hostname() || '').toLowerCase().replace(/\.$/, '').replace(/\.local$/, '');
  return /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(name) ? name : null;
})();

test('the rule: no Origin passes, same origin and loopback on the port pass, a foreign one is refused', () => {
  const opts = { port: 3344 };
  assert.equal(isAllowedWebSocketOrigin(req({ host: 'localhost:3344' }), opts), true, 'no Origin: not a browser');
  assert.equal(isAllowedWebSocketOrigin(req({ host: 'localhost:3344', origin: 'http://localhost:3344' }), opts), true, 'same origin');
  assert.equal(isAllowedWebSocketOrigin(req({ host: 'LOCALHOST:3344', origin: 'http://localhost:3344' }), opts), true, 'host case');
  assert.equal(isAllowedWebSocketOrigin(req({ host: '127.0.0.1:3344', origin: 'http://localhost:3344' }), opts), true, 'loopback on the port');
  assert.equal(isAllowedWebSocketOrigin(req({ host: '[::1]:3344', origin: 'http://[::1]:3344' }), opts), true, 'IPv6 loopback');
  assert.equal(isAllowedWebSocketOrigin(req({ host: '192.168.1.20:3344', origin: 'http://192.168.1.20:3344' }), opts), true, 'LAN: the request\'s own host, an IP literal');
  // Changed on purpose (DNS rebinding): an unlisted name in Host + Origin is exactly what a rebound page sends.
  assert.equal(isAllowedWebSocketOrigin(req({ host: 'synabun.example.com', origin: 'https://synabun.example.com' }), opts), false, 'a proxy that keeps an unlisted Host: refused');
  assert.equal(isAllowedWebSocketOrigin(req({ host: 'localhost:3344', origin: 'https://evil.example' }), opts), false, 'a foreign page');
  assert.equal(isAllowedWebSocketOrigin(req({ host: 'localhost:3344', origin: 'http://localhost:5173' }), opts), false, 'loopback on another port');
  assert.equal(isAllowedWebSocketOrigin(req({ host: 'localhost:3344', origin: 'null' }), opts), false, 'sandboxed frame / file: page');
  assert.equal(isAllowedWebSocketOrigin(req({ host: 'localhost:3344', origin: '' }), opts), false, 'empty');
  assert.equal(isAllowedWebSocketOrigin(req({ host: 'localhost:3344', origin: 'chrome-extension://abcdefghijklmnop' }), opts), false, 'an extension');
  assert.equal(isAllowedWebSocketOrigin(req({ host: 'localhost:3344', origin: 'http://localhost:3344, https://evil.example' }), opts), false, 'two Origins joined by a proxy');
  assert.equal(isAllowedWebSocketOrigin(req({ origin: 'http://localhost:3344' }), { port: '3344' }), true, 'no Host: the loopback rule (port as a string)');
});

test('DNS rebinding: Origin == http(s)://<Host> counts only when the Host is one of our own names', () => {
  const opts = { port: 3344 };
  // A rebound page: its name now resolves to this machine, so Host and Origin agree, both naming the attacker's domain.
  for (const host of [
    'attacker.example:3344', 'attacker.example', 'Attacker.Example:3344',
    'localhost.attacker.example:3344', '127.0.0.1.nip.io:3344', '192.168.1.20.nip.io:3344',
    'attacker.example.:3344', 'ATTACKER.EXAMPLE.:3344', 'localhost.attacker.example.:3344',
    'localhost..:3344', 'xlocalhost:3344', 'localhost-attacker.example:3344',
  ]) {
    assert.equal(isAllowedWebSocketOrigin(sameOrigin(host), opts), false, host);
    assert.equal(isAllowedWebSocketOrigin(sameOrigin(host, 'https'), opts), false, `https://${host}`);
  }
  // Names a web page cannot point at this machine: loopback names (case and one trailing dot aside), any IP literal.
  for (const host of [
    'localhost:3344', 'LocalHost:3344', 'localhost.:3344', 'LOCALHOST.:3344', 'synabun.localhost:3344', 'App.LocalHost:3344',
    '127.0.0.1:3344', '127.5.6.7:3344', '[::1]:3344',
    '192.168.1.20:3344', '10.0.0.5:3344', '100.101.102.103:3344', '[fe80::1]:3344', '[2001:db8::1]:3344', '[2001:db8::1]',
  ]) {
    assert.equal(isAllowedWebSocketOrigin(sameOrigin(host), opts), true, host);
  }
  // The Origin must still be that exact server: the same name and port.
  assert.equal(isAllowedWebSocketOrigin(req({ host: '192.168.1.20:3344', origin: 'http://192.168.1.20:8080' }), opts), false, 'another port on the same IP');
  assert.equal(isAllowedWebSocketOrigin(req({ host: '192.168.1.20:3344', origin: 'http://192.168.1.21:3344' }), opts), false, 'another IP');
  // A Host a browser would never send does not count, even when its origin would match.
  for (const [host, origin] of [
    ['user@192.168.1.20:3344', 'http://192.168.1.20:3344'],
    ['192.168.1.20:3344/ws', 'http://192.168.1.20:3344'],
    ['[fe80::1', 'http://[fe80::1]:3344'],
    ['', 'http://192.168.1.20:3344'],
  ]) {
    assert.equal(isAllowedWebSocketOrigin(req({ host, origin }), opts), false, JSON.stringify(host));
  }
});

test('DNS rebinding: this machine\'s name (os.hostname()) and <name>.local count; names that only contain it do not', { skip: !MACHINE && `os.hostname() is not a DNS name: ${hostname()}` }, () => {
  const opts = { port: 3344 };
  for (const host of [`${MACHINE}:3344`, `${MACHINE}.local:3344`, `${MACHINE.toUpperCase()}.LOCAL:3344`, `${MACHINE}.local.:3344`]) {
    assert.equal(isAllowedWebSocketOrigin(sameOrigin(host), opts), true, host);
  }
  for (const host of [`${MACHINE}.attacker.example:3344`, `${MACHINE}.local.attacker.example:3344`, `x${MACHINE}.local:3344`, `${MACHINE}x.local:3344`]) {
    assert.equal(isAllowedWebSocketOrigin(sameOrigin(host), opts), false, host);
  }
});

test('the rule: the tunnel and the invite proxy are allowed only when listed; the list is read only when needed', () => {
  let reads = 0;
  const allowedOrigins = () => { reads += 1; return [TUNNEL, 'https://synabun.example.net/app/']; };
  const opts = { port: 3344, allowedOrigins };
  assert.equal(isAllowedWebSocketOrigin(req({ host: 'localhost:3344', origin: 'http://localhost:3344' }), opts), true);
  assert.equal(reads, 0, 'same origin never reads the tunnel / proxy config');
  for (const host of ['192.168.1.20:3344', 'synabun.localhost:3344', '[fe80::1]:3344']) assert.equal(isAllowedWebSocketOrigin(sameOrigin(host), opts), true, host);
  assert.equal(reads, 0, 'nor does a loopback name or an IP literal');
  assert.equal(isAllowedWebSocketOrigin(sameOrigin('attacker.example:3344'), opts), false, 'a rebound page');
  assert.equal(reads, 1, 'an unknown name reads it once, for both rules that need it');
  assert.equal(isAllowedWebSocketOrigin(req({ host: 'localhost:3344', origin: TUNNEL }), opts), true, 'cloudflared rewrote Host: the tunnel origin');
  assert.equal(isAllowedWebSocketOrigin(req({ host: 'localhost:3344', origin: 'https://synabun.example.net' }), opts), true, 'the invite proxy (path ignored)');
  assert.equal(isAllowedWebSocketOrigin(req({ host: 'localhost:3344', origin: 'https://other-tunnel.trycloudflare.com' }), opts), false);
  assert.equal(isAllowedWebSocketOrigin(req({ host: 'localhost:3344', origin: TUNNEL }), { port: 3344, allowedOrigins: [] }), false, 'no tunnel running');
  assert.equal(isAllowedWebSocketOrigin(req({ host: 'localhost:3344', origin: TUNNEL }), { port: 3344, allowedOrigins: () => { throw new Error('bad file'); } }), false, 'a broken list refuses');
  // Their host names are ours too, for the same-origin rule: a tunnel or proxy that keeps Host.
  assert.equal(isAllowedWebSocketOrigin(sameOrigin('quiet-river-1234.trycloudflare.com', 'https'), opts), true, 'cloudflared kept the tunnel Host');
  assert.equal(isAllowedWebSocketOrigin(sameOrigin('synabun.example.net', 'https'), opts), true, 'the invite proxy kept its Host');
  assert.equal(isAllowedWebSocketOrigin(sameOrigin('synabun.example.net', 'http'), opts), true, 'the listed name over http');
  assert.equal(isAllowedWebSocketOrigin(sameOrigin('synabun.example.net:8443', 'https'), opts), true, 'the listed name on another port');
  assert.equal(isAllowedWebSocketOrigin(sameOrigin('app.synabun.example.net', 'https'), opts), false, 'never a subdomain of a listed name');
  assert.equal(isAllowedWebSocketOrigin(sameOrigin('example.net', 'https'), opts), false, 'nor its parent');
  assert.equal(isAllowedWebSocketOrigin(sameOrigin('other-tunnel.trycloudflare.com', 'https'), opts), false, 'nor another tunnel');
  assert.equal(isAllowedWebSocketOrigin(sameOrigin('synabun.example.net', 'https'), { port: 3344, allowedOrigins: [] }), false, 'the invite proxy not in use');
  assert.equal(isAllowedWebSocketOrigin(sameOrigin('synabun.example.net', 'https'), { port: 3344, allowedOrigins: () => { throw new Error('bad file'); } }), false, 'a broken list refuses the host too');
});

test('isAllowedHost: loopback names, any IP literal, this machine, the listed public hosts; nothing else', () => {
  assert.equal(typeof isAllowedHost, 'function', 'exported');
  const machineName = 'Studio-Mac.local';
  for (const host of [
    // loopback names: case never matters, one trailing dot is the same name
    'localhost', 'localhost:3344', 'LocalHost:3344', 'localhost.', 'localhost.:3344', 'synabun.localhost:3344', 'a.b.localhost', 'App.LocalHost.:80',
    // any IP literal, v4 or v6 (IPv6 in brackets), on any port
    '127.0.0.1:3344', '127.255.255.254', '[::1]:3344', '[::1]', '[0:0:0:0:0:0:0:1]:3344', '0.0.0.0:3344',
    '192.168.1.20:3344', '192.168.1.20:8080', '10.0.0.5', '[fe80::1]:3344', '[2001:db8::1]', '[2001:DB8::1]:3344', '[::ffff:192.168.1.20]:3344',
    // this machine, bare and .local
    'studio-mac:3344', 'studio-mac.local:3344', 'STUDIO-MAC.LOCAL', 'studio-mac.local.:3344',
  ]) {
    assert.equal(isAllowedHost(host, { machineName }), true, host);
  }
  for (const host of [
    // names anyone can point anywhere
    'attacker.example', 'attacker.example:3344', 'Attacker.Example:3344', 'attacker.example.:3344', 'attacker.example..:3344',
    'localhost.attacker.example:3344', 'localhost.attacker.example.', '127.0.0.1.nip.io:3344', 'studio-mac.attacker.example', 'studio-mac.local.attacker.example',
    'xlocalhost:3344', 'localhostx', 'localhost..:3344', '.localhost:3344', 'a..localhost', 'other-mac.local:3344',
    // not a Host header a browser sends: userinfo, paths, %-escapes, whitespace, lists, bad brackets or ports, non-ASCII
    '', ' ', 'localhost :3344', ' localhost:3344', 'localhost:3344 ', 'user@localhost:3344', 'localhost:3344@attacker.example',
    'localhost:3344/x', 'localhost/x', 'localhost:3344?x', 'localhost#x', 'local%68ost:3344', 'localhost\\x', 'localhost:3344, attacker.example', 'a,b',
    '::1', '[::1', '[::1]x', '[::1]:', '[::1]:3344:1', '[fe80::1%25en0]:3344', '[127.0.0.1]', 'localhost:', 'localhost:0', 'localhost:03344', 'localhost:65536',
    '1.2.3.4.5', '999.1.1.1:3344', 'bücher.example', 'http://localhost:3344',
  ]) {
    assert.equal(isAllowedHost(host, { machineName }), false, JSON.stringify(host));
  }
  for (const bad of [undefined, null, 3344, {}, ['localhost'], new String('localhost')]) assert.equal(isAllowedHost(bad, { machineName }), false, String(bad));

  // This machine: os.hostname() by default; a bare name adds <name>.local; an empty, broken or non-name lookup adds nothing.
  assert.equal(isAllowedHost('studio-mac.local', { machineName: 'studio-mac' }), true);
  assert.equal(isAllowedHost('studio-mac', { machineName: () => 'Studio-Mac' }), true);
  for (const name of ['', null, 42, () => { throw new Error('no hostname'); }, 'not a name!', '192.168.1.20']) {
    assert.equal(isAllowedHost('studio-mac.local', { machineName: name }), false, String(name));
  }
  if (MACHINE) {
    assert.equal(isAllowedHost(`${MACHINE}.local:3344`), true, 'os.hostname() by default');
    assert.equal(isAllowedHost(`${MACHINE}:3344`), true, 'os.hostname() by default, bare');
  }

  // The listed public hosts (URLs, host names or host:port), by exact name: never a subdomain, a parent or another scheme's entry.
  const allowedHosts = [TUNNEL, 'https://synabun.example.net/app/', 'proxy.example.org:8443', 'ftp://files.example.org', 'not a url', '', null];
  for (const host of ['quiet-river-1234.trycloudflare.com', 'Quiet-River-1234.TryCloudflare.com.', 'synabun.example.net', 'synabun.example.net:8443', 'proxy.example.org', 'proxy.example.org:8443']) {
    assert.equal(isAllowedHost(host, { allowedHosts, machineName: '' }), true, host);
    assert.equal(isAllowedHost(host, { allowedHosts: () => allowedHosts, machineName: '' }), true, `${host} (a function)`);
  }
  for (const host of ['other.trycloudflare.com', 'trycloudflare.com', 'app.synabun.example.net', 'example.net', 'files.example.org', 'not']) {
    assert.equal(isAllowedHost(host, { allowedHosts, machineName: '' }), false, host);
  }
  assert.equal(isAllowedHost('synabun.example.net', { allowedHosts: 'synabun.example.net', machineName: '' }), false, 'not a list');
  assert.equal(isAllowedHost('synabun.example.net', { allowedHosts: () => { throw new Error('bad file'); }, machineName: '' }), false, 'a broken list refuses');

  // The list is read only when nothing cheaper matched.
  let reads = 0;
  const counted = () => { reads += 1; return [TUNNEL]; };
  for (const host of ['localhost:3344', '192.168.1.20:3344', '[fe80::1]:3344', 'studio-mac.local']) assert.equal(isAllowedHost(host, { allowedHosts: counted, machineName: 'studio-mac' }), true, host);
  assert.equal(reads, 0, 'loopback names, IP literals and this machine never read it');
  assert.equal(isAllowedHost('attacker.example', { allowedHosts: counted, machineName: 'studio-mac' }), false);
  assert.equal(reads, 1);
  assert.equal(isAllowedHost('[::1', { allowedHosts: counted }), false);
  assert.equal(reads, 1, 'nor does a malformed Host');
});

/** A server gated the way server.js gates /ws/* (Origin first, then the handoff). */
async function gatedServer(t, { allowedOrigins = [] } = {}) {
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((_, res) => res.end('ok'));
  let port = 0;
  server.on('upgrade', (request, socket, head) => {
    if (!isAllowedWebSocketOrigin(request, { port, allowedOrigins })) { refuseUpgrade(socket, 403); return; }
    wss.handleUpgrade(request, socket, head, (ws) => { ws.send('hello'); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  t.after(() => new Promise((resolve) => { wss.close(); server.close(resolve); server.closeAllConnections?.(); }));
  return port;
}

/** → { opened, status }. `host` overrides the Host header, the way a rebound name reaches 127.0.0.1. */
function connect(port, origin, host) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sync`, { ...(origin ? { origin } : {}), ...(host ? { headers: { host } } : {}) });
    ws.on('message', () => { ws.close(); resolve({ opened: true, status: 101 }); });
    ws.on('unexpected-response', (_, res) => { resolve({ opened: false, status: res.statusCode }); ws.terminate?.(); });
    ws.on('error', () => resolve({ opened: false, status: null }));
  });
}

test('live upgrade: foreign Origin → 403, same origin → open, no Origin → open, tunnel host → open', async (t) => {
  const port = await gatedServer(t, { allowedOrigins: () => [TUNNEL] });
  assert.deepEqual(await connect(port, 'https://evil.example'), { opened: false, status: 403 });
  assert.deepEqual(await connect(port, `http://127.0.0.1:${port}`), { opened: true, status: 101 });
  assert.deepEqual(await connect(port, `http://localhost:${port}`), { opened: true, status: 101 }, 'loopback on the port');
  assert.deepEqual(await connect(port, null), { opened: true, status: 101 });
  assert.deepEqual(await connect(port, TUNNEL), { opened: true, status: 101 });
});

test('live upgrade: a DNS-rebound page (Host and Origin both the attacker\'s name) → 403; a LAN IP or a *.localhost name → open', async (t) => {
  const port = await gatedServer(t, { allowedOrigins: () => [TUNNEL] });
  assert.deepEqual(await connect(port, `http://attacker.example:${port}`, `attacker.example:${port}`), { opened: false, status: 403 });
  assert.deepEqual(await connect(port, `http://localhost.attacker.example:${port}`, `localhost.attacker.example:${port}`), { opened: false, status: 403 });
  assert.deepEqual(await connect(port, `http://192.168.1.20:${port}`, `192.168.1.20:${port}`), { opened: true, status: 101 });
  assert.deepEqual(await connect(port, `http://synabun.localhost:${port}`, `synabun.localhost:${port}`), { opened: true, status: 101 });
});

test('refuseUpgrade survives a socket that is already gone', () => {
  const calls = [];
  const socket = { writable: false, on: (name) => calls.push(['on', name]), destroy: () => calls.push(['destroy']) };
  refuseUpgrade(socket, 403);
  assert.deepEqual(calls, [['on', 'error'], ['destroy']]);
});

test('server.js: the Origin check runs on every upgrade, after the tunnel check and before any handoff', () => {
  const start = SERVER.indexOf("httpServer.on('upgrade'");
  assert.ok(start > 0);
  const handler = SERVER.slice(start, SERVER.indexOf('\n});', start));
  const check = handler.indexOf('isAllowedWebSocketOrigin(req, { port: PORT, allowedOrigins: publicWebOrigins })');
  assert.ok(check > 0, 'the check is in the upgrade handler');
  assert.ok(handler.indexOf("req.headers['cf-connecting-ip']") < check, 'after the tunnel check');
  assert.ok(check < handler.indexOf('terminalHost.handoffUpgrade('), 'before the terminal handoff to the pty-host');
  assert.ok(check < handler.indexOf('wss.handleUpgrade('), 'before every other /ws/* path');
  assert.match(handler.slice(check, check + 200), /refuseUpgrade\(socket, 403\);\s*return;/);
  // publicWebOrigins is also where the Host allowlist gets its only non-local names (the tunnel and invite proxy hosts).
  const origins = SERVER.slice(SERVER.indexOf('function publicWebOrigins()'), SERVER.indexOf("httpServer.on('upgrade'"));
  assert.match(origins, /if \(tunnelUrl\) origins\.push\(tunnelUrl\)/, 'the running tunnel');
  assert.match(origins, /proxy\?\.useProxy && proxy\.proxyUrl/, 'the invite proxy in use');
  assert.match(SERVER, /import \{ isAllowedHost, isAllowedWebSocketOrigin, refuseUpgrade \} from '\.\/lib\/http-guards\.js';/);
});

test('server.js: a DNS-rebound page cannot add its own name through the invite proxy (PUT /api/invite/proxy checks the Host first)', () => {
  const start = SERVER.indexOf("app.put('/api/invite/proxy'");
  assert.ok(start > 0);
  const handler = SERVER.slice(start, SERVER.indexOf('\n});', start));
  const check = handler.indexOf('isAllowedHost(req.headers.host, { allowedHosts: publicWebOrigins })');
  assert.ok(check > 0, 'the Host check is in the handler');
  assert.ok(check < handler.indexOf('saveInviteProxy('), 'before anything is saved');
  assert.match(handler.slice(check, check + 300), /res\.status\(403\)/);
  // The rule it relies on: a rebound Host is not ours; localhost, an IP and a configured proxy host are.
  assert.equal(guards.isAllowedHost('attacker.example:3344', { allowedHosts: [] }), false);
  assert.equal(guards.isAllowedHost('localhost:3344', { allowedHosts: [] }), true);
  assert.equal(guards.isAllowedHost('192.168.1.20:3344', { allowedHosts: [] }), true);
  assert.equal(guards.isAllowedHost('synabun.example.net', { allowedHosts: ['https://synabun.example.net/app/'] }), true);
});

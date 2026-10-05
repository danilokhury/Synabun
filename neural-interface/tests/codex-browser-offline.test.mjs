import assert from 'node:assert/strict';
import test from 'node:test';
import { guardOfflineRequests, serveOfflineCodexAssets } from './codex-browser-offline.mjs';

async function guardFixture() {
  let http, matchesSocket, socket;
  const assertOffline = await guardOfflineRequests({
    async route(pattern, handler) { assert.equal(pattern, '**/*'); http = handler; },
    async routeWebSocket(pattern, handler) { matchesSocket = pattern; socket = handler; },
  });
  return { http, matchesSocket, socket, assertOffline };
}

test('offline guard permits only fixture HTTP and WebSocket hosts', async () => {
  const guard = await guardFixture();
  let continued = false;
  await guard.http({
    request: () => ({ url: () => 'http://127.0.0.1:1234/fixture' }),
    continue() { continued = true; },
    abort() { assert.fail('Local request was blocked'); },
  });
  assert.equal(continued, true);
  assert.equal(guard.matchesSocket(new URL('ws://127.0.0.1:1234/ws/codex-skin')), false);
  guard.assertOffline();
});

test('offline guard aborts and reports external HTTP and WebSocket attempts', async () => {
  const guard = await guardFixture();
  let aborted, closed = false;
  const url = 'https://cdn.example.test/marked.js';
  await guard.http({
    request: () => ({ url: () => url }),
    continue() { assert.fail('External request was permitted'); },
    abort(reason) { aborted = reason; },
  });
  assert.equal(aborted, 'blockedbyclient');
  assert.equal(guard.matchesSocket(new URL('wss://remote.example.test/socket')), true);
  guard.socket({ url: () => 'wss://remote.example.test/socket', close() { closed = true; } });
  assert.equal(closed, true);
  assert.throws(guard.assertOffline, /Codex browser fixture made no non-loopback requests/);
});

test('real tabs fixture serves optional CDN dependencies locally with no Markdown parser', () => {
  const routes = new Map();
  serveOfflineCodexAssets({ get: (path, handler) => routes.set(path, handler) });
  const sourceAt = path => {
    let source;
    routes.get(path)({}, { type() { return this; }, send(value) { source = value; } });
    return source;
  };
  const tabs = sourceAt('/shared/cdx/cdx-tabs.js');
  assert.doesNotMatch(tabs, /https:\/\/cdn\.jsdelivr\.net/);
  assert.match(tabs, /import\('\/__codex-fixture__\/marked\.js'\)/);
  assert.equal(sourceAt('/__codex-fixture__/marked.js'), 'export const marked = null;');
  assert.equal(sourceAt('/__codex-fixture__/highlight.css'), '');
  assert.equal(sourceAt('/__codex-fixture__/highlight.js'), '');
});

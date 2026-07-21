import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('browser navigation failures replace only the wedged page and preserve its tab pin', () => {
  const server = read('neural-interface/server.js');
  assert.match(server, /async function recoverSessionTabPage\(/);
  assert.match(server, /session\.tabs\.set\(tabId, \{[\s\S]*?page: replacementPage/);
  assert.match(server, /browser:tab-recovered/);
  assert.match(server, /const isRegisteredPage = \(\) => session\.tabs\.get\(tabId\)\?\.page === tabPage/);
  assert.match(server, /recoverBrowserRouteFailure[\s\S]*?'navigate'/);
  assert.match(server, /recoverBrowserRouteFailure[\s\S]*?'reload'/);
  assert.match(server, /BROWSER_EVALUATE_DEADLINE_MS/);
  assert.match(server, /BROWSER_RECOVERY_PROBE_DEADLINE_MS/);
  assert.match(server, /classifyBrowserPageError/);
  assert.match(server, /navigationCircuitOpen: true/);
});

test('stale dialog races are scoped narrowly and page listeners survive retirement', () => {
  const server = read('neural-interface/server.js');
  assert.match(server, /process\.on\('uncaughtException'/);
  assert.match(server, /process\.on\('unhandledRejection'/);
  assert.match(server, /isIgnorablePlaywrightLifecycleError/);
  const wireEvents = server.slice(
    server.indexOf('function wireTabPageEvents'),
    server.indexOf('// Wire events for the first tab'),
  );
  assert.match(wireEvents, /tabPage\.on\('dialog'/);
  assert.match(wireEvents, /tabPage\.on\('close',[\s\S]*?finally[\s\S]*?removeAllListeners/);

  const recovery = server.slice(
    server.indexOf('async function recoverSessionTabPage'),
    server.indexOf('const BROWSER_NAVIGATION_WEDGE_COOLDOWN_MS'),
  );
  assert.doesNotMatch(recovery, /oldPage\?\.removeAllListeners/);
  assert.match(recovery, /onLateResolve/);
  assert.match(recovery, /Verifying replacement browser tab/);
  assert.match(recovery, /browserSessions\.get\(sessionId\) !== session/);
  assert.match(recovery, /session\._invalidating/);
  assert.match(recovery, /destroyBrowserSession\(sessionId\)/);

  const destroy = server.slice(
    server.indexOf('async function destroyBrowserSession'),
    server.indexOf('// ── Tab-level page routing'),
  );
  assert.match(destroy, /_profileMode === 'morelogin'[\s\S]*?session\.browser\.close\(\)/);
  assert.doesNotMatch(destroy, /session\.browser\.disconnect\(\)/);
});

test('failed page replacement invalidates the session without replaying navigation', () => {
  const server = read('neural-interface/server.js');
  assert.match(server, /sessionInvalidated: true/);
  const helpers = read('mcp-server/src/tools/youtube/helpers.ts');
  assert.match(helpers, /!res\.sessionInvalidated && \/Timeout\/i/);
});

test('zero-tab external sessions are revived rather than destroyed as zombies', () => {
  const server = read('neural-interface/server.js');
  const createTab = server.slice(
    server.indexOf('async function createSessionTab'),
    server.indexOf('async function recoverSessionTabPage'),
  );
  assert.match(createTab, /shouldAdoptAsActive/);
  assert.match(createTab, /session\.activeTabId = tabId/);
  const reusable = server.slice(
    server.indexOf('async function findReusableBrowserSession'),
    server.indexOf('// Serializes shared-loop-browser acquisition'),
  );
  assert.match(reusable, /session\.context\.pages\(\)/);
  assert.doesNotMatch(reusable, /session\.page\.evaluate/);
});

test('explicit loop pins still enter MCP stale-tab recovery', () => {
  const service = read('mcp-server/src/services/neural-interface.ts');
  assert.match(service, /pinnedSession && \(!sessionId \|\| sessionId === pinnedSession\)/);
  assert.match(service, /Pinned tab \$\{resolvedTabId\} not found[\s\S]*?\/api\/loop\/recover-browser/);
});

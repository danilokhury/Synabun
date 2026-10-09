// While MoreLogin is the default browser, every schedule / loop / dispatched run
// drives the default MoreLogin profile — never managed Chrome or a mirror — and
// localhost opens there like any other page. Exercises the real server.js
// functions (vm slices) with the browser, MoreLogin and file system stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import { attachConsoleBuffer } from '../lib/browser-console.js';
import { resolveBrowserLanguage } from '../lib/browser-language.js';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const between = (start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `server.js marker not found: ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `server.js end marker not found: ${end}`);
  return source.slice(from, to);
};
const MORELOGIN_BLOCKS = ['// ── MoreLogin blocks', '/**\n * Launch a browser session.'];

const ENV = '2072008039271567360';
const moreLoginConfig = () => ({ connectMode: 'morelogin', moreloginEnvId: ENV, userDataDir: '/Users/me/Apps/Synabun/data/chrome-profile' });
const PORT_MESSAGE = (port) => `MoreLogin blocked localhost:${port}. Most likely the profile's Port scan protection: add ${port} to its Advanced settings → Port scan protection allowed ports in MoreLogin. If a URL Access Restriction in MoreLogin's Security Center blocks localhost, remove localhost from that block policy. Then restart the profile.`;
const stopPage = (blocked) => `https://getip.morelogin.com/black_whiteList_stop_page_v2.html?blockedUrl=${encodeURIComponent(blocked)}`;

function fakeSession(fields = {}) {
  return {
    browser: { isConnected: () => true, wsEndpoint: () => null },
    clients: new Set(),
    context: { pages: () => [] },
    page: { evaluate: async () => 1 },
    tabs: new Map([['first', { page: null }]]),
    activeTabId: 'first',
    _loopOwned: new Set(),
    _interactiveOwned: new Set(),
    _agentOwnedSet: new Set(),
    _tabOwners: new Map(),
    ...fields,
  };
}

// ── Shared-browser acquisition (schedules, loops, dispatched runs, recovery) ──

function acquisitionHarness({ config = moreLoginConfig(), sessions = {}, create } = {}) {
  const browserSessions = new Map(Object.entries(sessions));
  const logs = [];
  const created = [];
  const destroyed = [];
  let tabSeq = 0;
  const context = vm.createContext({
    console, Promise, resolve, DATA_HOME: '/Users/me/.synabun',
    browserSessions,
    agentRegistry: new Map(),
    loadBrowserConfig: () => ({ ...config }),
    isAttachConfigActive: () => false,
    loopLog: (owner, tag, message, data) => logs.push({ owner, tag, message, data }),
    broadcastSync: () => {},
    destroyBrowserSession: async (id) => { destroyed.push(id); browserSessions.delete(id); },
    createSessionTab: async (session) => {
      const tabId = `tab-${++tabSeq}`;
      session.tabs.set(tabId, { page: null });
      return { tabId };
    },
    createBrowserSession: async (opts) => {
      created.push(opts);
      if (create) return create(opts, browserSessions);
      const sessionId = `morelogin-new-${created.length}`;
      browserSessions.set(sessionId, fakeSession({ _profileMode: 'morelogin', _mlEnvId: ENV }));
      return { sessionId, profileMode: 'morelogin', profileSource: `MoreLogin · ${ENV}` };
    },
  });
  vm.runInContext(between('// ── Default-browser policy for automation sessions ──', '/**\n * Relinquish ONE owner'), context);
  return { context, browserSessions, logs, created, destroyed };
}

// A realistic mix of what can be alive when a schedule fires.
const leftovers = () => ({
  // Managed Chrome on the configured data/chrome-profile (would match the userDataDir path check).
  'managed-1': fakeSession({ _profileMode: 'managed', _selectedProfilePath: '/Users/me/Apps/Synabun/data/chrome-profile', _launchUserDataDir: '/Users/me/Apps/Synabun/data/chrome-profile' }),
  // A direct Chrome session on the same profile.
  'direct-1': fakeSession({ _profileMode: 'direct', _selectedProfilePath: '/Users/me/Apps/Synabun/data/chrome-profile' }),
  // MoreLogin sessions on another env, and one with no env recorded.
  'morelogin-other-env': fakeSession({ _profileMode: 'morelogin', _mlEnvId: '999' }),
  'morelogin-no-env': fakeSession({ _profileMode: 'morelogin', _mlEnvId: null }),
});

test('schedule acquisition creates a MoreLogin session when only managed, direct and wrong-env sessions exist', async () => {
  const h = acquisitionHarness({ sessions: leftovers() });
  const acq = await h.context.acquireLoopBrowserAndTab({ terminalSessionId: 'sched-1', logTag: 'schedule:browser' });
  assert.equal(acq.error, undefined);
  assert.equal(acq.browserSessionId, 'morelogin-new-1');
  assert.deepEqual(h.created.map(opts => opts.url), ['about:blank']);
  const chosen = h.browserSessions.get(acq.browserSessionId);
  assert.equal(chosen._profileMode, 'morelogin');
  assert.equal(chosen._mlEnvId, ENV);
  assert.ok(chosen._loopOwned.has('sched-1'));
  assert.equal(chosen._tabOwners.get('sched-1'), acq.browserTabId);
  for (const id of Object.keys(leftovers())) assert.equal(h.browserSessions.get(id)._loopOwned.size, 0, `${id} must not be claimed`);
});

test('a requested managed, direct or wrong-env session is never pinned while MoreLogin is the default', async () => {
  for (const requested of ['managed-1', 'direct-1', 'morelogin-other-env', 'morelogin-no-env']) {
    const h = acquisitionHarness({ sessions: leftovers() });
    const acq = await h.context.acquireLoopBrowserAndTab({ requestedBrowserSessionId: requested, terminalSessionId: `run-${requested}`, logTag: 'assistant:browser' });
    assert.equal(acq.browserSessionId, 'morelogin-new-1', `requested ${requested}`);
    assert.ok(h.logs.some(l => /strategy 0 skipped: requested browser is not the default browser profile/.test(l.message)), `requested ${requested} logged`);
    assert.deepEqual(h.destroyed, [], 'a skipped session is left alone, not destroyed');
  }
});

test('an existing default-env MoreLogin session is reused (one shared MoreLogin browser)', async () => {
  const sessions = { ...leftovers(), 'morelogin-1': fakeSession({ _profileMode: 'morelogin', _mlEnvId: ENV }) };
  const h = acquisitionHarness({ sessions });
  const acq = await h.context.acquireLoopBrowserAndTab({ requestedBrowserSessionId: 'morelogin-1', terminalSessionId: 'loop-1' });
  assert.equal(acq.browserSessionId, 'morelogin-1');
  assert.equal(h.created.length, 0);
  const recovered = await h.context.acquireLoopBrowserAndTab({ terminalSessionId: 'loop-2', logTag: 'recover:browser' });
  assert.equal(recovered.browserSessionId, 'morelogin-1');
});

test('MoreLogin unreachable fails the acquisition loudly with the reason — no managed fallback', async () => {
  const reason = 'MoreLogin connect failed: MoreLogin app is not reachable (MoreLogin API unreachable on :40000 (timeout)). Open the MoreLogin app (or check its Local API on :40000) — sessions will not fall back to Chrome while MoreLogin is the default browser.';
  const h = acquisitionHarness({ sessions: leftovers(), create: async () => { throw new Error(reason); } });
  const acq = await h.context.acquireLoopBrowserAndTab({ terminalSessionId: 'sched-2', logTag: 'schedule:browser' });
  assert.equal(acq.browserSessionId, undefined);
  assert.match(acq.error, /^Could not start the shared browser session: MoreLogin connect failed: MoreLogin app is not reachable/);
  assert.match(acq.error, /will not fall back to Chrome/);
  for (const [id, session] of h.browserSessions) assert.equal(session._loopOwned.size, 0, `${id} must not be claimed`);
});

test('the acquisition invariant refuses a non-MoreLogin session even if one slipped through', async () => {
  const h = acquisitionHarness({
    sessions: {},
    create: async (_opts, sessions) => {
      sessions.set('managed-2', fakeSession({ _profileMode: 'managed' }));
      return { sessionId: 'managed-2', profileMode: 'managed' };
    },
  });
  const acq = await h.context.acquireLoopBrowserAndTab({ terminalSessionId: 'sched-3' });
  assert.match(acq.error, /Refusing browser session managed-2 \(managed mode\): MoreLogin env 2072008039271567360 is the default browser/);
  assert.equal(h.browserSessions.get('managed-2')._loopOwned.size, 0);
});

test('the policy no longer knows any localhost-only session', () => {
  const policy = between('// ── Default-browser policy for automation sessions ──', '/**\n * Relinquish ONE owner');
  assert.doesNotMatch(policy, /loopback|sidecar/i);
  assert.doesNotMatch(source, /ensureLoopbackSidecar|installLoopbackOnlyGuard|handOffRemoteNavigation|LOOPBACK_ONLY_SESSION|_loopbackOnly|_loopbackParentId|_loopbackSidecarId/);
});

// ── createBrowserSession: MoreLogin only, localhost included; MoreLogin down → fail ──

function fakePage(url = 'about:blank', landAt = (next) => next) {
  const listeners = new Map();
  const page = { _url: url, gotos: [] };
  page.goto = async (next) => { page.gotos.push(next); page._url = landAt(next); return { status: () => 200 }; };
  page.url = () => page._url;
  page.title = async () => 'Page';
  page.waitForLoadState = async () => {};
  page.on = (event, fn) => { listeners.set(event, [...(listeners.get(event) || []), fn]); return page; };
  page.listeners = listeners;
  return page;
}

function createSessionHarness({ running = { running: true }, startError, cdpError, landAt } = {}) {
  const launches = [];
  const browserSessions = new Map();
  const page = fakePage('about:blank', landAt);
  const cdpContext = {
    newPage: async () => page,
    newCDPSession: async () => ({ send: async () => ({}), detach: async () => {} }),
    on: () => {},
  };
  const context = vm.createContext({
    console, Promise, URL, setTimeout, Date,
    process: { platform: 'darwin', env: { HOME: '/Users/me' }, pid: 1 },
    IS_WIN: false,
    DATA_HOME: '/Users/me/.synabun',
    resolve, createHash,
    randomBytes: () => ({ toString: () => 'session-under-test' }),
    loadBrowserConfig: () => moreLoginConfig(),
    resolveBrowserLanguage,
    browserConfigUnreadable: () => null,
    findBrowserExecutable: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    getManagedProfileRoot: () => '/Users/me/.synabun/browser-profiles/synabun',
    lookupDetectedProfile: () => null,
    existsSync: () => false,
    moreLogin: {
      isMoreLoginInstalled: () => ({ installed: true, path: '/Applications/MoreLogin.app' }),
      ensureMoreLoginRunning: async () => running,
      getMoreLoginPort: () => 40000,
      ensureDefaultProfile: async () => ({ id: ENV }),
      startProfile: async () => { if (startError) throw new Error(startError); return { debugPort: 51000 }; },
    },
    probeCdpEndpoint: async () => ({ ok: true, httpEndpoint: 'http://127.0.0.1:51000' }),
    chromium: {
      launch: async () => { launches.push('launch'); throw new Error('must not launch Chrome'); },
      launchPersistentContext: async () => { launches.push('launchPersistentContext'); throw new Error('must not launch Chrome'); },
      connectOverCDP: async () => {
        launches.push('connectOverCDP');
        if (cdpError) throw new Error(cdpError);
        return { contexts: () => [cdpContext], isConnected: () => true };
      },
    },
    attachConsoleBuffer,
    installMoneyGuardRoute: async () => {},
    browserSessions,
  });
  vm.runInContext(between(...MORELOGIN_BLOCKS), context);
  vm.runInContext(between('async function createBrowserSession(', '/**\n * Start CDP screencast'), context);
  return { context, launches, page, browserSessions };
}

test('createBrowserSession fails loudly when MoreLogin cannot be reached after auto-launch — no Chrome launch', async () => {
  const h = createSessionHarness({ running: { running: false, launched: true, timedOut: true, error: 'MoreLogin API unreachable on :40000 (timeout)' } });
  await assert.rejects(h.context.createBrowserSession({ url: 'about:blank' }), (err) => {
    assert.match(err.message, /^MoreLogin connect failed: MoreLogin app is not reachable \(MoreLogin API unreachable on :40000 \(timeout\)\)/);
    assert.match(err.message, /sessions will not fall back to Chrome while MoreLogin is the default browser/);
    return true;
  });
  assert.deepEqual(h.launches, []);
});

test('createBrowserSession fails (no fallback) when the MoreLogin profile cannot be started or attached', async () => {
  const h = createSessionHarness({ startError: 'env is busy' });
  await assert.rejects(h.context.createBrowserSession({ url: 'https://bsky.app/' }), /MoreLogin connect failed: env is busy/);
  assert.deepEqual(h.launches, []);
  const attach = createSessionHarness({ cdpError: 'CDP connect refused' });
  await assert.rejects(attach.context.createBrowserSession({ url: 'about:blank' }), /MoreLogin connect failed: CDP connect refused/);
  assert.deepEqual(attach.launches, ['connectOverCDP']);
});

test('a localhost start URL opens in MoreLogin — no sidecar, no Chrome launch', async () => {
  for (const url of ['http://localhost:3344/', 'http://127.0.0.1:9003/deals']) {
    const h = createSessionHarness();
    const result = await h.context.createBrowserSession({ url });
    assert.equal(result.profileMode, 'morelogin', url);
    assert.equal(result.profileSource, `MoreLogin · ${ENV}`);
    assert.equal(result.moreLoginBlocked, null);
    assert.deepEqual(h.launches, ['connectOverCDP'], 'only the MoreLogin attach, never a Chrome launch');
    assert.deepEqual(h.page.gotos, [url]);
    const session = h.browserSessions.get(result.sessionId);
    assert.equal(session._profileMode, 'morelogin');
    assert.equal(session._mlEnvId, ENV);
    assert.equal(Object.keys(session).some(key => /loopback|sidecar/i.test(key)), false);
    assert.ok(h.page.listeners.get('console')?.length, 'the console buffer is attached before the start URL loads');
  }
});

test('a localhost port MoreLogin refuses is reported by the session it created', async () => {
  const h = createSessionHarness({ landAt: (next) => (next.includes(':3999') ? stopPage(next) : next) });
  const result = await h.context.createBrowserSession({ url: 'http://localhost:3999/' });
  assert.equal(result.profileMode, 'morelogin');
  assert.equal(result.moreLoginBlocked, PORT_MESSAGE('3999'));
});

// ── The stop page and its message ──

function blockHarness() {
  const context = vm.createContext({ console: { warn: () => {}, log: () => {} }, URL, Date });
  vm.runInContext(between(...MORELOGIN_BLOCKS), context);
  return context;
}
const moreLogin = { _profileMode: 'morelogin', _mlEnvId: ENV };

test('a localhost block names the port and the Port scan protection setting', () => {
  const h = blockHarness();
  assert.equal(h.moreLoginBlockError(moreLogin, 'http://localhost:3999/app', stopPage('http://localhost:3999/app')), PORT_MESSAGE('3999'));
  assert.equal(h.moreLoginBlockError(moreLogin, 'http://127.0.0.1:5173/', stopPage('http://127.0.0.1:5173/')), PORT_MESSAGE('5173'));
  assert.equal(h.moreLoginBlockError(moreLogin, 'http://localhost/', stopPage('http://localhost/')), PORT_MESSAGE('80'));
  // The stop page names what it blocked, even when the caller went back / forward to it.
  assert.equal(h.moreLoginBlockError(moreLogin, 'https://example.com/', stopPage('http://localhost:4000/')), PORT_MESSAGE('4000'));
  // Without a blockedUrl parameter the requested URL decides.
  assert.equal(h.moreLoginBlockError(moreLogin, 'http://localhost:4100/', 'https://getip.morelogin.com/black_whiteList_stop_page_v2.html'), PORT_MESSAGE('4100'));
  const stats = vm.runInContext('moreLoginBlockStats', h);
  assert.equal(stats.count, 5);
  assert.equal(stats.lastUrl, 'http://localhost:4100/');
});

test('other blocks keep the website-policy message; nothing else is a block', () => {
  const h = blockHarness();
  const message = h.moreLoginBlockError(moreLogin, 'https://x.com/home', 'https://getip.morelogin.com/black_whiteList_stop_page.html?blockedUrl=https%3A%2F%2Fx.com%2Fhome');
  assert.equal(message, `MoreLogin blocked this navigation to https://x.com/home. Its website blacklist/whitelist (MoreLogin → Settings → security/permissions, or your team super-admin's policy) does not allow that host, so the tab was redirected to MoreLogin's stop page. Add the host to the whitelist, or disable the website limit for env ${ENV}.`);
  assert.match(h.moreLoginBlockError(moreLogin, 'https://x.com/', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/url-blocking.html'), /^MoreLogin blocked this navigation to https:\/\/x\.com\//);
  assert.equal(h.moreLoginBlockError(moreLogin, 'http://localhost:3344/', 'http://localhost:3344/'), null);
  assert.equal(h.moreLoginBlockError({ _profileMode: 'managed' }, 'http://localhost:3999/', stopPage('http://localhost:3999/')), null);
  assert.equal(h.moreLoginBlockError(moreLogin, stopPage('http://localhost:3999/'), stopPage('http://localhost:3999/')), null, 'asking for the stop page is not a block');
  assert.equal(h.isLoopbackUrl('http://[::1]:8080/'), true);
  assert.equal(h.isLoopbackUrl('http://app.localhost:3000/'), true);
  assert.equal(h.isLoopbackUrl('https://localhost.example.com/'), false);
});

// ── Navigate route: localhost is a normal page in MoreLogin ──

function navigateHarness({ config = moreLoginConfig(), landAt } = {}) {
  const loopTab = fakePage('https://bsky.app/', landAt);
  const otherTab = fakePage('https://x.com/home', landAt);
  const session = fakeSession({
    _profileMode: 'morelogin', _mlEnvId: ENV,
    tabs: new Map([['loop-tab', { page: loopTab }], ['other-tab', { page: otherTab }]]),
    _tabOwners: new Map([['loop-A', 'loop-tab'], ['loop-B', 'other-tab']]),
    _loopOwned: new Set(['loop-A', 'loop-B']),
  });
  const browserSessions = new Map([['morelogin-1', session]]);
  const routes = new Map();
  const noop = () => {};
  const context = vm.createContext({
    console: { warn: () => {}, log: () => {} }, URL, Promise, Date,
    app: { post: (path, handler) => routes.set(`POST ${path}`, handler), get: (path, handler) => routes.set(`GET ${path}`, handler) },
    loadBrowserConfig: () => ({ ...config }),
    browserSessions,
    agentRegistry: new Map(),
    moneyGuardActive: () => false, MONEY_URL_RE: /$^/, MONEY_GUARD_MSG: '',
    markBrowserActionStarted: noop,
    trackRoute: noop,
    sessionOwnerCount: (s) => (s._loopOwned?.size || 0) + (s._interactiveOwned?.size || 0) + (s._agentOwnedSet?.size || 0),
    activeBrowserNavigationCircuit: () => null,
    humanThink: async () => {},
    measureBrowserPhase: (_phase, fn) => fn(),
    browserActionTimeout: (_req, ms) => ms,
    clearBrowserNavigationWedge: noop,
    settleAfterAction: async () => {},
    recoverBrowserRouteFailure: async () => null,
    rememberBrowserNavigationWedge: noop,
    browserRecoveryErrorMessage: (err) => err.message,
  });
  vm.runInContext(between(...MORELOGIN_BLOCKS), context);
  vm.runInContext(between('// ── Default-browser policy for automation sessions ──', 'async function findReusableBrowserSession('), context);
  vm.runInContext(between('function getTargetPage(', '// ── Browser REST endpoints'), context);
  vm.runInContext(between("app.post('/api/browser/sessions/:id/navigate'", "app.post('/api/browser/sessions/:id/back'"), context);
  vm.runInContext(between("app.get('/api/browser/sessions', ", "app.post('/api/browser/sessions', "), context);
  const call = async (method, path, params, body, terminal) => {
    let statusCode = 200;
    let payload;
    const headers = terminal ? { 'x-synabun-terminal': terminal } : {};
    const req = { params, body, query: {}, headers, get: (name) => headers[name.toLowerCase()] };
    const res = { status(code) { statusCode = code; return res; }, json(data) { payload = data; return res; } };
    await routes.get(`${method} ${path}`)(req, res);
    return { status: statusCode, body: payload };
  };
  const navigate = (sessionId, url, terminal, extra = {}) => call('POST', '/api/browser/sessions/:id/navigate', { id: sessionId }, { url, snapshot: 'none', ...extra }, terminal);
  return { navigate, call, loopTab, otherTab, browserSessions };
}

test('a localhost navigation loads in the caller\'s own MoreLogin tab — no reroute', async () => {
  const h = navigateHarness();
  const { status, body } = await h.navigate('morelogin-1', 'http://localhost:9003/deals/new-releases', 'loop-A');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual({ ...body }, { ok: true, url: 'http://localhost:9003/deals/new-releases', title: 'Page' });
  assert.deepEqual(h.loopTab.gotos, ['http://localhost:9003/deals/new-releases']);
  assert.deepEqual(h.otherTab.gotos, [], 'another automation\'s tab is untouched');
});

test('a port MoreLogin refuses fails the navigation with the Port scan protection message', async () => {
  const h = navigateHarness({ landAt: (next) => (next.includes(':3999') ? stopPage(next) : next) });
  const { status, body } = await h.navigate('morelogin-1', 'http://localhost:3999/', 'loop-A');
  assert.equal(status, 502);
  assert.equal(body.moreLoginBlocked, true);
  assert.equal(body.error, PORT_MESSAGE('3999'));
  assert.equal(body.landedUrl, stopPage('http://localhost:3999/'));
});

test('F1: servesDefault is the server policy — MoreLogin on the default env only, everything in other setups', async () => {
  const h = navigateHarness();
  h.browserSessions.set('managed-1', fakeSession({ _profileMode: 'managed' }));
  h.browserSessions.set('morelogin-other', fakeSession({ _profileMode: 'morelogin', _mlEnvId: '999' }));
  const { body } = await h.call('GET', '/api/browser/sessions', {}, {}, undefined);
  const serves = Object.fromEntries(body.sessions.map(s => [s.id, s.servesDefault]));
  assert.deepEqual(serves, { 'morelogin-1': true, 'managed-1': false, 'morelogin-other': false });
  assert.equal(body.defaultBrowser.connectMode, 'morelogin');
  assert.equal(body.defaultBrowser.moreloginEnvId, ENV);
  assert.equal(body.sessions.some(s => 'loopbackOnly' in s || 'loopbackParentId' in s), false);

  const mirror = navigateHarness({ config: { connectMode: 'mirror', userDataDir: null } });
  mirror.browserSessions.set('managed-1', fakeSession({ _profileMode: 'managed' }));
  const listed = await mirror.call('GET', '/api/browser/sessions', {}, {}, undefined);
  assert.ok(listed.body.sessions.every(s => s.servesDefault === true), 'other setups behave exactly as before');
});

// ── browser-config.json: atomic writes, last good config on a bad read ──

function configHarness(t) {
  const dataHome = mkdtempSync(join(tmpdir(), 'synabun-browser-config-'));
  t.after(() => rmSync(dataHome, { recursive: true, force: true }));
  const warnings = [];
  const context = vm.createContext({
    console: { warn: (message) => warnings.push(String(message)), log: () => {} },
    DATA_HOME: dataHome, resolve, dirname, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, randomBytes,
    process: { pid: 4242 }, Date, JSON,
  });
  vm.runInContext(between('// ── Browser config ──', '/**\n * Find a usable Chromium'), context);
  const path = join(dataHome, 'data', 'browser-config.json');
  return { context, path, warnings, dir: join(dataHome, 'data') };
}

test('saveBrowserConfig writes the whole file atomically and leaves no temp file', (t) => {
  const h = configHarness(t);
  h.context.saveBrowserConfig(moreLoginConfig());
  assert.deepEqual(JSON.parse(readFileSync(h.path, 'utf8')), moreLoginConfig());
  assert.deepEqual(readdirSync(h.dir), ['browser-config.json']);
  assert.deepEqual({ ...h.context.loadBrowserConfig() }, moreLoginConfig());
});

test('loadBrowserConfig keeps the last good config when the file is torn or invalid, and says so', (t) => {
  const h = configHarness(t);
  assert.deepEqual({ ...h.context.loadBrowserConfig() }, {}, 'no file yet');
  h.context.saveBrowserConfig(moreLoginConfig());
  writeFileSync(h.path, '{"connectMode": "morel');
  const torn = h.context.loadBrowserConfig();
  assert.equal(torn.connectMode, 'morelogin', 'a half-written file never switches MoreLogin off');
  assert.equal(torn.moreloginEnvId, ENV);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /browser-config\.json is unreadable .*using the last good browser settings/);
  torn.connectMode = 'mirror';
  assert.equal(h.context.loadBrowserConfig().connectMode, 'morelogin', 'every caller gets its own copy');
  assert.equal(h.warnings.length, 1, 'one warning per failure streak');
  writeFileSync(h.path, '[1, 2]');
  assert.equal(h.context.loadBrowserConfig().connectMode, 'morelogin', 'a JSON value that is not an object is invalid too');
  writeFileSync(h.path, JSON.stringify({ connectMode: 'attach' }));
  assert.equal(h.context.loadBrowserConfig().connectMode, 'attach', 'a good read becomes the new fallback');
  writeFileSync(h.path, '');
  assert.equal(h.context.loadBrowserConfig().connectMode, 'attach');
  assert.equal(h.warnings.length, 2, 'a new streak after a good read warns again');
});

test('loadBrowserConfig without any earlier good read returns {} marked unreadable; a missing file is the plain defaults', (t) => {
  const h = configHarness(t);
  assert.equal(h.context.browserConfigUnreadable(h.context.loadBrowserConfig()), null, 'no file: the defaults');
  mkdirSync(h.dir, { recursive: true });
  writeFileSync(h.path, 'not json');
  const cfg = h.context.loadBrowserConfig();
  assert.deepEqual({ ...cfg }, {});
  assert.match(h.context.browserConfigUnreadable(cfg), /JSON/);
  assert.equal(h.context.browserDefaultSignature(cfg), 'unreadable');
  assert.match(h.warnings[0], /browser-config\.json is unreadable .*no browser session starts until it is fixed in Settings → Browser/);
  h.context.saveBrowserConfig(moreLoginConfig());
  assert.equal(h.context.browserConfigUnreadable(h.context.loadBrowserConfig()), null, 'saving from Settings → Browser fixes it');
});

test('createBrowserSession refuses an unreadable browser-config.json with no earlier good read: an error, never the Chrome path', async (t) => {
  const h = configHarness(t);
  mkdirSync(h.dir, { recursive: true });
  writeFileSync(h.path, '{"connectMode": "morel');
  const launches = [];
  Object.assign(h.context, {
    findBrowserExecutable: () => { launches.push('findBrowserExecutable'); return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'; },
    chromium: { launch: async () => launches.push('launch'), launchPersistentContext: async () => launches.push('launchPersistentContext'), connectOverCDP: async () => launches.push('connectOverCDP') },
  });
  vm.runInContext(between('async function createBrowserSession(', '/**\n * Start CDP screencast'), h.context);
  await assert.rejects(h.context.createBrowserSession({ url: 'http://localhost:3344/' }), (error) => error.message.startsWith('browser-config.json is unreadable; fix it in Settings → Browser ('));
  assert.deepEqual(launches, [], 'nothing looked for or started a browser');
});

test('agents act on the default browser only: the REST boundary refuses a non-default session before any page action; the UI, closing and tab lists pass; every response names the default', async (t) => {
  const dataHome = mkdtempSync(join(tmpdir(), 'synabun-browser-boundary-'));
  t.after(() => rmSync(dataHome, { recursive: true, force: true }));
  mkdirSync(join(dataHome, 'data'), { recursive: true });
  const configPath = join(dataHome, 'data', 'browser-config.json');
  writeFileSync(configPath, JSON.stringify(moreLoginConfig()));
  const { default: express } = await import('express');
  const { browserRequestMiddleware } = await import('../lib/browser-execution.js');
  const app = express();
  app.use(express.json());
  const browserSessions = new Map([
    ['morelogin-1', fakeSession({ _profileMode: 'morelogin', _mlEnvId: ENV })],
    ['managed-1', fakeSession({ _profileMode: 'managed' })],
    ['morelogin-other', fakeSession({ _profileMode: 'morelogin', _mlEnvId: '999' })],
  ]);
  const context = vm.createContext({
    console: { warn: () => {}, log: () => {} }, app, browserSessions, browserRequestMiddleware,
    DATA_HOME: dataHome, resolve, dirname, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, randomBytes, process: { pid: 1 },
  });
  vm.runInContext(between('// ── Default-browser policy for automation sessions ──', 'async function findReusableBrowserSession('), context);
  vm.runInContext(between('// ── Browser config ──', '/**\n * Find a usable Chromium'), context);
  vm.runInContext(between("app.use('/api/browser', browserRequestMiddleware);", '// Read-only semantic context for the browser judgments'), context);
  app.all('/api/browser/*', (req, res) => res.json({ passed: true }));
  const server = await new Promise((done) => { const s = app.listen(0, '127.0.0.1', () => done(s)); });
  t.after(() => server.close());
  const call = async (method, path, terminal = 'agent-1') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/browser${path}`, {
      method, headers: { 'content-type': 'application/json', ...(terminal ? { 'X-Synabun-Terminal': terminal } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}),
    });
    return { status: response.status, body: await response.json(), browserDefault: response.headers.get('x-synabun-browser-default') };
  };
  for (const [method, path, what] of [
    ['POST', '/sessions/managed-1/click', /Session managed-1 is not the default browser \(managed mode; the default is MoreLogin env 2072008039271567360\), so SynaBun's browser tools do not act on it\. Leave sessionId out: browser_navigate opens the page in the default browser\./],
    ['GET', '/sessions/managed-1/screenshot-base64', /managed mode/], ['GET', '/sessions/managed-1/snapshot', /managed mode/], ['GET', '/sessions/managed-1/content', /managed mode/],
    ['GET', '/sessions/managed-1/console', /managed mode/], ['POST', '/sessions/managed-1/navigate', /managed mode/], ['POST', '/sessions/managed-1/tabs', /managed mode/],
    ['GET', '/sessions/managed-1/cdp', /managed mode/], ['POST', '/sessions/morelogin-other/evaluate', /\(morelogin mode, MoreLogin env 999; the default is MoreLogin env 2072008039271567360\)/],
  ]) {
    const { status, body, browserDefault } = await call(method, path);
    assert.equal(status, 409, `${method} ${path}`);
    assert.deepEqual([body.code, body.actionStarted], ['NOT_DEFAULT_BROWSER', false], path);
    assert.match(body.error, what, path);
    assert.equal(browserDefault, `morelogin:${ENV}`);
  }
  for (const [method, path, terminal] of [
    ['GET', '/sessions/morelogin-1/snapshot', 'agent-1'], ['POST', '/sessions/managed-1/click', null], ['DELETE', '/sessions/managed-1', 'agent-1'],
    ['GET', '/sessions/managed-1/tabs', 'agent-1'], ['DELETE', '/sessions/managed-1/tabs/t1', 'agent-1'], ['GET', '/sessions', 'agent-1'], ['POST', '/sessions/unknown/click', 'agent-1'],
  ]) assert.deepEqual((await call(method, path, terminal)).body, { passed: true }, `${method} ${path} ${terminal}`);
  writeFileSync(configPath, JSON.stringify({ connectMode: 'mirror' }));
  const mirror = await call('POST', '/sessions/managed-1/click');
  assert.deepEqual(mirror.body, { passed: true }, 'other setups: every session serves the default');
  assert.equal(mirror.browserDefault, 'other:mirror', 'the header follows the settings');
});

// A run's tab opened without selecting it, without a browser: what
// lib/browser-background-tab.js does when the browser answers late or not at all,
// and where server.js uses it. The real protocol is in
// browser-background-tab.browser.mjs, a real window in
// browser-screenshot-window.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as backgroundTab from '../lib/browser-background-tab.js';
import { withBrowserOperationDeadline } from '../lib/browser-tab-recovery.js';

const { openBackgroundPage } = backgroundTab;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const never = () => new Promise(() => {});

/**
 * A browser and its default context as openBackgroundPage sees them. `create`
 * is how Target.createTarget answers; `attach(page)` how a CDP session of a page
 * arrives. Every page that "appears" carries the target id its session reports.
 */
function fakeBrowser({ create, attach = null, browserSession = null, closeDelay = 0 } = {}) {
  const context = new EventEmitter();
  const state = { context, closedTargets: [], browserSessions: [], pageSessions: [], created: 0 };
  const makeBrowserSession = () => {
    const session = { detached: false };
    session.send = async (method, params) => {
      if (session.detached) throw new Error('Session closed');
      if (method === 'Target.createTarget') { state.created += 1; return create(state, params); }
      if (method === 'Target.closeTarget') { if (closeDelay) await delay(closeDelay); state.closedTargets.push(params.targetId); return { success: true }; }
      throw new Error(`unexpected command ${method}`);
    };
    session.detach = async () => { session.detached = true; };
    state.browserSessions.push(session);
    return session;
  };
  const makePageSession = (page) => {
    const session = { detached: false, page };
    session.send = async (method) => {
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: page.targetId } };
      throw new Error(`unexpected command ${method}`);
    };
    session.detach = async () => { session.detached = true; };
    state.pageSessions.push(session);
    return session;
  };
  context.newCDPSession = (page) => (attach ? attach(page, () => makePageSession(page)) : Promise.resolve(makePageSession(page)));
  context.pages = () => state.pages || [];
  state.browser = { newBrowserCDPSession: () => (browserSession ? browserSession(makeBrowserSession) : Promise.resolve(makeBrowserSession())) };
  /** A page of `targetId` shows up in the context, as Playwright announces it. */
  state.appear = (targetId) => { const page = { targetId, isClosed: () => false, context: () => context }; context.emit('page', page); return page; };
  return state;
}

test('a tab created after its wait was given up is closed again (finding 7)', { timeout: 20_000 }, async () => {
  const state = fakeBrowser({ create: async (self) => { await delay(150); self.appear('late'); return { targetId: 'late' }; } });
  assert.equal(await openBackgroundPage(state.browser, state.context, { timeoutMs: 40 }), null);
  await delay(300);
  assert.equal(state.created, 1);
  assert.deepEqual(state.closedTargets, ['late'], 'the tab that arrived late was closed');
  assert.equal(state.browserSessions.every((session) => session.detached), true, 'and the browser session let go');
  assert.equal(state.context.listenerCount('page'), 0);
});

test('the time allowed is for the whole attempt, and a page that never answers does not hold up the tab', { timeout: 20_000 }, async () => {
  const others = (self) => { for (const id of ['other-1', 'other-2', 'other-3']) self.appear(id); };
  // Three other pages appear first and none of their sessions ever attaches: the tab is found all the same.
  const busy = fakeBrowser({
    create: async (self) => { others(self); self.appear('mine'); return { targetId: 'mine' }; },
    attach: (page, make) => (page.targetId === 'mine' ? Promise.resolve(make()) : never()),
  });
  let started = Date.now();
  const page = await openBackgroundPage(busy.browser, busy.context, { timeoutMs: 300 });
  assert.equal(page?.targetId, 'mine');
  assert.ok(Date.now() - started < 200, `found at ${Date.now() - started} ms`);
  assert.deepEqual(busy.closedTargets, []);

  // No page session attaches at all: given up when the time allowed is over, not once per page, and the tab is closed again.
  const silent = fakeBrowser({ create: async (self) => { others(self); self.appear('mine'); return { targetId: 'mine' }; }, attach: () => never() });
  started = Date.now();
  assert.equal(await openBackgroundPage(silent.browser, silent.context, { timeoutMs: 200 }), null);
  const took = Date.now() - started;
  assert.ok(took >= 190 && took < 300, `gave up at ${took} ms with 200 ms allowed`);
  await delay(30);
  assert.deepEqual(silent.closedTargets, ['mine'], 'the tab it could not reach in time is closed again');
  assert.equal(silent.browserSessions.every((session) => session.detached), true);

  // Closing that tab is slow: the caller has its answer when the time allowed is over, and the tab is closed after it.
  const slowClose = fakeBrowser({ create: async (self) => { self.appear('mine'); return { targetId: 'mine' }; }, attach: () => never(), closeDelay: 400 });
  started = Date.now();
  assert.equal(await openBackgroundPage(slowClose.browser, slowClose.context, { timeoutMs: 150 }), null);
  assert.ok(Date.now() - started < 250, `answered at ${Date.now() - started} ms with 150 ms allowed`);
  assert.deepEqual(slowClose.closedTargets, [], 'still closing');
  await delay(500);
  assert.deepEqual(slowClose.closedTargets, ['mine']);
  assert.equal(slowClose.browserSessions.every((session) => session.detached), true, 'and the browser session let go after it');
});

test('sessions that attach after their wait was given up are detached', { timeout: 20_000 }, async () => {
  // The browser-level session arrives late.
  let lateBrowserSession = null;
  const slowBrowser = fakeBrowser({ create: async () => ({ targetId: 'unused' }), browserSession: (make) => delay(150).then(() => { lateBrowserSession = make(); return lateBrowserSession; }) });
  assert.equal(await openBackgroundPage(slowBrowser.browser, slowBrowser.context, { timeoutMs: 40 }), null);
  await delay(250);
  assert.equal(lateBrowserSession.detached, true);
  assert.equal(slowBrowser.created, 0, 'and no tab was asked for through it');

  // A page session arrives late.
  const slowPage = fakeBrowser({
    create: async (self) => { self.appear('mine'); return { targetId: 'mine' }; },
    attach: (page, make) => delay(200).then(make),
  });
  assert.equal(await openBackgroundPage(slowPage.browser, slowPage.context, { timeoutMs: 80 }), null);
  await delay(300);
  assert.equal(slowPage.pageSessions.length, 1);
  assert.equal(slowPage.pageSessions[0].detached, true);
});

test('the page of the new tab is returned, and read as not selected', { timeout: 20_000 }, async () => {
  const state = fakeBrowser({ create: async (self) => { self.appear('popup-of-another-tab'); state.mine = self.appear('mine'); return { targetId: 'mine' }; } });
  const first = { isClosed: () => false, context: () => state.context };
  state.pages = [first];
  const page = await openBackgroundPage(state.browser, state.context, { timeoutMs: 500 });
  assert.equal(page, state.mine, 'found by its target id, not by what appeared first');
  await delay(20);
  assert.equal(state.pageSessions.every((session) => session.detached), true);
  assert.equal(state.browserSessions.every((session) => session.detached), true);
  assert.deepEqual(state.closedTargets, []);

  // What the server can tell about the selected tab: the order tabs were opened in, and how.
  const reading = backgroundTab.selectedTabReading;
  state.pages = [first, page];
  assert.deepEqual(reading(first), { reading: 'likely', basis: 'newest-foreground-tab' }, 'the background tab did not take the selection');
  assert.deepEqual(reading(page), { reading: 'unlikely', basis: 'opened-in-background' });
  const second = { isClosed: () => false, context: () => state.context };
  state.pages = [first, page, second];
  assert.deepEqual(reading(first), { reading: 'unlikely', basis: 'newer-tab-open' }, 'a tab opened the usual way after it took the selection');
  assert.deepEqual(reading(second), { reading: 'likely', basis: 'newest-foreground-tab' });
  second.isClosed = () => true;
  assert.deepEqual(reading(first), { reading: 'likely', basis: 'newest-foreground-tab' }, 'that tab closed: the selection falls back');
  assert.deepEqual(reading({ isClosed: () => false, context: () => state.context }), { reading: 'unknown', basis: 'not-in-context' });
  assert.deepEqual(reading({ context: () => { throw new Error('gone'); } }), { reading: 'unknown', basis: 'unreadable' });
});

// ── where server.js opens a tab in the background (finding 8) ───────────────

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const between = (start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `server.js marker not found: ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `server.js end marker not found: ${end}`);
  return source.slice(from, to);
};

test('openTabsInBackground covers every tab SynaBun opens in a shared browser, and changes nothing when it is not set (finding 8)', { timeout: 20_000 }, async () => {
  const calls = [];
  let config = {};
  let background = async () => { calls.push('background'); return { background: true }; };
  const warnings = [];
  const context = vm.createContext({
    console: { log() {}, warn: (line) => warnings.push(line) },
    loadBrowserConfig: () => config,
    openBackgroundPage: (...args) => background(...args),
    withBrowserOperationDeadline,
    BROWSER_RECOVERY_STEP_DEADLINE_MS: 5000, BROWSER_RECOVERY_PROBE_DEADLINE_MS: 1000,
    browserSessions: new Map(), broadcastSync: () => {},
    stopScreencast: async () => {}, startScreencast: async () => {},
    destroyBrowserSession: async () => { calls.push('destroy'); },
  });
  vm.runInContext(`${between('async function newSessionPage(', 'async function createSessionTab(')}\n${between('async function recoverSessionTabPage(', 'const BROWSER_NAVIGATION_WEDGE_COOLDOWN_MS')}\nthis.newSessionPage = newSessionPage; this.recoverSessionTabPage = recoverSessionTabPage;`, context);
  const owner = (mode) => ({ _profileMode: mode, browser: {}, context: { newPage: async () => { calls.push('newPage'); return { foreground: true }; } } });
  const open = async (mode) => { calls.length = 0; const page = await context.newSessionPage(owner(mode)); return [calls.join(','), page.background === true]; };

  // Not set, or false: the tab is opened as before, and the background opener is not even asked.
  for (const value of [{}, { openTabsInBackground: false }, { openTabsInBackground: 'true' }, { openTabsInBackground: 1 }]) {
    config = value;
    for (const mode of ['morelogin', 'cdp', 'managed', 'mirror', 'direct', 'clean']) assert.deepEqual(await open(mode), ['newPage', false], `${JSON.stringify(value)} ${mode}`);
  }
  config = { openTabsInBackground: true };
  assert.deepEqual(await open('morelogin'), ['background', true]);
  assert.deepEqual(await open('cdp'), ['background', true]);
  for (const mode of ['managed', 'mirror', 'direct', 'clean']) assert.deepEqual(await open(mode), ['newPage', false], `SynaBun's own window: ${mode}`);
  background = async () => { calls.push('background'); return null; };
  assert.deepEqual(await open('morelogin'), ['background,newPage', false], 'the browser cannot: a normal tab');
  assert.equal(warnings.length, 1);
  background = async () => { calls.push('background'); throw new Error('boom'); };
  assert.deepEqual(await open('cdp'), ['background,newPage', false], 'it throws: a normal tab');

  // Replacing a wedged tab opens its page the same way.
  const recover = async (mode) => {
    calls.length = 0;
    const session = { ...owner(mode), tabs: new Map(), activeTabId: 'other', _wireTabPageEvents: () => {} };
    const replacement = { evaluate: async () => 1, close: async () => {} };
    session.context.newPage = async () => { calls.push('newPage'); return replacement; };
    session.context.newCDPSession = async () => ({ detach: async () => {} });
    session.tabs.set('wedged', { page: { isClosed: () => true }, cdpSession: null });
    context.browserSessions.set('session-1', session);
    const result = await context.recoverSessionTabPage(session, 'session-1', 'wedged', 'test');
    return [calls.join(','), result.recovered, session.tabs.get('wedged').page];
  };
  const fromBackground = { evaluate: async () => 1, close: async () => {} };
  background = async () => { calls.push('background'); return fromBackground; };
  const recovered = await recover('morelogin');
  assert.deepEqual(recovered.slice(0, 2), ['background', true]);
  assert.equal(recovered[2], fromBackground, 'the replacement is the background tab');
  config = {};
  assert.deepEqual((await recover('morelogin')).slice(0, 2), ['newPage', true], 'not set: as before');

  // The first tab of a session attached to MoreLogin or to the user's Chrome goes through the same opener.
  const create = between('async function createBrowserSession(', '// ── Decrypt and inject cookies from Chrome profile');
  assert.doesNotMatch(create, /cdpContext\.newPage\(\)/, 'no attached browser gets a tab from newPage() directly');
  assert.match(create, /newSessionPage\(\{ browser: cdpBrowser, context: cdpContext, _profileMode: 'morelogin' \}\)/);
  assert.match(create, /newSessionPage\(\{ browser: cdpBrowser, context: cdpContext, _profileMode: 'cdp' \}\)/);
  assert.match(between('async function recoverSessionTabPage(', 'const BROWSER_NAVIGATION_WEDGE_COOLDOWN_MS'), /newSessionPage\(session/);
});

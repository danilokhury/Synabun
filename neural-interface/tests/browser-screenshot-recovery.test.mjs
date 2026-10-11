// browser_screenshot when a capture fails or stops answering, without a browser:
// the page and its CDP sessions are played by fakeTab(), which keeps the one
// thing Chromium does that matters here (a capture with a clip resizes the tab's
// view to the clip until it answers). The lib and the server.js route are the
// real ones. What a real window does is in browser-screenshot-window.browser.mjs,
// the real protocol in browser-screenshot-stall.browser.mjs.
//
// The invariants held here:
//   a. at most one capture touches a tab at any time;
//   b. every request answers within its deadline, naming the phase;
//   c. after a failed capture the tab is verified back at its own width, height
//      and devicePixelRatio, or it is out of routing at once and closed (reported
//      as closed only when the close was confirmed);
//   d. a capture that never settles neither blocks the next caller nor is overlapped;
//   e. a CDP session that arrives after its wait was given up is detached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { browserRequestMiddleware, runBrowserRequest } from '../lib/browser-execution.js';
import * as backgroundTab from '../lib/browser-background-tab.js';
import { captureScreenshot, defaultScreenshotPath, parseScreenshotOptions, restoreViewport, restoreViewSize, screenshotPathRefusal, writeScreenshotFile } from '../lib/browser-screenshot.js';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const never = () => new Promise(() => {});
const options = (query = {}) => parseScreenshotOptions(query);
const failing = (promise) => promise.then((value) => assert.fail(`expected a failure, got ${JSON.stringify({ ...value, data: undefined, fileData: undefined })}`), (error) => error);
/** The request bound of server.js, shortened: rejects after `ms`, leaves the work running. */
const bound = (ms) => (work) => new Promise((done, fail) => {
  const timer = setTimeout(() => fail(Object.assign(new Error('Browser operation deadline exceeded; inspect state before retrying.'), { code: 'BROWSER_OPERATION_TIMEOUT' })), ms);
  Promise.resolve().then(work).then((value) => { clearTimeout(timer); done(value); }, (error) => { clearTimeout(timer); fail(error); });
});
const HOME = { width: 800, height: 600, dpr: 1 };

/**
 * A tab without a browser. `dip` is the size of its view (CSS px times `zoom`),
 * `override` a device-metrics override. Knobs, each a function of the command:
 * `stall` (never answers), `refuse` (rejects with the error returned), `hold`
 * (ms before the answer). `frozen`: the page's own reads never answer.
 * `newSession(make)`: how the next CDP session arrives. `log` is every session
 * opened and every command sent, in order.
 */
function fakeTab({ width = HOME.width, height = HOME.height, dpr = HOME.dpr, windowState = 'normal', zoom = 1 } = {}) {
  const tab = {
    dip: { width: Math.round(width * zoom), height: Math.round(height * zoom) },
    zoom, dpr, override: null, windowState,
    sessions: [], log: [], violations: [], owner: null,
    stall: () => false, refuse: () => null, hold: () => 0,
    frozen: false, readable: true, newSession: null,
    closed: false, closeCalls: 0, closing: null, title: 'Example', titleRead: null, url: 'https://example.test/', pages: null,
  };
  tab.view = () => (tab.override
    ? { width: tab.override.width, height: tab.override.height, dpr: tab.override.dpr }
    : { width: Math.round(tab.dip.width / tab.zoom), height: Math.round(tab.dip.height / tab.zoom), dpr: tab.dpr });
  const png = (width) => { const bytes = Buffer.alloc(24); bytes.writeUInt32BE(width, 16); return bytes.toString('base64'); };
  const answer = (session, method, params) => {
    if (method === 'Browser.getWindowForTarget') return { windowId: 1, bounds: { windowState: tab.windowState } };
    if (method === 'Page.getLayoutMetrics') {
      const { width: clientWidth, height: clientHeight } = tab.view();
      return { cssLayoutViewport: { clientWidth, clientHeight }, cssVisualViewport: { clientWidth, clientHeight, pageX: 0, pageY: 0, scale: 1 }, cssContentSize: { width: clientWidth, height: clientHeight * 3 } };
    }
    if (method === 'Emulation.setDeviceMetricsOverride') {
      // Chromium keeps one override per page; an empty one (all zeros) overrides nothing.
      session.emulating = true;
      tab.override = params.width && params.height ? { width: params.width, height: params.height, dpr: params.deviceScaleFactor || tab.dpr } : null;
      tab.owner = tab.override ? session.id : null;
      return {};
    }
    if (method === 'Emulation.clearDeviceMetricsOverride') {
      // Chromium ignores a clear from a session that never set an override.
      if (session.emulating) { tab.override = null; tab.owner = null; session.emulating = false; }
      return {};
    }
    if (method === 'Emulation.setVisibleSize') { tab.dip = { width: params.width, height: params.height }; return {}; }
    throw new Error(`unexpected command ${method}`);
  };
  const makeSession = () => {
    const session = { id: tab.sessions.length, detached: false, emulating: false };
    session.send = (method, params = {}) => {
      tab.log.push(`${session.id}:${method}${params.clip ? ':clip' : ''}`);
      if (tab.owner !== null && tab.owner !== session.id) tab.violations.push(`session ${session.id} sent ${method} while session ${tab.owner} held the viewport`);
      if (session.detached) return Promise.reject(new Error('Session closed'));
      const refused = tab.refuse(method, params, session);
      if (refused) return Promise.reject(refused);
      if (method === 'Page.captureScreenshot') {
        if (!params.clip) return tab.stall(method, params, session) ? never() : delay(tab.hold(method, params)).then(() => ({ data: '' }));
        // What Chromium does before it waits for the frame: the view takes the clip's size, until the capture answers.
        const saved = { ...tab.dip };
        tab.dip = { width: Math.round(params.clip.width * params.clip.scale), height: Math.round(params.clip.height * params.clip.scale) };
        if (tab.stall(method, params, session)) return never();
        return delay(tab.hold(method, params)).then(() => {
          tab.dip = saved;
          return { data: png(Math.round(params.clip.width * params.clip.scale * (tab.override ? tab.override.dpr : tab.dpr))) };
        });
      }
      if (tab.stall(method, params, session)) return never();
      const ms = tab.hold(method, params);
      return ms ? delay(ms).then(() => answer(session, method, params)) : Promise.resolve().then(() => answer(session, method, params));
    };
    session.detach = async () => { session.detached = true; tab.log.push(`${session.id}:detach`); };
    tab.sessions.push(session);
    tab.log.push(`${session.id}:open`);
    return session;
  };
  const context = {
    newCDPSession: () => (tab.newSession ? tab.newSession(makeSession) : Promise.resolve(makeSession())),
    pages: () => tab.pages || [tab.page],
  };
  tab.page = {
    context: () => context,
    evaluate: () => (tab.frozen ? never() : tab.readable ? Promise.resolve(tab.view()) : Promise.reject(new Error('Execution context was destroyed'))),
    url: () => tab.url,
    title: () => (tab.titleRead ? tab.titleRead() : Promise.resolve(tab.title)),
    close: () => { tab.closeCalls += 1; return tab.closing ? tab.closing() : Promise.resolve().then(() => { tab.closed = true; }); },
    isClosed: () => tab.closed,
  };
  return tab;
}
/** Only the first capture with a clip never answers. */
const firstClipStalls = (tab) => { let clips = 0; tab.stall = (method, params) => method === 'Page.captureScreenshot' && !!params.clip && (clips += 1) === 1; };
/** Every capture with a clip never answers. */
const clipsStall = (tab) => { tab.stall = (method, params) => method === 'Page.captureScreenshot' && !!params.clip; };

// ── a. one capture per tab ──────────────────────────────────────────────────

test('a waiter that gives up does not let a later caller pass a capture that is still active (finding 1)', { timeout: 20_000 }, async () => {
  const tab = fakeTab();
  firstClipStalls(tab); // A hangs measuring the capture scale
  const a = failing(captureScreenshot(tab.page, options(), { runBounded: bound(400), deadline: Date.now() + 3000 }));
  await delay(40);
  const b = await failing(captureScreenshot(tab.page, options(), { runBounded: bound(40), deadline: Date.now() + 3000 }));
  assert.equal(b.phase, 'queue');
  assert.match(b.message, /earlier screenshot of this tab/);
  const c = captureScreenshot(tab.page, options(), { runBounded: bound(5000), deadline: Date.now() + 6000 });
  await delay(80);
  assert.equal(tab.sessions.length, 1, 'C opened no CDP session while A was still capturing');
  const failed = await a;
  assert.equal(failed.phase, 'calibrate');
  const shot = await c;
  assert.deepEqual([shot.width, shot.height], [HOME.width, HOME.height]);
  // Everything A sent, its putting the size back included, comes before C's first command.
  const firstOfC = tab.log.indexOf(`${tab.sessions.length - 1}:open`);
  assert.ok(tab.log.lastIndexOf('1:Emulation.setVisibleSize') < firstOfC, tab.log.join(' '));
  assert.ok(tab.log.lastIndexOf('0:detach') < firstOfC, tab.log.join(' '));
  assert.deepEqual(tab.view(), HOME);
});

test('captures of one tab never overlap, whoever gives up waiting', { timeout: 20_000 }, async () => {
  const tab = fakeTab();
  tab.hold = (method) => (method === 'Page.captureScreenshot' ? 20 : 0);
  // [arrives at, width, how long its caller waits]: the short waits give up in the queue, each as the last in line.
  const plan = [[0, '375', 5000], [20, '500', 40], [100, '640', 5000], [110, '700', 30], [180, '900', 5000], [400, '1000', 60], [520, '1100', 5000]];
  const results = await Promise.all(plan.map(([at, width, wait]) => delay(at).then(() => captureScreenshot(tab.page, options({ width }), { runBounded: bound(wait), deadline: Date.now() + wait + 4000 })
    .then((shot) => ({ width: shot.viewport?.width ?? shot.emulated?.width }), (error) => ({ phase: error.phase })))));
  assert.deepEqual(tab.violations, []);
  assert.ok(results.some((result) => result.phase === 'queue'), JSON.stringify(results));
  assert.ok(results.filter((result) => result.width).length >= 3, JSON.stringify(results));
  assert.deepEqual(tab.view(), HOME);
});

// ── b. the answer comes by the deadline ─────────────────────────────────────

test('the answer comes by its deadline and names the phase, whatever the cleanup is doing (finding 2)', { timeout: 30_000 }, async () => {
  const tab = fakeTab();
  // An emulated capture whose image never answers; after that nothing does: the clear, a fresh session, the page's own reads.
  let stalled = false;
  tab.stall = (method, params) => { if (method === 'Page.captureScreenshot' && params.clip) { stalled = true; tab.frozen = true; } return stalled && method !== 'Browser.getWindowForTarget'; };
  tab.newSession = (make) => (stalled ? never() : Promise.resolve(make()));
  const retired = [];
  const started = Date.now();
  const error = await failing(captureScreenshot(tab.page, options({ width: '375' }), {
    runBounded: bound(600),
    deadline: started + 1200,
    retire: () => { retired.push(Date.now() - started); return { closed: never() }; },
  }));
  const took = Date.now() - started;
  assert.ok(took <= 1300, `answered at ${took} ms, deadline 1200`);
  assert.equal(error.phase, 'capture');
  assert.match(error.message, /timed out while capturing the image/);
  assert.match(error.message, /phase capture/);
  assert.match(error.message, /window state from CDP: normal/);
  assert.equal(error.tab, 'retired', 'not verified in time: retired');
  assert.equal(error.viewportRestored, false);
  assert.equal(error.tabClosed, false, 'and not reported as closed: nothing confirmed it');
  assert.equal(retired.length, 1, 'taken out of routing once, before the answer');
  assert.ok(retired[0] <= took);
});

// ── c. verified back, or retired ────────────────────────────────────────────

test('a view left at the wrong height is not taken for restored (finding 4)', { timeout: 20_000 }, async () => {
  // Width and devicePixelRatio as before the capture, height not, and nothing can change it.
  const stuck = fakeTab({ width: 800, height: 100 });
  stuck.refuse = (method) => (method === 'Emulation.setVisibleSize' ? new Error('not allowed') : null);
  assert.equal(await restoreViewport(stuck.page, await stuck.page.context().newCDPSession(stuck.page), HOME), false);
  assert.equal(await restoreViewSize(stuck.page, HOME), false);
  // The same view when the browser lets the size be put back.
  const fixable = fakeTab({ width: 800, height: 100 });
  assert.equal(await restoreViewport(fixable.page, await fixable.page.context().newCDPSession(fixable.page), HOME), true);
  assert.deepEqual(fixable.view(), HOME);
  // A devicePixelRatio that is not the tab's own is not restored either.
  const scaled = fakeTab({ dpr: 1 });
  assert.equal(await restoreViewSize(scaled.page, { ...HOME, dpr: 2 }), false);
  assert.equal(await restoreViewport(scaled.page, await scaled.page.context().newCDPSession(scaled.page), { ...HOME, dpr: 2 }), false);
});

test('a zoomed page is put back at exactly its own size', { timeout: 20_000 }, async () => {
  for (const zoom of [1.25, 1.1, 0.9]) {
    const tab = fakeTab({ zoom });
    tab.dip = { width: 64, height: 64 }; // what a stalled 64 px clip left
    assert.equal(await restoreViewSize(tab.page, HOME), true, `zoom ${zoom}`);
    assert.deepEqual(tab.view(), HOME, `zoom ${zoom}`);
  }
});

test('a view that does not follow is not chased with ever larger sizes', { timeout: 20_000 }, async () => {
  // The view takes a smaller part of each size asked for: half, then a quarter, then an eighth. No page zoom does that.
  const tab = fakeTab({ width: 64, height: 64 });
  const session = await tab.page.context().newCDPSession(tab.page);
  const asked = [];
  const send = session.send;
  session.send = (method, params) => {
    if (method !== 'Emulation.setVisibleSize') return send(method, params);
    asked.push([params.width, params.height]);
    const part = 2 ** asked.length;
    return send(method, { width: Math.round(params.width / part), height: Math.round(params.height / part) });
  };
  tab.newSession = async () => session;
  assert.equal(await restoreViewSize(tab.page, HOME), false, 'never taken for restored');
  assert.deepEqual(asked, [[800, 600], [1600, 1200]], 'the tab\'s own size, then one correction for a page zoom, and no more');
});

test('a clip that resizes the view only after the capture was given up on is still undone', { timeout: 20_000 }, async () => {
  const tab = fakeTab();
  // The scale measurement never answers, and the view takes the clip's size 80 ms after it was sent.
  const original = tab.page.context().newCDPSession;
  tab.page.context().newCDPSession = async () => {
    const session = await original();
    const send = session.send;
    session.send = (method, params = {}) => {
      if (method !== 'Page.captureScreenshot' || !params.clip) return send(method, params);
      tab.log.push(`${session.id}:${method}:clip`);
      setTimeout(() => { tab.dip = { width: params.clip.width, height: params.clip.height }; }, 80);
      return never();
    };
    return session;
  };
  // Given up on a few ms after the clip went out: the first read still shows the tab's own size.
  const error = await failing(captureScreenshot(tab.page, options(), { runBounded: (work) => new Promise((done, fail) => { work().then(done, fail); const watch = setInterval(() => { if (tab.log.some((line) => line.endsWith(':clip'))) { clearInterval(watch); setTimeout(() => fail(new Error('given up')), 5); } }, 1); }), deadline: Date.now() + 4000 }));
  assert.equal(error.phase, 'calibrate');
  assert.equal(error.tab, 'restored');
  await delay(200); // well past the moment the view took the clip's size
  assert.deepEqual(tab.view(), HOME, 'not left at 64x64');
  assert.ok(tab.log.includes('1:Emulation.setVisibleSize'), 'the late resize was seen and undone');
});

test('after a failed capture the tab is untouched, verified back at its own size, or retired before the answer', { timeout: 60_000 }, async () => {
  const cases = [
    // [name, query, what stalls, can the size be put back, expected phase, expected tab]
    ['no frame at all', {}, (method) => method === 'Page.captureScreenshot', true, 'present', 'untouched'],
    ['the scale measurement', {}, (method, params) => method === 'Page.captureScreenshot' && !!params.clip, true, 'calibrate', 'restored'],
    ['the scale measurement, size stuck', {}, (method, params) => method === 'Page.captureScreenshot' && !!params.clip, false, 'calibrate', 'retired'],
    ['the image at an emulated size', { width: '375' }, (method, params) => method === 'Page.captureScreenshot' && !!params.clip, true, 'capture', 'restored'],
    ['the image at an emulated size, size stuck', { width: '375' }, (method, params) => method === 'Page.captureScreenshot' && !!params.clip, false, 'capture', 'retired'],
    ['the image of a saved file', { save: '1', width: '1400' }, (method, params) => method === 'Page.captureScreenshot' && !!params.clip, true, 'file', 'restored'],
    ['setting the size', { width: '375' }, (method) => method === 'Emulation.setDeviceMetricsOverride', true, 'emulate', 'restored'],
    ['reading the layout', {}, (method) => method === 'Page.getLayoutMetrics', true, 'layout', 'untouched'],
  ];
  for (const [name, query, stall, fixable, phase, expected] of cases) {
    const tab = fakeTab();
    tab.stall = stall;
    if (!fixable) tab.refuse = (method, params, session) => (session.id > 0 && method.startsWith('Emulation.') ? new Error('Target closed') : method === 'Emulation.clearDeviceMetricsOverride' ? new Error('Target closed') : null);
    let retiredAt = null;
    let answeredAt = null;
    const error = await failing(captureScreenshot(tab.page, options(query), {
      runBounded: bound(250), deadline: Date.now() + 2500, presentTimeoutMs: 150,
      retire: () => { retiredAt = tab.log.length; return { closed: tab.page.close().then(() => true) }; },
    }).finally(() => { answeredAt = tab.log.length; }));
    assert.equal(error.phase, phase, `${name}: ${error.message}`);
    assert.equal(error.tab, expected, `${name}: ${error.message}`);
    if (expected === 'retired') {
      assert.notEqual(retiredAt, null, `${name}: taken out of routing`);
      assert.ok(retiredAt <= answeredAt, `${name}: before the answer`);
      assert.equal(error.viewportRestored, false, name);
      assert.equal(error.tabClosed, true, `${name}: the close was confirmed`);
    } else {
      assert.equal(retiredAt, null, `${name}: the tab is kept`);
      assert.deepEqual(tab.view(), HOME, `${name}: at its own width, height and devicePixelRatio`);
      assert.notEqual(error.viewportRestored, false, name);
    }
    assert.equal(tab.sessions.filter((session) => !session.detached).length, 0, `${name}: every CDP session it opened is detached (${tab.log.join(' ')})`);
  }
});

test('a tab already confirmed back when the deadline comes is kept, though its CDP session is still being let go', { timeout: 20_000 }, async () => {
  const tab = fakeTab();
  let retired = 0;
  const started = Date.now();
  // The override is cleared and confirmed at once; only the detach of the capture's session never answers.
  const original = tab.page.context().newCDPSession;
  tab.page.context().newCDPSession = async () => { const session = await original(); if (session.id === 0) session.detach = never; return session; };
  const error = await failing(captureScreenshot(tab.page, options({ width: '375' }), { runBounded: bound(100), deadline: started + 700, retire: () => { retired += 1; return { closed: never() }; } }));
  assert.equal(error.phase, 'emulate', 'given up on while the new size settled: the override is out, no clip yet');
  assert.equal(error.tab, 'restored', error.message);
  assert.equal(retired, 0);
  assert.deepEqual(tab.view(), HOME);
  assert.ok(Date.now() - started <= 1000, `${Date.now() - started} ms`);
});

// ── d. a capture that never settles ─────────────────────────────────────────

test('while a cut-short capture is still being put back the next caller is told at once, and captures go on once it is back', { timeout: 20_000 }, async () => {
  const tab = fakeTab();
  firstClipStalls(tab);
  tab.hold = (method) => (method === 'Emulation.setVisibleSize' ? 300 : 0); // putting the size back takes a while
  const a = failing(captureScreenshot(tab.page, options(), { runBounded: bound(100), deadline: Date.now() + 4000 }));
  // A caller already in line gives up waiting while A is being put back: that changes nothing for those who come next.
  const impatient = failing(captureScreenshot(tab.page, options(), { runBounded: bound(110), deadline: Date.now() + 4000 }));
  await delay(200); // A was given up on at 100 ms and is putting the tab back
  assert.equal((await impatient).phase, 'queue');
  const sessions = tab.sessions.length;
  const started = Date.now();
  const refused = await failing(captureScreenshot(tab.page, options(), { deadline: Date.now() + 4000 }));
  assert.ok(Date.now() - started < 60, `told at once: ${Date.now() - started} ms`);
  assert.equal(refused.code, 'SCREENSHOT_TAB_RECOVERING');
  assert.equal(refused.phase, 'recover');
  assert.match(refused.message, /being put back/);
  assert.equal(tab.sessions.length, sessions, 'the refused call sent nothing');
  const failed = await a;
  assert.equal(failed.phase, 'calibrate');
  assert.equal(failed.tab, 'restored');
  const shot = await captureScreenshot(tab.page, options(), { deadline: Date.now() + 4000 });
  assert.deepEqual([shot.width, shot.height], [HOME.width, HOME.height]);
  assert.deepEqual(tab.view(), HOME);
});

test('a capture that never settles is ended by its own budget, its tab retired, and every later caller refused at once', { timeout: 8000 }, async () => {
  const tab = fakeTab();
  // The scale measurement never answers, and from then on nothing does, the detach included.
  let stalled = false;
  tab.stall = (method, params) => { if (method === 'Page.captureScreenshot' && params.clip) { stalled = true; tab.frozen = true; } return stalled; };
  tab.newSession = (make) => (stalled ? never() : Promise.resolve(make()));
  let retired = 0;
  const started = Date.now();
  // No bound from the caller at all: only the deadline.
  const first = failing(captureScreenshot(tab.page, options(), { deadline: started + 600, retire: () => { retired += 1; return { closed: never() }; } }));
  await delay(50);
  const queued = failing(captureScreenshot(tab.page, options(), { deadline: started + 6000 }));
  const error = await first;
  assert.ok(Date.now() - started <= 700, `answered at ${Date.now() - started} ms, deadline 600`);
  assert.equal(error.phase, 'calibrate');
  assert.equal(error.tab, 'retired');
  assert.equal(retired, 1);
  // The caller that was waiting behind it is answered when the tab is retired, not at its own deadline.
  const behind = await queued;
  assert.ok(Date.now() - started <= 900, `the waiter was answered at ${Date.now() - started} ms`);
  assert.equal(behind.code, 'SCREENSHOT_TAB_RETIRED');
  assert.equal(behind.phase, 'retired');
  // And so is every later one, without a command sent.
  const commands = tab.log.length;
  const later = Date.now();
  const records = [];
  const refused = await failing(captureScreenshot(tab.page, options(), { deadline: Date.now() + 6000, onRecord: (record) => records.push(record) }));
  assert.ok(Date.now() - later < 60);
  assert.equal(refused.code, 'SCREENSHOT_TAB_RETIRED');
  assert.match(refused.message, /retired/);
  assert.equal(tab.log.length, commands);
  assert.deepEqual(records.map((record) => [record.outcome, record.phase, record.code, record.tab]), [['refused', 'retired', 'SCREENSHOT_TAB_RETIRED', 'untouched']], 'recorded as a call that was refused');
});

test('a capture given up on sends nothing more, not even a read, when what it waited for arrives', { timeout: 20_000 }, async () => {
  const tab = fakeTab();
  // A's first frame comes 300 ms late, and the detach of its session never answers.
  tab.hold = (method, params) => (method === 'Page.captureScreenshot' && !params.clip && tab.sessions.length === 1 ? 300 : 0);
  const original = tab.page.context().newCDPSession;
  tab.page.context().newCDPSession = async () => { const session = await original(); if (session.id === 0) session.detach = never; return session; };
  const a = await failing(captureScreenshot(tab.page, options({ width: '375' }), { runBounded: bound(100), deadline: Date.now() + 1000 }));
  assert.equal(a.phase, 'present');
  await delay(400); // the frame A waited for has arrived by now
  // The second window read is the one taken as the capture was given up on (100 ms), for the record of the failure.
  assert.deepEqual(tab.log.filter((line) => line.startsWith('0:')), ['0:open', '0:Page.captureScreenshot', '0:Browser.getWindowForTarget', '0:Browser.getWindowForTarget'], 'nothing after the frame it was waiting for');
});

test('the answer does not wait for a close that never answers', { timeout: 20_000 }, async () => {
  const tab = fakeTab();
  clipsStall(tab);
  tab.refuse = (method) => (method === 'Emulation.setVisibleSize' ? new Error('not allowed') : null);
  const started = Date.now();
  const error = await failing(captureScreenshot(tab.page, options(), { runBounded: bound(100), deadline: started + 15_000, retire: () => ({ closed: never() }) }));
  const took = Date.now() - started;
  assert.equal(error.tab, 'retired');
  assert.equal(error.tabClosed, false);
  assert.ok(took < 4500, `answered at ${took} ms: about 3 s for the close, not the 15 s of the deadline`);
});

// ── e. nothing leaks when something arrives late ────────────────────────────

test('a CDP session that arrives after its wait was given up is detached (finding 6)', { timeout: 20_000 }, async () => {
  // The session restoreViewSize asks for arrives 100 ms after the 2 s it waits.
  const sized = fakeTab({ width: 64, height: 64 });
  let late = null;
  sized.newSession = (make) => delay(2100).then(() => { late = make(); return late; });
  assert.equal(await restoreViewSize(sized.page, HOME), false);
  await delay(300);
  assert.ok(late, 'it did arrive');
  assert.equal(late.detached, true, 'and was detached');

  // The fresh session of restoreViewport, with a budget that ends before it arrives.
  const emulated = fakeTab();
  const first = await emulated.page.context().newCDPSession(emulated.page);
  await first.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 600, deviceScaleFactor: 1, mobile: true });
  emulated.refuse = (method, params, session) => (session.id === 0 && method === 'Emulation.clearDeviceMetricsOverride' ? new Error('Target closed') : null);
  let fresh = null;
  emulated.newSession = (make) => delay(700).then(() => { fresh = make(); return fresh; });
  assert.equal(await restoreViewport(emulated.page, first, HOME, { until: Date.now() + 400 }), false);
  await delay(500);
  assert.ok(fresh, 'it did arrive');
  assert.equal(fresh.detached, true, 'and was detached');

  // The capture's own session, arriving after the capture was given up on.
  const slow = fakeTab();
  let own = null;
  slow.newSession = (make) => delay(300).then(() => { own = make(); return own; });
  const error = await failing(captureScreenshot(slow.page, options(), { runBounded: bound(100), deadline: Date.now() + 3000 }));
  assert.equal(error.phase, 'session');
  await delay(350);
  assert.equal(own.detached, true);
  assert.deepEqual(slow.log, ['0:open', '0:detach'], 'nothing was sent through it');
});

// ── what the error says, and what is recorded ───────────────────────────────

test('every capture is recorded once with the window state CDP reported, and the error text carries the phase and the window state', { timeout: 20_000 }, async () => {
  const records = [];
  const capture = (tab, query = {}, extra = {}) => captureScreenshot(tab.page, options(query), { deadline: Date.now() + 3000, presentTimeoutMs: 400, onRecord: (record) => records.push(record), ...extra });

  // A tab of a minimized window that does present (a background tab): captured, and recorded as such.
  const tab = fakeTab({ windowState: 'minimized' });
  await capture(tab);
  assert.equal(records.length, 1);
  assert.deepEqual({ ...records[0], ms: undefined }, { outcome: 'ok', phase: null, code: null, windowState: 'minimized', windowAtStart: 'minimized', tab: 'untouched', tabClosed: null, ms: undefined });
  assert.equal(typeof records[0].ms, 'number');

  // No frame, window minimized.
  tab.stall = (method) => method === 'Page.captureScreenshot';
  const minimized = await failing(capture(tab));
  assert.equal(records.length, 2);
  assert.deepEqual([records[1].outcome, records[1].phase, records[1].code, records[1].windowState, records[1].tab], ['failed', 'present', 'SCREENSHOT_NOT_PRESENTING', 'minimized', 'untouched']);
  assert.equal(minimized.windowState, 'minimized');
  assert.match(minimized.message, /phase present/);
  assert.match(minimized.message, /window state from CDP: minimized/);
  assert.match(minimized.message, /not resized/);

  // No frame, window state normal: the text says what was read and guesses no cause.
  tab.windowState = 'normal';
  const normal = await failing(capture(tab));
  assert.match(normal.message, /phase present/);
  assert.match(normal.message, /window state from CDP: normal/);
  for (const error of [minimized, normal]) assert.doesNotMatch(error.message, /probably|sleeping display|another desktop|main thread/i, error.message);
  assert.equal(records[2].windowState, 'normal');

  // The window is minimized between the first frame and the scale measurement: both states are recorded.
  const flipped = fakeTab();
  flipped.stall = (method, params) => { if (method === 'Page.captureScreenshot' && params.clip) { flipped.windowState = 'minimized'; return true; } return false; };
  const midway = await failing(capture(flipped, {}, { runBounded: bound(150) }));
  assert.equal(midway.phase, 'calibrate');
  assert.equal(midway.windowState, 'minimized');
  assert.match(midway.message, /timed out while measuring the capture scale/);
  assert.match(midway.message, /phase calibrate/);
  assert.match(midway.message, /window state from CDP: minimized/);
  assert.deepEqual([records[3].outcome, records[3].phase, records[3].windowState, records[3].windowAtStart, records[3].tab], ['failed', 'calibrate', 'minimized', 'normal', 'restored']);

  // A failure that is not a timeout carries them too.
  const broken = fakeTab();
  broken.refuse = (method, params) => (method === 'Page.captureScreenshot' && params.clip ? new Error('Protocol error (Page.captureScreenshot): Unable to capture screenshot') : null);
  const refused = await failing(capture(broken));
  assert.match(refused.message, /Unable to capture screenshot/);
  assert.match(refused.message, /phase calibrate/);
  assert.match(refused.message, /window state from CDP: normal/);
  assert.equal(records.length, 5);
});

// ── through the server.js route ─────────────────────────────────────────────

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const between = (start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `server.js marker not found: ${start}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `server.js end marker not found: ${end}`);
  return source.slice(from, to);
};
class Response extends EventEmitter {
  constructor() { super(); this.code = 200; this.headersSent = false; this.destroyed = false; this.writableFinished = false; }
  setHeader() {}
  status(code) { this.code = code; return this; }
  send() { return this; }
  json(body) { this.body = body; this.headersSent = true; this.writableFinished = true; this.emit('finish'); return this; }
}
/** The real screenshot route and the real request middleware over a session whose one tab is `tab` (plus `others`). */
function routeHarness(tab, { others = [], loopLog = null, clients = [] } = {}) {
  const session = { tabs: new Map([['tab', { page: tab.page, title: 'Example', url: tab.url }], ...others.map((id) => [id, { page: fakeTab().page }])]), activeTabId: 'tab', _tabOwners: new Map([['run-1', 'tab']]), clients: new Set(clients) };
  const logs = [];
  const events = [];
  // What the handler threw or rejected with: in the server that is an unhandled rejection.
  const errors = [];
  let handler;
  const context = vm.createContext({
    app: { get(_path, fn) { handler = fn; } },
    console: { log() {}, warn() {}, error() {} }, Buffer, resolve, setTimeout, clearTimeout,
    browserSessions: new Map([['session', session]]),
    getTargetPage: (target, req) => { const entry = target.tabs.get(req.query.tabId); return entry ? { page: entry.page, tabId: req.query.tabId } : null; },
    parseScreenshotOptions, screenshotPathRefusal, defaultScreenshotPath, writeScreenshotFile, captureScreenshot, runBrowserRequest,
    selectedTabReading: backgroundTab.selectedTabReading,
    loopLog: loopLog || ((owner, tag, message, meta) => { logs.push({ owner, tag, message, meta }); }),
    clearAiSnapshotCache: (sessionId, tabId) => { events.push(['snapshot-cache-cleared', sessionId, tabId]); },
    broadcastSync: (message) => { events.push([message.type, message.sessionId, message.tabId]); },
    _switchSessionTab: async (target, sessionId, tabId) => { events.push(['switched', sessionId, tabId]); target.activeTabId = tabId; },
    // The route of before these fixes closed tabs through these two.
    closeSessionTab: async (target, sessionId, tabId) => { target.tabs.delete(tabId); await target.tabs.get(tabId)?.page.close(); },
    syncPageState: async (target, routed) => ({ url: routed.page.url(), title: await routed.page.title().catch(() => '') }),
    DATA_HOME: '/private/tmp',
  });
  vm.runInContext(between('// GET …/screenshot-base64', '// GET …/console'), context);
  const get = (query = {}, { deadlineMs = 4000, headers = { 'X-Synabun-Deadline': String(Date.now() + deadlineMs), 'X-Synabun-Terminal': 'run-1' } } = {}) => {
    const req = Object.assign(new EventEmitter(), { params: { id: 'session' }, query: { tabId: 'tab', ...query }, method: 'GET', path: '/screenshot-base64', headers: {}, get: (name) => headers[name] });
    const res = new Response();
    const started = Date.now();
    return new Promise((done) => {
      res.once('finish', () => done({ status: res.code, body: res.body, took: Date.now() - started }));
      browserRequestMiddleware(req, res, () => { Promise.resolve().then(() => handler(req, res)).catch((error) => { errors.push(error); }); });
    });
  };
  return { session, logs, events, errors, get };
}

test('route: the answer names the phase before the request deadline even when nothing of the cleanup answers (finding 2)', { timeout: 20_000 }, async () => {
  const tab = fakeTab();
  let stalled = false;
  tab.stall = (method, params) => { if (method === 'Page.captureScreenshot' && params.clip) { stalled = true; tab.frozen = true; } return stalled && method !== 'Browser.getWindowForTarget'; };
  tab.newSession = (make) => (stalled ? never() : Promise.resolve(make()));
  tab.closing = never; // the close never answers either
  const { get, session, logs } = routeHarness(tab);
  const answer = await get({ width: '375' }, { deadlineMs: 2500 });
  assert.notEqual(answer.status, 408, `the route answers itself: ${JSON.stringify(answer.body)}`);
  assert.ok(answer.took < 2500, `${answer.took} ms`);
  assert.equal(answer.body.phase, 'capture');
  assert.match(answer.body.error, /timed out while capturing the image/);
  assert.match(answer.body.error, /phase capture/);
  assert.match(answer.body.error, /window state from CDP: normal/);
  assert.equal(answer.body.windowState, 'normal');
  assert.equal(answer.body.tabRetired, true);
  assert.equal(answer.body.tabClosed, false);
  assert.match(answer.body.error, /took the tab out of routing/);
  assert.match(answer.body.error, /not confirmed/);
  assert.equal(session.tabs.has('tab'), false, 'out of routing');
  assert.equal(tab.closeCalls, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /outcome=failed phase=capture/);
});

test('route: a title that never answers neither delays the answer nor keeps an unrestored tab in routing (finding 3)', { timeout: 20_000 }, async () => {
  // The capture succeeds at an emulated size, the override cannot be cleared, and the title read never answers.
  const tab = fakeTab();
  tab.refuse = (method, params, session) => (method === 'Emulation.clearDeviceMetricsOverride' || (session.id > 0 && method.startsWith('Emulation.')) ? new Error('Target closed') : null);
  tab.titleRead = never;
  const { get, session, events } = routeHarness(tab, { others: ['other'] });
  const answer = await get({ width: '375' }, { deadlineMs: 3000 });
  assert.equal(answer.status, 200, JSON.stringify({ ...answer.body, data: undefined }));
  assert.ok(answer.took < 3000, `${answer.took} ms`);
  assert.equal(answer.body.tabRetired, true);
  assert.equal(answer.body.tabClosed, true);
  assert.equal(answer.body.notice, 'SynaBun could not confirm the tab was back at its own viewport size after the capture, so it closed the tab; the next browser call opens a fresh one.');
  assert.equal(session.tabs.has('tab'), false);
  assert.equal(session.tabs.has('other'), true);
  assert.equal(session.activeTabId, 'other', 'the session moved on to the tab that is left');
  assert.equal(tab.closed, true);
  assert.deepEqual(events.map(([type]) => type), ['snapshot-cache-cleared', 'switched', 'browser:tab-retired', 'browser:tab-closed'], 'out of routing first; closed is announced once the page reported it');

  // A healthy capture whose title read never answers: answered in time, with the title last known.
  const healthy = fakeTab();
  healthy.titleRead = never;
  const fine = routeHarness(healthy);
  const shot = await fine.get({}, { deadlineMs: 1500 });
  assert.equal(shot.status, 200, JSON.stringify({ ...shot.body, data: undefined }));
  assert.ok(shot.took < 1500, `${shot.took} ms`);
  assert.equal(shot.body.title, 'Example');
  assert.equal(shot.body.tabRetired, undefined);
});

test('route: a tab that cannot be verified is out of routing at once, and reported closed only when the close was confirmed (finding 5)', { timeout: 30_000 }, async () => {
  const unrestorable = () => {
    const tab = fakeTab();
    clipsStall(tab);
    tab.refuse = (method) => (method === 'Emulation.setVisibleSize' ? new Error('not allowed') : null);
    return tab;
  };
  // The close is refused.
  const refusing = unrestorable();
  refusing.closing = () => Promise.reject(new Error('CDP close refused'));
  const first = routeHarness(refusing);
  const refused = await first.get({}, { deadlineMs: 1500 });
  assert.equal(refused.body.phase, 'calibrate');
  assert.equal(refused.body.tabRetired, true);
  assert.equal(refused.body.tabClosed, false, 'the page is still open: not reported as closed');
  assert.match(refused.body.error, /took the tab out of routing/);
  assert.match(refused.body.error, /not confirmed/);
  assert.equal(first.session.tabs.has('tab'), false, 'out of routing whatever the close did');
  assert.equal(first.session.activeTabId, null);
  assert.equal(refusing.closed, false);
  const gone = await first.get({}, { deadlineMs: 1500 });
  assert.equal(gone.status, 404, 'the next call does not reach the tab');

  // The close is confirmed.
  const closing = unrestorable();
  const second = routeHarness(closing);
  const closed = await second.get({}, { deadlineMs: 1500 });
  assert.equal(closed.body.tabRetired, true);
  assert.equal(closed.body.tabClosed, true);
  assert.match(closed.body.error, /^Screenshot timed out while measuring the capture scale \(phase calibrate, [\d.]+ s in it; window state from CDP: normal\)\. SynaBun could not confirm the tab was back at its own viewport size after the capture, so it closed the tab; the next browser call opens a fresh one\.$/);
  assert.equal(closing.closed, true);
  assert.equal(second.session.tabs.has('tab'), false);

  // The close never answers: the answer does not wait for it past the deadline.
  const hanging = unrestorable();
  hanging.closing = never;
  const third = routeHarness(hanging);
  const waited = await third.get({}, { deadlineMs: 1500 });
  assert.notEqual(waited.status, 408, JSON.stringify(waited.body));
  assert.ok(waited.took < 1500, `${waited.took} ms`);
  assert.equal(waited.body.tabClosed, false);
  assert.equal(third.session.tabs.has('tab'), false);
});

test('route: retiring a tab leaves alone a fresh page that replaced it under the same tab id', { timeout: 20_000 }, async () => {
  const tab = fakeTab();
  clipsStall(tab);
  tab.refuse = (method) => (method === 'Emulation.setVisibleSize' ? new Error('not allowed') : null);
  const { get, session, events } = routeHarness(tab);
  const pending = get({}, { deadlineMs: 1500 });
  await delay(100);
  // The wedged tab is replaced while its capture is still under way: same id, a fresh page.
  const replacement = fakeTab();
  session.tabs.set('tab', { page: replacement.page, title: '', url: 'about:blank' });
  const answer = await pending;
  assert.equal(answer.body.phase, 'calibrate');
  assert.equal(answer.body.tabRetired, true, 'the page the capture ran on is retired');
  assert.equal(tab.closeCalls, 1);
  assert.equal(session.tabs.get('tab')?.page, replacement.page, 'the fresh page keeps the tab id');
  assert.equal(session.activeTabId, 'tab');
  assert.equal(replacement.closeCalls, 0);
  assert.deepEqual(events, [], 'nothing was announced as closed');
  const next = await get({}, { deadlineMs: 3000 });
  assert.equal(next.status, 200, 'and the next call reaches it');
});

test('route: one log line per capture, and the window state and the selected-tab reading in the error', { timeout: 20_000 }, async () => {
  const tab = fakeTab({ windowState: 'minimized' });
  const { get, logs } = routeHarness(tab);
  // A tab of a minimized window that presents: captured.
  const ok = await get({});
  assert.equal(ok.status, 200);
  assert.equal(logs.length, 1);
  assert.deepEqual([logs[0].owner, logs[0].tag], ['run-1', 'browser:screenshot']);
  assert.match(logs[0].message, /^session=session tab=tab window=minimized selected=likely outcome=ok ms=\d+$/);
  assert.equal(logs[0].meta.selectedBasis, 'newest-foreground-tab');

  // The same tab presenting nothing.
  tab.stall = (method) => method === 'Page.captureScreenshot';
  const stalled = await get({});
  assert.equal(stalled.status, 503);
  assert.deepEqual([stalled.body.code, stalled.body.phase, stalled.body.windowState, stalled.body.selectedTab], ['SCREENSHOT_NOT_PRESENTING', 'present', 'minimized', 'likely']);
  assert.match(stalled.body.error, /window state from CDP: minimized/);
  assert.equal(logs.length, 2);
  assert.match(logs[1].message, /^session=session tab=tab window=minimized selected=likely outcome=failed phase=present ms=\d+$/);
  assert.equal(logs[1].meta.code, 'SCREENSHOT_NOT_PRESENTING');

  // A newer tab was opened after this one: it took the selection when it opened.
  tab.stall = () => false;
  tab.pages = [tab.page, fakeTab().page];
  await get({});
  assert.match(logs[2].message, /window=minimized selected=unlikely outcome=ok/);
  assert.equal(logs[2].meta.selectedBasis, 'newer-tab-open');
});

test('route: the log file is named by a plain caller id only', { timeout: 20_000 }, async () => {
  const { get, logs } = routeHarness(fakeTab());
  const call = async (terminal) => {
    const headers = { 'X-Synabun-Deadline': String(Date.now() + 4000), 'X-Synabun-Terminal': terminal };
    return get({}, { headers });
  };
  await call('0178dcf3-eea4-4176-aa1d-6d4a7c164d3e');
  await call('a/../../../etc/passwd');
  await call('x'.repeat(200));
  assert.deepEqual(logs.map((entry) => entry.owner), ['0178dcf3-eea4-4176-aa1d-6d4a7c164d3e', null, null]);
  assert.ok(logs.every((entry) => /outcome=ok/.test(entry.message)), 'the line is written to the console either way');
});

// ── round 2 of review: restore over time, unconfirmed detach, routing, the log ──

/** Every CDP session of `tab` from now on goes through `change(session)` first. */
function rewire(tab, change) {
  const context = tab.page.context();
  const original = context.newCDPSession;
  context.newCDPSession = async () => change(await original()) || tab.sessions.at(-1);
}
/** What console.warn was given while the test ran, as lines. */
function warnings(t) {
  const lines = [];
  t.mock.method(console, 'warn', (...parts) => { lines.push(parts.join(' ')); });
  return lines;
}

test('a sized capture given up on as its clip goes out is not taken for restored on one reading: the resize that comes 80 ms later is undone (round 2, finding 1)', { timeout: 20_000 }, async () => {
  const tab = fakeTab();
  let clip = false;
  let retired = 0;
  // The image never answers, and the view takes the clip's size 80 ms after it was sent.
  rewire(tab, (session) => {
    const send = session.send;
    session.send = (method, params = {}) => {
      if (method !== 'Page.captureScreenshot' || !params.clip) return send(method, params);
      clip = true;
      tab.log.push(`${session.id}:${method}:clip`);
      setTimeout(() => { tab.dip = { width: Math.round(params.clip.width * params.clip.scale), height: Math.round(params.clip.height * params.clip.scale) }; }, 80);
      return never();
    };
  });
  const error = await failing(captureScreenshot(tab.page, options({ width: '375' }), {
    deadline: Date.now() + 4000,
    // Given up on 5 ms after the clip went out: the first reading after the clear still shows the tab's own size.
    runBounded: (work) => new Promise((done, fail) => { work().then(done, fail); const watch = setInterval(() => { if (clip) { clearInterval(watch); setTimeout(() => fail(new Error('given up')), 5); } }, 1); }),
    retire: () => { retired += 1; return { closed: tab.page.close().then(() => true) }; },
  }));
  assert.equal(error.phase, 'capture');
  await delay(300); // well past the moment the view took the clip's size
  assert.deepEqual([error.tab, retired, tab.view()], ['restored', 0, HOME], 'said to be restored, and it is: not left at 375x600');
});

test('a view that changes again right after it was put back is not taken for restored (round 2, finding 1)', { timeout: 20_000 }, async () => {
  const tab = fakeTab({ width: 64, height: 64 }); // what a stalled 64 px clip left
  // The size asked for is taken, and 60 ms later the view is at the clip's size again.
  rewire(tab, (session) => {
    const send = session.send;
    session.send = (method, params = {}) => {
      if (method === 'Emulation.setVisibleSize') setTimeout(() => { tab.dip = { width: 64, height: 64 }; }, 60);
      return send(method, params);
    };
  });
  assert.equal(await restoreViewSize(tab.page, HOME), false, 'one good reading right after the resize is not a tab that stays restored');
});

test('an unanswered capture whose CDP session is not confirmed detached is never overlapped: later callers are told at once and the tab is given back when it ends (round 2, finding 2)', { timeout: 30_000 }, async (t) => {
  const warned = warnings(t);
  // The first frame of the first capture gets no answer until `answer()`; the detach of its session behaves as `detach` says.
  const stuck = (detach) => {
    const tab = fakeTab();
    const state = { tab, active: 0, most: 0, answer: null, retired: [] };
    rewire(tab, (session) => {
      if (session.id !== 0) return;
      const send = session.send;
      session.send = (method, params = {}) => {
        if (method !== 'Page.captureScreenshot' || params.clip) return send(method, params);
        tab.log.push('0:Page.captureScreenshot');
        state.active += 1;
        state.most = Math.max(state.most, state.active);
        return new Promise((done) => { state.answer = () => { state.active -= 1; done({ data: '' }); }; });
      };
      session.detach = detach;
    });
    state.capture = (extra = {}) => captureScreenshot(tab.page, options(), { deadline: Date.now() + 2700, presentTimeoutMs: 40, retire: (reason) => { state.retired.push(reason); return { closed: never() }; }, ...extra });
    return state;
  };

  // 1. The detach never answers; the capture answers later.
  const ended = (async () => {
    const state = stuck(never);
    const first = failing(state.capture());
    await delay(10);
    const queued = failing(state.capture({ deadline: Date.now() + 9000 })); // already waiting its turn
    const error = await first;
    const answered = Date.now();
    assert.deepEqual([error.phase, error.tab, error.capturePending], ['present', 'untouched', true], error.message);
    assert.match(error.message, /may still be pending/);
    const behind = await queued;
    assert.ok(Date.now() - answered < 200, `the caller that was waiting is told when the hold begins: ${Date.now() - answered} ms`);
    assert.deepEqual([behind.code, behind.phase, behind.status], ['SCREENSHOT_CAPTURE_PENDING', 'pending', 503]);
    const started = Date.now();
    const next = await failing(state.capture());
    assert.ok(Date.now() - started < 60, `told at once: ${Date.now() - started} ms`);
    assert.deepEqual([next.code, next.phase, next.status], ['SCREENSHOT_CAPTURE_PENDING', 'pending', 503]);
    assert.match(next.message, /not be confirmed detached/);
    assert.deepEqual([state.tab.sessions.length, state.most, state.retired.length], [1, 1, 0], 'no second CDP session, no second capture, and the tab is kept: nothing sent can resize it');
    state.answer(); // the capture answers after all
    await delay(30);
    const shot = await state.capture({ deadline: Date.now() + 3000 });
    assert.deepEqual([shot.width, shot.height, state.most], [HOME.width, HOME.height, 1]);
  })();

  // 2. The detach answers late (2.4 s, after the 2 s it is waited for): the tab is given back then.
  const detachedLate = (async () => {
    const state = stuck(() => delay(2400));
    const error = await failing(state.capture());
    assert.equal(error.capturePending, true);
    assert.equal((await failing(state.capture())).code, 'SCREENSHOT_CAPTURE_PENDING');
    await delay(600);
    const shot = await state.capture({ deadline: Date.now() + 3000 });
    assert.deepEqual([shot.width, shot.height, state.most], [HOME.width, HOME.height, 1]);
  })();

  // 3. Neither happens: the hold is bounded, then the tab is retired.
  const bounded = (async () => {
    const state = stuck(never);
    const error = await failing(state.capture({ pendingHoldMs: 300 }));
    assert.equal(error.capturePending, true);
    assert.equal(state.retired.length, 0, 'not retired while the hold lasts');
    await delay(450);
    assert.deepEqual(state.retired, ['pending'], 'retired once, when the hold is over');
    const later = await failing(state.capture());
    assert.deepEqual([later.code, later.status], ['SCREENSHOT_TAB_RETIRED', 410]);
    assert.match(later.message, /confirmed detached/);
    assert.deepEqual([state.tab.sessions.length, state.most], [1, 1]);
  })();

  await Promise.all([ended, detachedLate, bounded]);
  assert.ok(warned.some((line) => /not confirmed detached/.test(line)), `the detach that did not answer is recorded: ${warned.join(' | ')}`);
});

test('a capture with a clip still unanswered on a session not confirmed detached retires the tab, whatever the page reads (round 2, finding 2)', { timeout: 20_000 }, async () => {
  const tab = fakeTab();
  // The scale measurement is never answered and (not yet) applied: the page still reads its own size. The detach never answers.
  rewire(tab, (session) => {
    if (session.id !== 0) return;
    const send = session.send;
    session.send = (method, params = {}) => (method === 'Page.captureScreenshot' && params.clip ? (tab.log.push('0:Page.captureScreenshot:clip'), never()) : send(method, params));
    session.detach = never;
  });
  let retired = 0;
  const error = await failing(captureScreenshot(tab.page, options(), { runBounded: bound(100), deadline: Date.now() + 3500, retire: () => { retired += 1; return { closed: tab.page.close().then(() => true) }; } }));
  assert.deepEqual([error.phase, error.tab, retired], ['calibrate', 'retired', 1], 'a clip the browser may still apply: nothing read now confirms the tab');
  assert.equal((await failing(captureScreenshot(tab.page, options(), { deadline: Date.now() + 2000 }))).code, 'SCREENSHOT_TAB_RETIRED');
});

test('a detach that fails is recorded, for the capture\'s session and for one that arrived late (round 2, finding 2)', { timeout: 20_000 }, async (t) => {
  const warned = warnings(t);
  // A capture that works, on a session whose detach is refused.
  const tab = fakeTab();
  rewire(tab, (session) => { session.detach = async () => { throw new Error('transient detach refused'); }; });
  const shot = await captureScreenshot(tab.page, options(), { deadline: Date.now() + 2000 });
  assert.deepEqual([shot.width, shot.height], [HOME.width, HOME.height], 'the capture itself is not failed by it');
  assert.ok(warned.some((line) => /not confirmed detached/.test(line) && /transient detach refused/.test(line)), warned.join(' | '));
  // Nothing is pending on it, so the tab is not held.
  assert.ok((await captureScreenshot(tab.page, options(), { deadline: Date.now() + 2000 })).data !== undefined);

  // The capture's session arrives after the capture was given up on, and its detach is refused.
  warned.length = 0;
  const slow = fakeTab();
  slow.newSession = (make) => delay(100).then(() => { const late = make(); late.detach = async () => { throw new Error('late detach refused'); }; return late; });
  const error = await failing(captureScreenshot(slow.page, options(), { runBounded: bound(20), deadline: Date.now() + 1000 }));
  assert.equal(error.phase, 'session');
  await delay(200);
  assert.ok(warned.some((line) => /not confirmed detached/.test(line) && /late detach refused/.test(line)), warned.join(' | '));
});

test('a caller waiting its turn hears of the retirement though the cleanup before it never ends (round 2: the mutation that survived)', { timeout: 20_000 }, async () => {
  const tab = fakeTab();
  clipsStall(tab);
  const started = Date.now();
  // Putting the size back never resolves, so the turn is never released: only the wake-up tells the waiter.
  const first = failing(captureScreenshot(tab.page, options(), { runBounded: bound(30), deadline: started + 350, restoreSize: never, retire: () => ({ closed: never() }) }));
  await delay(20);
  const queued = failing(captureScreenshot(tab.page, options(), { deadline: started + 5000 }));
  const behind = await Promise.race([queued, delay(900).then(() => null)]);
  assert.notEqual(behind, null, 'the waiter was not told');
  assert.deepEqual([behind.code, behind.phase], ['SCREENSHOT_TAB_RETIRED', 'retired']);
  assert.ok(Date.now() - started < 700, `${Date.now() - started} ms`);
  assert.equal((await first).tab, 'retired');
});

test('the window state of a failure is the one read when it failed, with the one from before when they differ (round 2, finding 6)', { timeout: 20_000 }, async () => {
  const records = [];
  const capture = (tab) => failing(captureScreenshot(tab.page, options(), { deadline: Date.now() + 3000, presentTimeoutMs: 300, onRecord: (record) => records.push(record) }));
  // No first frame; the window is minimized 40 ms into the wait.
  const tab = fakeTab();
  tab.stall = (method) => method === 'Page.captureScreenshot';
  setTimeout(() => { tab.windowState = 'minimized'; }, 40);
  const flipped = await capture(tab);
  assert.deepEqual([flipped.phase, flipped.code, flipped.windowState, flipped.windowAtStart], ['present', 'SCREENSHOT_NOT_PRESENTING', 'minimized', 'normal']);
  assert.match(flipped.message, /window state from CDP: minimized when it stopped, normal when it began/);
  assert.deepEqual([records[0].windowState, records[0].windowAtStart], ['minimized', 'normal']);
  // What was measured is a command without an answer, and the text says that.
  assert.match(flipped.message, /got no answer/);
  assert.doesNotMatch(flipped.message, /presented no frame|present a frame|presents no frame/);

  // The state cannot be read again when it fails: reported as unknown, never as the earlier reading.
  const mute = fakeTab();
  let reads = 0;
  mute.stall = (method) => method === 'Page.captureScreenshot' || (method === 'Browser.getWindowForTarget' && (reads += 1) > 1);
  const unknown = await capture(mute);
  assert.deepEqual([unknown.phase, unknown.windowState, unknown.windowAtStart], ['present', null, 'normal']);
  assert.match(unknown.message, /window state from CDP: unknown when it stopped, normal when it began/);
  assert.deepEqual([records[1].windowState, records[1].windowAtStart], [null, 'normal']);

  // The same state at both readings is said once.
  const steady = fakeTab();
  steady.stall = (method) => method === 'Page.captureScreenshot';
  const same = await capture(steady);
  assert.match(same.message, /window state from CDP: normal\)/);
  assert.deepEqual([same.windowState, same.windowAtStart, records[2].windowState, records[2].windowAtStart], ['normal', 'normal', 'normal', 'normal']);
});

/** The real _switchSessionTab, unrouteScreenshotTab, retireScreenshotTab and getTargetPage of server.js over a session of fake tabs (the first one active). */
function routing(ids, { stopScreencast = async () => {} } = {}) {
  const events = [];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, JSON, Date, setTimeout, clearTimeout,
    app: { get() {} },
    stopScreencast, startScreencast: async () => {},
    clearAiSnapshotCache() {}, broadcastSync: (message) => { events.push(message.type); }, trackRoute() {}, sessionOwnerCount: () => 0,
  });
  vm.runInContext(between('async function _switchSessionTab(', '/**\n * Close a single tab') + between('// GET …/screenshot-base64', '// GET …/console') + between('function getTargetPage(', '/** Update session-level'), context);
  const tabs = Object.fromEntries(ids.map((id) => [id, fakeTab()]));
  const session = {
    tabs: new Map(ids.map((id) => [id, { page: tabs[id].page, cdpSession: { id }, url: `https://${id}.test/`, title: id }])),
    activeTabId: ids[0], page: tabs[ids[0]].page, cdpSession: { id: ids[0] }, currentUrl: `https://${ids[0]}.test/`, title: ids[0], clients: new Set(),
  };
  const retire = (id) => context.retireScreenshotTab(session, 'session', { tabId: id, page: tabs[id].page });
  /** What a call without a tab id and without a caller id (the web UI) is routed to. */
  const routed = () => context.getTargetPage(session, { query: {}, headers: {} });
  const aliased = (id) => session.page === tabs[id].page || session.activeTabId === id || session.cdpSession?.id === id || routed()?.page === tabs[id].page;
  return { context, session, tabs, events, retire, routed, aliased };
}

test('route: no alias and no fallback reaches a retired page, in the same tick and after two retirements in one turn (round 2, finding 3)', { timeout: 20_000 }, async () => {
  // Both tabs of a session retired in one turn, with nothing hung.
  const two = routing(['old', 'next']);
  two.retire('old');
  assert.equal(two.aliased('old'), false, 'out of every alias before anything is awaited');
  two.retire('next');
  assert.deepEqual([two.aliased('old'), two.aliased('next')], [false, false]);
  await delay(30); // the switch that was under way has resumed by now
  assert.equal(two.session.tabs.size, 0);
  assert.deepEqual([two.aliased('old'), two.aliased('next')], [false, false], 'the switch to a tab retired meanwhile did not bring it back');
  assert.deepEqual([two.session.page, two.session.activeTabId, two.session.cdpSession], [null, null, null]);
  assert.equal(two.routed()?.page ?? null, null, 'the zero-tab fallback of getTargetPage hands out no page');

  // The stop of the screencast never answers.
  const hung = routing(['old', 'next'], { stopScreencast: never });
  hung.session.screencastActive = true;
  hung.retire('old');
  assert.equal(hung.aliased('old'), false);
  await delay(30);
  assert.equal(hung.aliased('old'), false, 'not while the screencast stop hangs either');
  assert.equal(hung.routed()?.page, hung.tabs.next.page, 'and the tab that is left is the one a call reaches');

  // Three tabs, two of them retired in one turn: the session ends on the third.
  const three = routing(['a', 'b', 'c']);
  three.retire('a');
  three.retire('b');
  await delay(30);
  assert.deepEqual([three.aliased('a'), three.aliased('b')], [false, false]);
  assert.deepEqual([three.session.activeTabId, three.session.page], ['c', three.tabs.c.page]);
});

test('route: a tab switch never aliases a tab that left the session while the switch was awaited (round 2, finding 3)', { timeout: 20_000 }, async () => {
  const { context, session, tabs, aliased } = routing(['a', 'b'], { stopScreencast: () => delay(30) });
  const switching = context._switchSessionTab(session, 'session', 'b').then(() => 'switched', (error) => error.message);
  await delay(5);
  session.tabs.delete('b'); // closed or retired meanwhile
  assert.equal(await switching, 'Tab b not found');
  assert.equal(aliased('b'), false);
  assert.equal(session.page, tabs.a.page, 'the session stays where it was');
});

test('route: the retired tab is closed whatever the notifications do, and "closed" is announced only when it is (round 2, finding 4)', { timeout: 30_000 }, async () => {
  const unrestorable = () => {
    const tab = fakeTab();
    clipsStall(tab);
    tab.refuse = (method) => (method === 'Emulation.setVisibleSize' ? new Error('not allowed') : null);
    return tab;
  };
  // A client whose socket throws on send.
  const tab = unrestorable();
  const broken = routeHarness(tab, { clients: [{ readyState: 1, send() { throw new Error('WebSocket write failed'); }, close() {} }] });
  const answer = await broken.get({}, { deadlineMs: 1500 });
  assert.equal(answer.body.tabRetired, true);
  assert.equal(broken.session.tabs.size, 0);
  assert.equal(tab.closeCalls, 1, 'the close was attempted');
  assert.equal(answer.body.tabClosed, true);
  assert.deepEqual(broken.events.map(([type]) => type).filter((type) => type.startsWith('browser:')), ['browser:tab-retired', 'browser:tab-closed']);

  // A close that is refused: the tab left routing, and nothing says it closed.
  const refusing = unrestorable();
  refusing.closing = () => Promise.reject(new Error('CDP close refused'));
  const refused = routeHarness(refusing);
  const kept = await refused.get({}, { deadlineMs: 1500 });
  assert.deepEqual([kept.body.tabRetired, kept.body.tabClosed, refusing.closed], [true, false, false]);
  await delay(50);
  assert.deepEqual(refused.events.map(([type]) => type).filter((type) => type.startsWith('browser:')), ['browser:tab-retired'], 'no browser:tab-closed for a tab that is still open');
});

test('route: a log sink that throws or is slow costs the log line, never the answer (round 2, finding 5)', { timeout: 30_000 }, async () => {
  // It throws: a healthy capture is still answered with its image.
  const throwing = routeHarness(fakeTab(), { loopLog: () => { throw new Error('log sink failed'); } });
  const shot = await throwing.get({});
  assert.equal(shot.status, 200, JSON.stringify({ ...shot.body, data: undefined }));
  assert.ok(typeof shot.body.data === 'string' && shot.body.mime === 'image/jpeg');
  await delay(10);
  assert.deepEqual(throwing.errors, [], 'and the sink\'s error goes nowhere: not out of the handler, where it would be an unhandled rejection');
  // And a failed one with its phase.
  const stalledTab = fakeTab();
  stalledTab.stall = (method) => method === 'Page.captureScreenshot';
  const stalledRoute = routeHarness(stalledTab, { loopLog: () => { throw new Error('log sink failed'); } });
  const failed = await stalledRoute.get({}, { deadlineMs: 1500 });
  assert.deepEqual([failed.status, failed.body.code, failed.body.phase], [503, 'SCREENSHOT_NOT_PRESENTING', 'present'], JSON.stringify(failed.body));
  await delay(10);
  assert.deepEqual(stalledRoute.errors, []);

  // It blocks for 900 ms: the answer of a capture that timed out has left before.
  const slowTab = fakeTab();
  clipsStall(slowTab);
  let logged = 0;
  const slow = routeHarness(slowTab, { loopLog: () => { logged += 1; const until = Date.now() + 900; while (Date.now() < until) { /* a console or a disk that does not return */ } } });
  const answer = await slow.get({}, { deadlineMs: 1000 });
  assert.ok(answer.took < 1000, `answered at ${answer.took} ms against a deadline of 1000`);
  assert.equal(answer.body.phase, 'calibrate', JSON.stringify(answer.body));
  assert.equal(logged, 1, 'the line was still written, after the answer');
});

test('route: the error and the log line carry the window state read at the failure, and the earlier one when they differ (round 2, finding 6)', { timeout: 20_000 }, async () => {
  const tab = fakeTab();
  tab.stall = (method) => method === 'Page.captureScreenshot';
  const { get, logs } = routeHarness(tab);
  const pending = get({}, { deadlineMs: 2000 });
  await delay(40);
  tab.windowState = 'minimized'; // minimized while the first frame is waited for
  const answer = await pending;
  assert.deepEqual([answer.body.phase, answer.body.windowState, answer.body.windowAtStart], ['present', 'minimized', 'normal'], JSON.stringify(answer.body));
  assert.match(answer.body.error, /window state from CDP: minimized when it stopped, normal when it began/);
  assert.match(logs[0].message, /window=minimized selected=likely outcome=failed phase=present/);
  assert.equal(logs[0].meta.windowAtStart, 'normal');
});

// ── final review: closing a tab while the tab it would move to is closing too ──

/**
 * The real tab helpers of server.js (screencast start and stop, _switchSessionTab,
 * closeSessionTab, releaseSharedBrowserTab, getTargetPage) and the real
 * DELETE …/tabs/:tabId route over a healthy session of fake tabs, the first one
 * active. `streaming`: a screencast runs, and its stop is answered only by
 * `answerStop()` (a normal answer). `startFails`: the screencast cannot start on
 * any other tab.
 */
function closing(ids, { streaming = false, startFails = false } = {}) {
  let answerStop = null;
  const commands = [];
  const destroyed = [];
  const tabs = Object.fromEntries(ids.map((id) => [id, fakeTab()]));
  const cdp = Object.fromEntries(ids.map((id) => [id, {
    send(method) {
      commands.push(`${id}:${method}`);
      if (streaming && method === 'Page.stopScreencast') return new Promise((done) => { answerStop = () => done({}); });
      if (startFails && method === 'Page.startScreencast') return Promise.reject(new Error('screencast refused'));
      return Promise.resolve({});
    },
    on() {}, off() {},
  }]));
  const session = {
    tabs: new Map(ids.map((id) => [id, { page: tabs[id].page, cdpSession: cdp[id], url: `https://${id}.test/`, title: id }])),
    activeTabId: ids[0], page: tabs[ids[0]].page, cdpSession: cdp[ids[0]], currentUrl: `https://${ids[0]}.test/`, title: ids[0],
    clients: new Set(), screencastActive: streaming,
    _tabOwners: new Map(ids.map((id) => [`owner-${id}`, id])), _loopOwned: new Set(), _interactiveOwned: new Set(),
  };
  const routes = {};
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, JSON, Buffer, setTimeout, clearTimeout,
    clearAiSnapshotCache() {}, broadcastSync() {}, trackRoute() {}, sessionOwnerCount: () => 0,
    loadBrowserConfig: () => ({ screencast: { disabled: !startFails } }),
    destroyBrowserSession: async (id) => { destroyed.push(id); },
    browserSessions: new Map([['session', session]]),
    app: { delete(path, fn) { routes[`DELETE ${path}`] = fn; }, post(path, fn) { routes[`POST ${path}`] = fn; } },
  });
  vm.runInContext(between('function detachScreencastFrameHandler(', '// ── Multi-tab helpers')
    + between('async function releaseSharedBrowserTab(', '// ── Real-time sync WebSocket')
    + between('async function _switchSessionTab(', '/**\n * Clean up a browser session.')
    + between('function getTargetPage(', '/** Update session-level')
    + between("app.post('/api/browser/sessions/:id/tabs/:tabId/activate'", '// ── Human-like pacing'), context);
  const call = async (route, id) => {
    const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await routes[route]({ params: { id: 'session', tabId: id } }, res);
    return { status: res.code, body: res.body };
  };
  /** DELETE …/tabs/:id through the real route: its status and body. */
  const close = (id) => call('DELETE /api/browser/sessions/:id/tabs/:tabId', id);
  /** POST …/tabs/:id/activate through the real route. */
  const activate = (id) => call('POST /api/browser/sessions/:id/tabs/:tabId/activate', id);
  return {
    session, tabs, cdp, commands, destroyed, close, activate,
    release: (id) => context.releaseSharedBrowserTab('session', `owner-${id}`),
    answerStop: () => { assert.equal(typeof answerStop, 'function', 'the screencast stop was asked for'); answerStop(); },
    closeCalls: () => ids.map((id) => tabs[id].closeCalls),
    /** Where the session stands: its registered tabs, its active tab, and whether every alias names that tab and a call without a tab id reaches it. */
    stands: () => {
      const active = session.activeTabId;
      const page = active ? tabs[active]?.page : null;
      const routed = context.getTargetPage(session, { query: {}, headers: {} });
      return { registered: [...session.tabs.keys()], active, aliases: session.page === page && session.cdpSession === (active ? cdp[active] : null), routed: ids.find((id) => routed?.page === tabs[id].page) ?? null };
    },
  };
}

test('tabs: two tabs closed in one turn both answer 200 and are closed, and the session ends on the tab that is left (final review)', { timeout: 20_000 }, async () => {
  // Sequential closes, for comparison.
  const one = closing(['a', 'b', 'c']);
  assert.deepEqual([(await one.close('a')).status, (await one.close('b')).status], [200, 200]);
  assert.deepEqual([one.closeCalls(), one.stands()], [[1, 1, 0], { registered: ['c'], active: 'c', aliases: true, routed: 'c' }]);

  // The same two closes in one turn, no screencast (as on a MoreLogin session): a's close picks b, and b is closed before that switch resumes.
  const h = closing(['a', 'b', 'c']);
  const [first, second] = await Promise.all([h.close('a'), h.close('b')]);
  assert.deepEqual([first.status, second.status], [200, 200], JSON.stringify(first.body));
  assert.deepEqual(h.closeCalls(), [1, 1, 0], 'both pages got their close, the third none');
  assert.deepEqual(h.stands(), { registered: ['c'], active: 'c', aliases: true, routed: 'c' }, 'on the tab that is left, with no alias on a closed one');

  // A screencast whose stop is answered normally, a moment later: b is closed while a's close waits for that answer.
  const streaming = closing(['a', 'b', 'c'], { streaming: true });
  const pending = streaming.close('a');
  await delay(5);
  assert.deepEqual(streaming.commands, ['a:Page.stopScreencast']);
  assert.equal((await streaming.close('b')).status, 200);
  streaming.answerStop();
  const answered = await pending;
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.deepEqual(streaming.closeCalls(), [1, 1, 0]);
  assert.deepEqual(streaming.stands(), { registered: ['c'], active: 'c', aliases: true, routed: 'c' });

  // Four tabs, three of them closed in one turn.
  const four = closing(['a', 'b', 'c', 'd']);
  assert.deepEqual((await Promise.all([four.close('a'), four.close('b'), four.close('c')])).map((answer) => answer.status), [200, 200, 200]);
  assert.deepEqual([four.closeCalls(), four.stands()], [[1, 1, 1, 0], { registered: ['d'], active: 'd', aliases: true, routed: 'd' }]);
});

test('tabs: both tabs of a session closed in one turn: both answer 200, the first is closed and no alias stays on it (final review)', { timeout: 20_000 }, async () => {
  const h = closing(['a', 'b']);
  const [first, second] = await Promise.all([h.close('a'), h.close('b')]);
  assert.deepEqual([first.status, second.status], [200, 200], JSON.stringify(first.body));
  assert.equal(h.tabs.a.closeCalls, 1, 'a got its close');
  assert.deepEqual(h.destroyed, ['session'], 'the last tab took the session with it, as before');
  assert.deepEqual([h.session.activeTabId, h.session.page, h.session.cdpSession], [null, null, null], 'on no tab: none is left');
});

test('tabs: two owners released in one turn both get their tab closed (final review)', { timeout: 20_000 }, async () => {
  // releaseSharedBrowserTab swallows what closeSessionTab throws: a close that is skipped would leave the tab open without a word.
  const h = closing(['a', 'b', 'c']);
  await Promise.all([h.release('a'), h.release('b')]);
  assert.deepEqual(h.closeCalls(), [1, 1, 0]);
  assert.deepEqual(h.stands(), { registered: ['c'], active: 'c', aliases: true, routed: 'c' });
  assert.deepEqual([...h.session._tabOwners.keys()], ['owner-c']);
});

test('tabs: the tab is closed even when the switch away from it fails, and the failure is still reported (final review)', { timeout: 20_000 }, async () => {
  const h = closing(['a', 'b'], { startFails: true });
  const answer = await h.close('a');
  assert.deepEqual([answer.status, answer.body.error], [500, 'screencast refused'], 'reported as before');
  assert.equal(h.tabs.a.closeCalls, 1, 'and the tab it left the registry for is closed all the same');
  assert.deepEqual(h.stands(), { registered: ['b'], active: 'b', aliases: true, routed: 'b' });
});

test('tabs: activating a tab that is closed while the switch waits says so, and the session stays on a registered tab (final review)', { timeout: 20_000 }, async () => {
  // Not a failure of a healthy call: the tab asked for is gone. Before the switch re-validated its target,
  // this answered 200 with the closed tab as the active one.
  const h = closing(['a', 'b', 'c'], { streaming: true });
  const pending = h.activate('b');
  await delay(5);
  assert.equal((await h.close('b')).status, 200);
  h.answerStop();
  const answer = await pending;
  assert.deepEqual([answer.status, answer.body.error], [500, 'Tab b not found'], 'the same answer as for a tab that was already gone when it was asked for');
  assert.deepEqual([h.closeCalls(), h.stands()], [[0, 1, 0], { registered: ['a', 'c'], active: 'a', aliases: true, routed: null }]);
  assert.equal((await h.activate('zz')).body.error, 'Tab zz not found');
});

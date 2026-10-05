import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  createEngagementScheduler, engagementTargetSelector, browserRequestMiddleware,
  markBrowserActionStarted, assertBrowserRequestActive, cancellableBrowserDelay,
  browserActionTimeout, measureBrowserPhase, isXShortcutPublish, isXScriptedWrite,
} from '../lib/browser-execution.js';
import { describeLocatorMatches, healLocatorByText, validNthMatch } from '../lib/browser-targets.js';

function requestContext(headers = {}) {
  const req = Object.assign(new EventEmitter(), { get: name => headers[name], path: '/sessions/private-id/click' });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, headers: {}, headersSent: false, writableFinished: false,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.headersSent = true; this.body = body; this.writableFinished = true; this.emit('finish'); return this; },
    json(body) { return this.send(JSON.stringify(body)); },
  });
  return { req, res };
}

test('missing routing is explicitly safe to recover, but an executed failure is uncertain', () => {
  for (const started of [false, true]) {
    const { req, res } = requestContext();
    browserRequestMiddleware(req, res, () => {
      if (started) markBrowserActionStarted(req);
      res.status(404).json({ error: 'Session not found' });
    });
    const body = JSON.parse(res.body);
    assert.equal(body.actionStarted, started);
    assert.equal(body.code, started ? undefined : 'SESSION_NOT_FOUND');
    assert.equal(body.outcome, started ? 'uncertain' : undefined);
  }
});

test('expired request never enters route and late results cannot send twice', () => {
  const { req, res } = requestContext({ 'X-Synabun-Deadline': String(Date.now() - 1) });
  let entered = false;
  browserRequestMiddleware(req, res, () => { entered = true; });
  assert.equal(entered, false);
  assert.equal(res.statusCode, 408);
  const first = res.body;
  res.json({ ok: true });
  assert.equal(res.body, first);
});

test('disconnect cancels a pending pacing delay before it can start a click', async () => {
  const { req, res } = requestContext();
  let wait;
  browserRequestMiddleware(req, res, () => { wait = cancellableBrowserDelay(10_000, req); });
  res.emit('close');
  await assert.rejects(wait, /cancelled before execution/);
  assert.throws(() => markBrowserActionStarted(req), /cancelled/);
  assert.equal(req.browserRequest.actionStarted, false);
});

test('operation timeout shares caller deadline and correlated phases contain only timings', async () => {
  const { req, res } = requestContext({ 'X-Synabun-Deadline': String(Date.now() + 1000), 'X-Synabun-Request-Id': 'correlation-123' });
  let work;
  browserRequestMiddleware(req, res, () => {
    work = measureBrowserPhase('action', async () => 'private page text');
  });
  await work;
  assert(browserActionTimeout(req, 5000) <= 1000);
  assert.equal(res.headers['X-Synabun-Request-Id'], 'correlation-123');
  assert.equal(req.browserRequest.counts.action, 1);
  assert.equal(JSON.stringify(req.browserRequest.phases).includes('private'), false);
  res.json({ ok: true });
});

test('concurrent social writes serialize and retain a full gap between actual attempts', async () => {
  let now = 100;
  const waits = [], executed = [];
  const scheduler = createEngagementScheduler({ now: () => now, random: () => 0, delay: async ms => { waits.push(ms); now += ms; } });
  await Promise.all([1, 2, 3].map(id => scheduler.run('session', {}, async () => { executed.push([id, now]); })));
  assert.deepEqual(executed, [[1, 100], [2, 30100], [3, 60100]]);
  assert.deepEqual(waits, [30000, 30000]);
});

test('cancelled queued write does not execute or consume a spacing slot', async () => {
  const controller = new AbortController();
  const req = { browserRequest: { signal: controller.signal, deadline: Date.now() + 10000 } };
  let release, started, now = 1;
  const hasStarted = new Promise(resolve => { started = resolve; });
  const executed = [], waits = [];
  const scheduler = createEngagementScheduler({ now: () => now, random: () => 0, delay: async ms => { waits.push(ms); now += ms; } });
  const first = scheduler.run('s', {}, () => new Promise(resolve => { release = resolve; started(); }));
  await hasStarted;
  const second = scheduler.run('s', req, async () => { executed.push(2); });
  controller.abort();
  release();
  await first;
  await assert.rejects(second, /cancelled/);
  await scheduler.run('s', {}, async () => { executed.push(3); });
  assert.deepEqual(executed, [3]);
  assert.deepEqual(waits, [30000]);
});

test('refs yield the same semantic publish and engagement markers as selectors', async () => {
  for (const testid of ['tweetButton', 'tweetButtonInline', 'like', 'unlike', 'retweet', 'unretweet', '123-follow']) {
    const el = { closest() { return this; }, getAttribute: key => key === 'data-testid' ? testid : null };
    const selector = await engagementTargetSelector({ evaluate: fn => fn(el) });
    assert.equal(selector, `[data-testid="${testid}"]`);
  }
  const parent = { getAttribute: name => name === 'data-testid' ? 'like' : null };
  const child = { parentElement: parent, getAttribute: name => name === 'data-testid' ? 'app-text-transition-container' : null };
  assert.equal(await engagementTargetSelector({ evaluate: fn => fn(child) }), '[data-testid="like"]');
});

test('spacing includes preparation time and wedged writes release the queue on cancellation', async () => {
  let now = 1;
  const attempts = [];
  const scheduler = createEngagementScheduler({ now: () => now, random: () => 0, delay: async ms => { now += ms; } });
  await scheduler.run('s', {}, async () => { now += 1100; attempts.push(now); });
  await scheduler.run('s', {}, async () => { now += 250; attempts.push(now); });
  assert(attempts[1] - attempts[0] >= 30000);
  const controller = new AbortController();
  const req = { browserRequest: { signal: controller.signal, deadline: Date.now() + 10000 } };
  const stuck = scheduler.run('stuck', req, async () => { controller.abort(); return new Promise(() => {}); });
  await assert.rejects(stuck, /deadline/);
  let ran = false;
  await scheduler.run('stuck', {}, async () => { ran = true; });
  assert.equal(ran, true);
});

test('candidate descriptions preserve the original role locator and exact nth indices', async () => {
  const selector = 'role=button[name="Continue"]';
  const rows = [{ nth: 0, visible: false }, { nth: 1, visible: true }];
  const page = { locator(input) { assert.equal(input, selector); return { evaluateAll: async () => rows }; } };
  assert.deepEqual(await describeLocatorMatches(page, selector), rows.map(row => ({ ...row, selector })));
  assert.equal(validNthMatch(1, 4), false);
  assert.equal(validNthMatch(1, -1), false);
  assert.equal(validNthMatch(2, 1), true);
});

test('text recovery refuses ambiguous visible targets, unknown roles, and uncertain CSS scope', async () => {
  const item = { isVisible: async () => true };
  const page = { getByRole: () => ({ count: async () => 2, nth: () => item }) };
  assert.equal(await healLocatorByText(page, 'role=button[name="old"]', 'Save'), null);
  assert.equal(await healLocatorByText(page, '[data-testid="unknown"]', 'Save'), null);
  assert.equal(await healLocatorByText(page, 'form button.old', 'Save'), null);
});

test('a blocked preflight does not consume social write spacing', async () => {
  let now = 1;
  const waits = [];
  const scheduler = createEngagementScheduler({ now: () => now, random: () => 0, delay: async ms => { waits.push(ms); now += ms; } });
  const controller = new AbortController();
  const req = { browserRequest: { signal: controller.signal, deadline: Date.now()+1000, actionStarted:false } };
  await scheduler.run('s',req,async()=>({error:'Blocked composer'}));
  await scheduler.run('s',{},async()=>{});
  assert.deepEqual(waits,[]);
});

test('paragraph typing stops before any subsequent keystrokes after cancellation', async () => {
  const source = readFileSync(new URL('../server.js',import.meta.url),'utf8');
  const start = source.indexOf('async function typeParagraphs(');
  const code = source.slice(start,source.indexOf('// Compute visible interactive elements',start));
  const context = vm.createContext({assertBrowserRequestActive});
  vm.runInContext(code,context);
  const controller = new AbortController();
  const req = {browserRequest:{signal:controller.signal,deadline:Date.now()+1000,actionStarted:true}};
  const calls=[];
  await assert.rejects(context.typeParagraphs({keyboard:{press:async key=>calls.push(key)}},async text=>{
    calls.push(text);controller.abort();
  },'First paragraph\n\nSecond paragraph',req),/outcome is uncertain/);
  assert.deepEqual(calls,['First paragraph']);
});

test('keyboard-shortcut publishing is recognised on X hosts only', () => {
  for (const key of ['Meta+Enter', 'Control+Enter', 'ControlOrMeta+Enter', 'Meta+Shift+Enter', ' meta+enter ']) {
    assert.equal(isXShortcutPublish(key, 'https://x.com/compose/post'), true, key);
  }
  assert.equal(isXShortcutPublish('Meta+Enter', 'https://mobile.twitter.com/home'), true);
  assert.equal(isXShortcutPublish('Enter', 'https://x.com/compose/post'), false, 'plain Enter is a newline');
  assert.equal(isXShortcutPublish('Meta+a', 'https://x.com/home'), false);
  assert.equal(isXShortcutPublish('Meta+Enter', 'https://bsky.app/'), false);
  assert.equal(isXShortcutPublish('Meta+Enter', 'https://notx.com/'), false);
  assert.equal(isXShortcutPublish('Meta+Enter', 'not a url'), false);
});

test('scripted clicks on X write controls are recognised; reads and other sites are not', () => {
  const url = 'https://x.com/SynabunAI/status/1';
  assert.equal(isXScriptedWrite('document.querySelector(\'[data-testid="tweetButton"]\').click()', url), true);
  assert.equal(isXScriptedWrite('document.querySelector("[data-testid=like]").click()', url), true);
  assert.equal(isXScriptedWrite('el.closest("[data-testid$=-follow]") && btn.dispatchEvent(new MouseEvent("click"))', url), true);
  assert.equal(isXScriptedWrite('document.querySelector("[data-testid=confirmationSheetConfirm]").click()', url), true);
  assert.equal(isXScriptedWrite('!!document.querySelector(\'[data-testid="tweetButton"]\')', url), false, 'a read is allowed');
  assert.equal(isXScriptedWrite('document.querySelector("[data-testid=tweetTextarea_0]").focus()', url), false);
  assert.equal(isXScriptedWrite('document.querySelector(\'[data-testid="tweetButton"]\').click()', 'https://example.com/'), false);
});

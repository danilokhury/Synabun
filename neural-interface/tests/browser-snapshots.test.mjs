import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createAiSnapshotStore, diffSnapshotText, settleBrowserPage, truncateSnapshotLines } from '../lib/browser-snapshots.js';

class FakePage extends EventEmitter {
  href = 'http://localhost/article';
  content = '- button "Save" [ref=e1]';
  url() { return this.href; }
  mainFrame() { return this; }
}

function harness(options = {}) {
  const page = new FakePage();
  const captures = [];
  const store = createAiSnapshotStore({
    enabled: () => true,
    capture: async (_page, opts) => { captures.push(opts); return page.content; },
    ...options,
  });
  const request = async (opts = {}, deliver = true) => {
    let finish;
    const result = await store.build(page, { aiCacheKey: 'session:tab:alice', ...opts, onDelivered: commit => { finish = commit; } });
    if (deliver) finish?.();
    return { result, finish };
  };
  return { page, captures, store, request };
}

test('truncation keeps complete lines and never cuts element refs', () => {
  const value = '- heading "Title"\n- button "Save" [ref=e123]';
  assert.deepEqual(truncateSnapshotLines(value, value.length - 2), { text: '- heading "Title"', truncated: true });
  assert.deepEqual(truncateSnapshotLines(value, 3), { text: '', truncated: true });
  assert.deepEqual(truncateSnapshotLines(value, value.length), { text: value, truncated: false });
});

test('localized deletion is explicit and force overrides diff/unchanged', async () => {
  const h = harness();
  const lines = Array.from({ length: 20 }, (_, i) => `- button "Item ${i}" [ref=e${i}]`);
  h.page.content = lines.join('\n');
  await h.request();
  lines.splice(5, 1);
  h.page.content = lines.join('\n');
  const { result } = await h.request({ diff: true });
  assert.equal(result.snapshotIsDiff, true);
  assert.equal(result.diffRemovedLines, 1);
  assert.equal(result.diffAddedLines, 0);
  assert.match(result.snapshotText, /^- - button "Item 5"/);
  const forced = (await h.request({ diff: true, force: true })).result;
  assert.equal(forced.unchanged, undefined);
  assert.equal(forced.snapshotIsDiff, undefined);
  assert.equal(forced.snapshotText, h.page.content);
});

test('scope, caller, budget, depth and viewport are distinct baseline contexts', async () => {
  const h = harness();
  await h.request();
  for (const opts of [{ scopeSel: 'main' }, { aiCacheKey: 'session:tab:bob' }, { maxChars: 12000 }, { depth: 5 }, { viewport: true }]) {
    const { result } = await h.request({ diff: true, ...opts });
    assert.equal(result.unchanged, undefined);
    assert.equal(result.snapshotIsDiff, undefined);
    assert.equal(result.snapshotText, h.page.content);
  }
  assert.equal((await h.request()).result.unchanged, true);
});

test('same-URL navigation and page replacement invalidate baselines', async () => {
  const h = harness();
  await h.request();
  h.page.emit('framenavigated', h.page.mainFrame());
  assert.equal((await h.request({ diff: true })).result.unchanged, undefined);
  const replacement = new FakePage();
  const result = await h.store.build(replacement, { aiCacheKey: 'session:tab:alice', diff: true });
  assert.equal(result.unchanged, undefined);
});

test('an undelivered response is never used as a baseline', async () => {
  const h = harness();
  const undelivered = await h.request({}, false);
  const next = await h.request({ diff: true, baselineId: undelivered.result.snapshotId });
  assert.equal(next.result.unchanged, undefined);
  assert.equal(next.result.snapshotIsDiff, undefined);
  assert.equal((await h.request({ baselineId: next.result.snapshotId })).result.unchanged, true);
  assert.equal((await h.request({ diff: true, baselineId: 'unknown' })).result.unchanged, undefined);
});

test('late delivery cannot overwrite a more recent delivered observation', async () => {
  const h = harness();
  const older = await h.request({}, false);
  h.page.content = '- button "Updated" [ref=e2]';
  const newer = await h.request();
  older.finish();
  const { result } = await h.request({ baselineId: newer.result.snapshotId });
  assert.equal(result.unchanged, true);
});

test('V2 captures at most twice and reuses successful shallower depth', async () => {
  const h = harness();
  h.page.content = Array.from({ length: 100 }, (_, i) => `- button "Item ${i}" [ref=e${i}]`).join('\n');
  const first = (await h.request({ maxChars: 200 })).result;
  assert.deepEqual(h.captures.map(c => c.depth), [12, 9]);
  assert.equal(first.snapshotCaptureCount, 2);
  assert.equal(first.snapshotTruncated, true);
  assert.ok(first.snapshotText.length <= 200);
  h.captures.length = 0;
  const second = (await h.request({ maxChars: 200 })).result;
  assert.deepEqual(h.captures.map(c => c.depth), [9]);
  assert.equal(second.unchanged, true);
});

test('explicit depth is honored with one capture and legacy capture strategy is retained', async () => {
  const h = harness({ enabled: () => false });
  h.page.content = 'x'.repeat(500);
  await h.request({ maxChars: 10, depth: 20 });
  assert.deepEqual(h.captures.map(c => c.depth), [20]);
  h.captures.length = 0;
  await h.request({ maxChars: 10 });
  assert.deepEqual(h.captures.map(c => c.depth), [undefined, 16, 12, 9]);
});

test('hidden truncated text is never treated as delivered diff context', async () => {
  const h = harness();
  const prefix = '- button "Visible" [ref=e1]';
  h.page.content = `${prefix}\n- button "Hidden" [ref=e2]`;
  await h.request({ maxChars: prefix.length + 1 });
  h.page.content = `${prefix}\n- button "Different hidden content" [ref=e3]`;
  const { result } = await h.request({ maxChars: prefix.length + 1, diff: true });
  assert.equal(result.unchanged, true);
  assert.equal(result.snapshotTruncated, true);
  assert.equal(result.snapshotText, null);
});

test('capture errors and navigation during capture do not create baselines', async () => {
  const h = harness({ capture: async page => { page.emit('framenavigated', page); return page.content; } });
  const result = (await h.request()).result;
  assert.match(result.snapshotError, /navigated during capture/);
  assert.equal(result.snapshotId, undefined);
});

test('captures of the same page do not interleave', async () => {
  let active = 0;
  let peak = 0;
  const h = harness({ capture: async page => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return page.content;
  } });
  await Promise.all([h.request(), h.request({ aiCacheKey: 'session:tab:bob' })]);
  assert.equal(peak, 1);
});

test('clearing a tab leaves other tab baselines intact', async () => {
  const h = harness();
  await h.request();
  await h.request({ aiCacheKey: 'session:other:alice' });
  h.store.clear('session', 'tab');
  assert.equal((await h.request()).result.unchanged, undefined);
  assert.equal((await h.request({ aiCacheKey: 'session:other:alice' })).result.unchanged, true);
});

test('readiness is bounded even when the page evaluation never returns', async () => {
  const started = Date.now();
  await settleBrowserPage({
    waitForLoadState: async () => {},
    evaluate: () => new Promise(() => {}),
  }, { cap: 25, v2: true });
  assert.ok(Date.now() - started < 500);
});

test('empty snapshots can be compared without phantom lines', () => {
  assert.deepEqual(diffSnapshotText('', ''), { unchanged: true });
  assert.deepEqual(diffSnapshotText('- button "Gone" [ref=e1]', ''), { full: '' });
});

test('expired queued snapshots never capture or replace the ref map', async () => {
  let release;
  let started;
  let captures = 0;
  let cancelled = false;
  const capturing = new Promise(resolve => { started = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const h = harness({ capture: async page => { captures++; started(); await hold; return page.content; } });
  const first = h.request();
  await capturing;
  const queued = h.request({ assertActive: () => { if (cancelled) throw new Error('Request cancelled'); } });
  cancelled = true;
  release();
  await first;
  const { result } = await queued;
  assert.match(result.snapshotError, /cancelled/);
  assert.equal(captures, 1);
  assert.equal(result.snapshotId, undefined);
});

test('cancellation after capture prevents adaptive retries and baseline delivery', async () => {
  let cancelled = false;
  let captures = 0;
  const h = harness({ capture: async page => { captures++; cancelled = true; return 'x'.repeat(500); } });
  const { result } = await h.request({ maxChars: 10, assertActive: () => { if (cancelled) throw new Error('Request cancelled'); } });
  assert.match(result.snapshotError, /cancelled/);
  assert.equal(captures, 1);
  assert.equal(result.snapshotId, undefined);
});

test('a response cancelled before finish cannot commit its observation', async () => {
  const h = harness();
  let cancelled = false;
  const pending = await h.request({ assertActive: () => { if (cancelled) throw new Error('Request cancelled'); } }, false);
  cancelled = true;
  assert.doesNotThrow(() => pending.finish());
  const next = (await h.request({ baselineId: pending.result.snapshotId })).result;
  assert.equal(next.unchanged, undefined);
  assert.equal(next.snapshotIsDiff, undefined);
});

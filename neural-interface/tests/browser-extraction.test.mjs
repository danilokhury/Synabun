import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { budgetExtractionItems, runBrowserExtraction } from '../lib/browser-extraction.js';

function fixturePage(rounds) {
  let round = 0;
  let reads = 0;
  let scrollCalls = 0;
  const read = () => {
    const value = rounds[Math.min(round, rounds.length - 1)];
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    get scrollCalls() { return scrollCalls; },
    get reads() { return reads; },
    async evaluate(script) {
      if (typeof script === 'string') { reads++; return read(); }
      scrollCalls++; round++;
      return false;
    },
    async waitForFunction() {
      reads++;
      const items = read();
      return { jsonValue: async () => ({ items }), dispose: async () => {} };
    },
  };
}

test('collects virtualized pages by identity before selecting output fields', async () => {
  const page = fixturePage([
    [{ id: 0, text: 'same' }, { id: 1, text: 'same' }],
    [{ id: 1, text: 'same' }, { id: 2, text: 'same' }],
    [{ id: 3, text: 'same' }],
  ]);
  const result = await runBrowserExtraction(page, 'items', { scrolls: 5, minItems: 4, dedupeKeys: ['id'], fields: ['text'] });
  assert.equal(result.items.length, 4);
  assert.deepEqual(result.items, Array.from({ length: 4 }, () => ({ text: 'same' })));
  assert.equal(result.raw, 5);
  assert.equal(result.scrollsUsed, 2);
  assert.equal(result.stopReason, 'min_items');
  assert.equal(result.partial, false);
});

test('later extraction failure returns explicit partial results without retrying', async () => {
  const page = fixturePage([[{ id: 1 }], new Error('Execution context was destroyed')]);
  const result = await runBrowserExtraction(page, 'items', { scrolls: 3, dedupeKeys: ['id'] });
  assert.deepEqual(result.items, [{ id: 1 }]);
  assert.equal(result.partial, true);
  assert.match(result.failureReason, /Execution context/);
  assert.equal(result.stopReason, 'extraction_error');
  assert.equal(page.scrollCalls, 1);
  assert.equal(result.error, undefined);
});

test('first failure is an error instead of a successful empty collection', async () => {
  const result = await runBrowserExtraction(fixturePage([new Error('closed')]), 'items');
  assert.equal(result.error, 'closed');
  assert.equal(result.partial, false);
});

test('maxChars preserves whole JSON items and maxItems still limits projection', async () => {
  const items = [{ id: 1, text: 'long content' }, { id: 2, text: 'long content' }];
  const budget = budgetExtractionItems(items, { fields: ['id'], maxChars: 10 });
  assert.deepEqual(budget.items, [{ id: 1 }]);
  assert.equal(budget.budgetReason, 'max_chars');
  assert.ok(JSON.stringify(budget.items).length <= 10);
  assert.deepEqual(budgetExtractionItems(items, { maxItems: 1 }).items, [items[0]]);
  const page = fixturePage([items]);
  const result = await runBrowserExtraction(page, 'items', { scrolls: 5, fields: ['id'], maxChars: 10 });
  assert.equal(result.stopReason, 'max_chars');
  assert.equal(result.truncated, true);
  assert.equal(page.scrollCalls, 0);
});

test('an initially empty virtualized feed gets its one configured bonus scroll', async () => {
  const page = fixturePage([[], [{ id: 1 }]]);
  const result = await runBrowserExtraction(page, 'items', { scrolls: 0, scrollIfEmpty: true });
  assert.deepEqual(result.items, [{ id: 1 }]);
  assert.equal(result.scrollsUsed, 1);
});

test('a bounded extraction stops a wedged renderer without issuing another scroll', async () => {
  const page = fixturePage([[{ id: 1 }]]);
  page.waitForFunction = () => new Promise(() => {});
  const result = await runBrowserExtraction(page, 'items', { scrolls: 5, timeoutMs: 15 });
  assert.deepEqual(result.items, [{ id: 1 }]);
  assert.equal(result.partial, true);
  assert.equal(result.stopReason, 'deadline');
  assert.equal(page.scrollCalls, 1);
});

test('request cancellation preserves collected items and prevents future scrolls', async () => {
  const controller = new AbortController();
  const page = fixturePage([[{ id: 1 }]]);
  page.waitForFunction = async () => { controller.abort(); return new Promise(() => {}); };
  const result = await runBrowserExtraction(page, 'items', { scrolls: 5 }, { signal: controller.signal });
  assert.equal(result.stopReason, 'cancelled');
  assert.equal(result.partial, true);
  assert.equal(page.scrollCalls, 1);
  const cancelled = await runBrowserExtraction(page, 'items', {}, { signal: controller.signal });
  assert.equal(cancelled.stopReason, 'cancelled');
  assert.equal(page.scrollCalls, 1);
});

test('two dry rounds identify end of feed without exhausting requested scrolls', async () => {
  const page = fixturePage([[{ id: 1 }]]);
  const result = await runBrowserExtraction(page, 'items', { scrolls: 10 });
  assert.equal(result.stopReason, 'end_of_feed');
  assert.equal(result.scrollsUsed, 2);
});

test('renderer readiness tracks busy state on the scroll root, even if loading starts after the scroll', async () => {
  const page = fixturePage([[{ id: 1 }]]);
  let polls = 0;
  page.waitForFunction = async (predicate, args) => {
    let loading = false;
    const root = { matches: () => loading, querySelector: () => null };
    const context = { items: [{ id: 1 }], root, window: {}, document: {} };
    const poll = runInNewContext(`(${predicate.toString()})`, context);
    assert.equal(poll(args), false, 'unchanged items do not end readiness immediately'); polls++;
    loading = true;
    assert.equal(poll(args), false, 'loading is remembered while waiting'); polls++;
    loading = false;
    const result = poll(args); polls++;
    assert.equal(result.items[0].id, 1, 'loading completion wakes the extraction');
    return { jsonValue: async () => result, dispose: async () => {} };
  };
  const result = await runBrowserExtraction(page, 'items', { scrolls: 1, scrollTarget: 'root', dedupeKeys: ['id'] });
  assert.equal(result.partial, false);
  assert.equal(polls, 3);
  assert.equal(result.scrollsUsed, 1);
});

test('new skeleton identities wait for text hydration and loading completion', async () => {
  const page = fixturePage([[{ id: 1, text: 'First' }]]);
  page.waitForFunction = async (predicate, args) => {
    let loading = true;
    const root = { matches: () => loading, querySelector: () => null };
    const context = { items: [{ id: 2, text: '' }], root, window: {}, document: {} };
    const poll = runInNewContext(`(${predicate.toString()})`, context);
    assert.equal(poll(args), false, 'new IDs with known loading must not satisfy readiness');
    context.items[0].text = 'Hydrated';
    assert.equal(poll(args), false, 'text alone does not override known loading');
    loading = false;
    const result = poll(args);
    assert.equal(result.items[0].text, 'Hydrated');
    return { jsonValue: async () => result, dispose: async () => {} };
  };
  const result = await runBrowserExtraction(page, 'items', { scrolls: 1, scrollTarget: 'root', dedupeKeys: ['id'] });
  assert.deepEqual(result.items.map(item => item.text), ['First', 'Hydrated']);
  assert.equal(result.partial, false);
});

test('a readiness timeout preserves completed items and excludes still-loading skeletons', async () => {
  const page = fixturePage([[{ id: 1, text: 'First' }]]);
  const originalEvaluate = page.evaluate.bind(page);
  page.evaluate = async (fn, args) => args?.script ? { loading: true, items: [] } : originalEvaluate(fn, args);
  page.waitForFunction = async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); };
  const result = await runBrowserExtraction(page, 'items', { scrolls: 5 });
  assert.deepEqual(result.items, [{ id: 1, text: 'First' }]);
  assert.equal(result.partial, true);
  assert.equal(result.stopReason, 'readiness_timeout');
  assert.match(result.failureReason, /still loading/);
  assert.equal(page.scrollCalls, 1);
});

test('later observations refresh fields for existing identities without changing discovery order', async () => {
  const page = fixturePage([
    [{ id: 1, text: 'Earlier' }, { id: 2, text: '' }],
    [{ id: 2, text: 'Hydrated' }, { id: 1, text: 'Latest' }, { id: 3, text: 'New' }],
  ]);
  const result = await runBrowserExtraction(page, 'items', { scrolls: 1, dedupeKeys: ['id'] });
  assert.deepEqual(result.items, [{ id: 1, text: 'Latest' }, { id: 2, text: 'Hydrated' }, { id: 3, text: 'New' }]);
});

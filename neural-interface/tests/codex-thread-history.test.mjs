import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hydrateCodexThreadHistory,
  isCodexHistoryUnavailableBeforeFirstTurn,
  isCodexItemsPaginationUnsupported,
} from '../lib/codex-thread-history.js';

test('hydrates every turn and item page in chronological order', async () => {
  const calls = [];
  const request = async (method, params, timeoutMs) => {
    calls.push({ method, params, timeoutMs });
    if (method === 'thread/turns/list') {
      return params.cursor === 'turn-page-2'
        ? { data: [{ id: 'turn-2', items: [], itemsView: 'notLoaded' }], nextCursor: null }
        : { data: [{ id: 'turn-1', items: [], itemsView: 'notLoaded' }], nextCursor: 'turn-page-2' };
    }
    return params.cursor === 'item-page-2'
      ? {
          data: [
            { turnId: 'turn-2', item: { id: 'item-2', type: 'agentMessage' } },
            { turnId: 'turn-2', item: { id: 'item-3', type: 'reasoning' } },
          ],
          nextCursor: null,
        }
      : {
          data: [{ turnId: 'turn-1', item: { id: 'item-1', type: 'userMessage' } }],
          nextCursor: 'item-page-2',
        };
  };

  const history = await hydrateCodexThreadHistory(request, 'thread-1');

  assert.equal(history.source, 'items-pagination');
  assert.deepEqual(history.turns, [
    {
      id: 'turn-1',
      itemsView: 'full',
      items: [{ id: 'item-1', type: 'userMessage' }],
    },
    {
      id: 'turn-2',
      itemsView: 'full',
      items: [
        { id: 'item-2', type: 'agentMessage' },
        { id: 'item-3', type: 'reasoning' },
      ],
    },
  ]);
  assert.deepEqual(calls.map(({ method, params }) => ({ method, params })), [
    {
      method: 'thread/turns/list',
      params: { threadId: 'thread-1', limit: 100, sortDirection: 'asc', itemsView: 'notLoaded' },
    },
    {
      method: 'thread/turns/list',
      params: {
        threadId: 'thread-1',
        limit: 100,
        sortDirection: 'asc',
        itemsView: 'notLoaded',
        cursor: 'turn-page-2',
      },
    },
    {
      method: 'thread/items/list',
      params: { threadId: 'thread-1', limit: 500, sortDirection: 'asc' },
    },
    {
      method: 'thread/items/list',
      params: {
        threadId: 'thread-1',
        limit: 500,
        sortDirection: 'asc',
        cursor: 'item-page-2',
      },
    },
  ]);
  assert.ok(calls.every((call) => call.timeoutMs === 15000));
});

test('falls back to full turn pagination only when item pagination is unsupported', async () => {
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, itemsView: params.itemsView || null });
    if (method === 'thread/items/list') {
      const error = new Error('thread/items/list is not supported yet');
      error.code = -32601;
      throw error;
    }
    if (params.itemsView === 'full') {
      return {
        data: [{ id: 'turn-1', itemsView: 'full', items: [{ id: 'item-1' }] }],
        nextCursor: null,
      };
    }
    return { data: [{ id: 'turn-1', itemsView: 'notLoaded', items: [] }], nextCursor: null };
  };

  const history = await hydrateCodexThreadHistory(request, 'thread-1');

  assert.equal(history.source, 'turns-full-fallback');
  assert.deepEqual(history.turns, [
    { id: 'turn-1', itemsView: 'full', items: [{ id: 'item-1' }] },
  ]);
  assert.deepEqual(calls, [
    { method: 'thread/turns/list', itemsView: 'notLoaded' },
    { method: 'thread/items/list', itemsView: null },
    { method: 'thread/turns/list', itemsView: 'full' },
  ]);
});

test('does not hide generic item pagination failures behind the fallback', async () => {
  const failure = new Error('Timed out waiting for Codex response to thread/items/list');
  const request = async (method) => {
    if (method === 'thread/items/list') throw failure;
    return { data: [{ id: 'turn-1' }], nextCursor: null };
  };

  await assert.rejects(
    hydrateCodexThreadHistory(request, 'thread-1'),
    (error) => error === failure,
  );
});

test('treats an unmaterialized thread as valid empty history', async () => {
  const request = async () => {
    throw new Error('thread thr-new is not materialized yet; thread/turns/list is unavailable before first user message');
  };

  assert.deepEqual(
    await hydrateCodexThreadHistory(request, 'thread-new'),
    { turns: [], source: 'unmaterialized' },
  );
});

test('rejects repeated cursors instead of looping forever', async () => {
  let requests = 0;
  const request = async () => {
    requests += 1;
    return { data: [], nextCursor: 'same-cursor' };
  };

  await assert.rejects(
    hydrateCodexThreadHistory(request, 'thread-1'),
    /repeated pagination cursor same-cursor/,
  );
  assert.equal(requests, 2);
});

test('rejects malformed page and item shapes', async () => {
  await assert.rejects(
    hydrateCodexThreadHistory(async () => ({ data: null }), 'thread-1'),
    /returned an invalid page/,
  );

  const malformedItemRequest = async (method) => {
    if (method === 'thread/turns/list') return { data: [{ id: 'turn-1' }] };
    return { data: [{ turnId: 'turn-missing', item: { id: 'item-1' } }] };
  };
  await assert.rejects(
    hydrateCodexThreadHistory(malformedItemRequest, 'thread-1'),
    /without a matching turn/,
  );
});

test('rejects duplicate turn and item identifiers', async () => {
  await assert.rejects(
    hydrateCodexThreadHistory(async (method) => (
      method === 'thread/turns/list'
        ? { data: [{ id: 'turn-1' }, { id: 'turn-1' }] }
        : { data: [] }
    ), 'thread-1'),
    /duplicate turn turn-1/,
  );

  const duplicateItemRequest = async (method) => {
    if (method === 'thread/turns/list') return { data: [{ id: 'turn-1' }] };
    return {
      data: [
        { turnId: 'turn-1', item: { id: 'item-1' } },
        { turnId: 'turn-1', item: { id: 'item-1' } },
      ],
    };
  };
  await assert.rejects(
    hydrateCodexThreadHistory(duplicateItemRequest, 'thread-1'),
    /duplicate item item-1/,
  );
});

test('classifies only explicit compatibility and first-turn errors', () => {
  assert.equal(isCodexItemsPaginationUnsupported({ code: -32601, message: 'Method not found' }), true);
  assert.equal(isCodexItemsPaginationUnsupported(new Error('active thread store does not support item pagination')), true);
  assert.equal(isCodexItemsPaginationUnsupported(new Error('Thread not found')), false);
  assert.equal(isCodexHistoryUnavailableBeforeFirstTurn(new Error('not materialized yet')), true);
  assert.equal(isCodexHistoryUnavailableBeforeFirstTurn(new Error('Timed out')), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import opencodeV2Client, {
  createClientInstance, describeSdkError, isCompactUnavailable, EXTRA_SDK_METHODS,
} from '../lib/opencode-v2-client.js';

const ok = (data, status = 200) => Promise.resolve({ data, response: { status } });
const fail = (error, status) => Promise.resolve({ error, response: { status } });

// A fake SDK client that records every call and answers from `answers`.
function fakeFactory(calls, answers = {}) {
  const group = (name) => new Proxy({}, {
    get: (_t, method) => (params, options) => {
      calls.push([`${name}.${String(method)}`, params, options]);
      const answer = answers[`${name}.${String(method)}`];
      return answer ? answer(params) : ok({});
    },
  });
  return ({ baseUrl }) => new Proxy({ baseUrl }, {
    get: (target, name) => (name in target ? target[name] : group(String(name))),
  });
}

test('every EXTRA_SDK_METHODS entry exists on the pinned SDK client', () => {
  const sdk = createOpencodeClient({ baseUrl: 'http://127.0.0.1:1' });
  for (const [group, methods] of Object.entries(EXTRA_SDK_METHODS)) {
    for (const method of methods) {
      assert.equal(typeof sdk[group]?.[method], 'function', `${group}.${method} is an SDK method`);
    }
  }
});

test('extra wrappers pass params and options through and resolve { status, data }', async (t) => {
  const calls = [];
  const client = createClientInstance({
    port: 12345,
    clientFactory: fakeFactory(calls, {
      'session.status': () => ok({ ses_1: { type: 'busy' } }),
      'session.revert': () => ok({ id: 'ses_1', revert: { messageID: 'msg_1' } }),
      'permission.list': () => ok([{ id: 'per_1', sessionID: 'ses_1' }]),
    }),
  });
  t.after(() => client.stop());

  assert.deepEqual(await client.extra.session.status({ directory: '/p' }), { status: 200, data: { ses_1: { type: 'busy' } } });
  const signal = AbortSignal.abort();
  await client.extra.session.revert({ sessionID: 'ses_1', messageID: 'msg_1', partID: undefined }, { signal });
  assert.deepEqual((await client.extra.permission.list()).data, [{ id: 'per_1', sessionID: 'ses_1' }]);

  assert.deepEqual(calls, [
    ['session.status', { directory: '/p' }, undefined],
    ['session.revert', { sessionID: 'ses_1', messageID: 'msg_1' }, { signal }],
    ['permission.list', {}, undefined],
  ]);
});

test('the hand-written wrappers still behave as before', async (t) => {
  const calls = [];
  const client = createClientInstance({ port: 12346, clientFactory: fakeFactory(calls) });
  t.after(() => client.stop());

  // prompt strips `signal` out of the params and hands it over as an option.
  const signal = new AbortController().signal;
  await client.session.prompt({ sessionID: 's', parts: [], signal });
  assert.deepEqual(calls[0], ['session.prompt', { sessionID: 's', parts: [] }, { signal }]);
});

test('compact still prefers v2.session.compact and falls back the way it always did', async (t) => {
  const calls = [];
  const v2First = createClientInstance({
    port: 12350,
    clientFactory: () => ({
      v2: { session: { compact(p) { calls.push(['v2.compact', p]); return ok(undefined, 204); } } },
      session: { summarize(p) { calls.push(['summarize', p]); return ok(true); } },
    }),
  });
  const v1Only = createClientInstance({
    port: 12351,
    clientFactory: () => ({ session: { summarize(p) { calls.push(['summarize', p]); return ok(true); } } }),
  });
  t.after(() => { v2First.stop(); v1Only.stop(); });

  assert.deepEqual(await v2First.session.compact({ sessionID: 's', directory: '/p' }), { status: 204, data: undefined });
  assert.deepEqual(await v1Only.session.compact({ sessionID: 's' }), { status: 200, data: true });
  assert.deepEqual(calls, [
    ['v2.compact', { sessionID: 's', directory: '/p' }],
    ['summarize', { sessionID: 's' }],
  ]);
});

// The loop runtime (native-loop-providers.js `storedRows`) and the Assistant's
// OpenCode brain feature-detect `client.session.children`. A method added to an
// existing group would silently switch them onto another code path, so the
// groups they see must keep exactly the keys they had before SDK 1.18.34.
test('the surface loops and the Assistant see is unchanged; new calls live under extra', (t) => {
  const client = createClientInstance({ port: 12347, clientFactory: fakeFactory([]) });
  t.after(() => client.stop());
  const before = {
    session: ['abort', 'compact', 'context', 'create', 'delete', 'get', 'list', 'messages', 'prompt', 'promptAsync', 'update'],
    permission: ['reply'],
    question: ['list', 'reject', 'reply'],
    mcp: ['connect', 'disconnect', 'status'],
  };
  for (const [group, methods] of Object.entries(before)) {
    assert.deepEqual(Object.keys(client[group]).sort(), methods, `instance ${group}`);
    assert.deepEqual(Object.keys(opencodeV2Client[group]).sort(), methods, `singleton ${group}`);
  }
  assert.equal(client.session.children, undefined);
  assert.equal(opencodeV2Client.session.children, undefined);
  assert.deepEqual(
    Object.keys(client).sort(),
    ['extra', 'isConnected', 'mcp', 'onEvent', 'permission', 'port', 'question', 'session', 'start', 'stop', 'waitUntilConnected'],
  );
  for (const [group, methods] of Object.entries(EXTRA_SDK_METHODS)) {
    for (const method of methods) {
      assert.equal(typeof client.extra[group][method], 'function', `instance extra.${group}.${method}`);
      assert.equal(typeof opencodeV2Client.extra[group][method], 'function', `singleton extra.${group}.${method}`);
    }
  }
});

test('a missing SDK method rejects instead of throwing synchronously', async (t) => {
  const client = createClientInstance({ port: 12348, clientFactory: () => ({ session: {} }) });
  t.after(() => client.stop());
  await assert.rejects(client.extra.session.fork({ sessionID: 's' }), /does not expose session\.fork/);
});

test('describeSdkError reads both 1.18 error shapes and never returns an empty message', () => {
  assert.deepEqual(
    describeSdkError({ name: 'NotFoundError', data: { message: 'Session not found: ses_x' } }, 404),
    { message: 'Session not found: ses_x', tag: 'NotFoundError' },
  );
  assert.deepEqual(
    describeSdkError({ _tag: 'PermissionNotFoundError', requestID: 'per_x', message: 'Permission request not found: per_x' }, 404),
    { message: 'Permission request not found: per_x', tag: 'PermissionNotFoundError' },
  );
  assert.deepEqual(describeSdkError({ _tag: 'SessionBusyError' }, 409), { message: 'SessionBusyError', tag: 'SessionBusyError' });
  assert.deepEqual(describeSdkError({}, 500), { message: 'opencode SDK error (HTTP 500)', tag: '' });
  assert.deepEqual(describeSdkError({}, undefined), { message: 'opencode SDK error', tag: '' });
  assert.deepEqual(describeSdkError('upstream exploded', 502), { message: 'upstream exploded', tag: '' });
});

test('a failed call throws with message, status, tag and the raw body as cause', async (t) => {
  const body = { _tag: 'ServiceUnavailableError', message: 'Session compact is not available yet', service: 'session.compact' };
  const client = createClientInstance({
    port: 12349,
    clientFactory: () => ({
      v2: { session: { compact: () => fail(body, 503) } },
      session: { get: () => fail({ name: 'NotFoundError', data: { message: 'Session not found: s' } }, 404), abort: () => fail({}, 500) },
    }),
  });
  t.after(() => client.stop());

  const compactErr = await client.session.compact({ sessionID: 's' }).catch((e) => e);
  assert.equal(compactErr.message, 'Session compact is not available yet');
  assert.equal(compactErr.status, 503);
  assert.equal(compactErr.tag, 'ServiceUnavailableError');
  assert.equal(compactErr.cause, body);
  assert.equal(isCompactUnavailable(compactErr), true);

  const getErr = await client.session.get({ sessionID: 's' }).catch((e) => e);
  assert.equal(getErr.message, 'Session not found: s');
  assert.equal(getErr.status, 404);
  assert.deepEqual(getErr.data, { message: 'Session not found: s' });
  assert.equal(isCompactUnavailable(getErr), false);

  // An empty error body used to read "opencode SDK error"; it still starts with it.
  const abortErr = await client.session.abort({ sessionID: 's' }).catch((e) => e);
  assert.match(abortErr.message, /^opencode SDK error/);
  assert.equal(abortErr.status, 500);
});

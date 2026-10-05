// The Codex panel's capability cache: stale-while-revalidate, one read per
// burst, never another epoch's answer (public/shared/cdx/cdx-capabilities.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codexCapabilityEpoch, knownCodexCapabilities, storeCodexCapabilities, dropCodexCapabilities,
  invalidateCodexCapabilities, currentCodexCapabilities, requestWithCodexCapability,
} from '../public/shared/cdx/cdx-capabilities.js';

const NOT_ADVERTISED = 'This runtime has not advertised support for this feature.';
const ADVERTISED = { attachment_list: { supported: true }, attachment_add: { supported: true } };

// A runtime whose capabilities_read answers when the test says so.
function makeRuntime(capabilities = ADVERTISED) {
  const pending = [];
  const reads = [];
  return {
    reads,
    read: () => new Promise((resolve, reject) => {
      reads.push('capabilities_read');
      pending.push({ resolve, reject });
    }),
    answer(value = { capabilities, runtime: { cliVersion: '0.160.0' } }) { pending.shift().resolve(value); },
    fail(message) { pending.shift().reject(new Error(message)); },
    get waiting() { return pending.length; },
  };
}

function makeTab(overrides = {}) {
  return { id: 'tab', accountId: 'default', connectionEpoch: 'epoch-1', threadId: 'thread-1', closed: false, ...overrides };
}

// The wrapper the panel builds for an action opened from one conversation.
function gated(tab, api, sent) {
  const owner = { accountId: tab.accountId, threadId: tab.threadId, connectionEpoch: tab.connectionEpoch };
  return (type, data = {}) => requestWithCodexCapability({
    type,
    capabilities: () => currentCodexCapabilities(tab, api.read),
    changed: () => (tab.closed || tab.accountId !== owner.accountId || tab.threadId !== owner.threadId
      || tab.connectionEpoch !== owner.connectionEpoch ? 'This conversation changed.' : ''),
    send: async () => { sent.push({ type, data }); return { ok: type }; },
  });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('an invalidated cache makes the request wait for the re-read, then succeed', async () => {
  const tab = makeTab(); const api = makeRuntime(); const sent = [];
  storeCodexCapabilities(tab, ADVERTISED);
  invalidateCodexCapabilities(tab);
  assert.equal(knownCodexCapabilities(tab), ADVERTISED, 'the last answer stays readable while stale');

  const request = gated(tab, api, sent)('attachment_list', { threadId: 'thread-1' });
  await settle();
  assert.equal(api.reads.length, 1);
  assert.deepEqual(sent, [], 'nothing is sent before the capabilities are current');
  api.answer();
  assert.deepEqual(await request, { ok: 'attachment_list' });
  assert.deepEqual(sent, [{ type: 'attachment_list', data: { threadId: 'thread-1' } }]);

  await gated(tab, api, sent)('attachment_list');
  assert.equal(api.reads.length, 1, 'a fresh answer is not read again');
});

test('a capability the runtime does not support is still rejected, with its reason', async () => {
  const tab = makeTab(); const sent = [];
  const api = makeRuntime({ attachment_list: { supported: true }, verification_enroll: { supported: false, reason: 'Requires a newer Codex.' } });
  const request = gated(tab, api, sent);

  const refused = request('verification_enroll');
  await settle(); api.answer();
  await assert.rejects(refused, /Requires a newer Codex\./);

  await assert.rejects(request('goal_set'), new RegExp(NOT_ADVERTISED.replace(/\./g, '\\.')));
  assert.deepEqual(await request('account_read'), { ok: 'account_read' }, 'bridge actions older than the capability list stay usable');
  assert.deepEqual(sent.map((entry) => entry.type), ['account_read']);
  assert.equal(api.reads.length, 1);
});

test('requests made while a re-read is pending share one capabilities_read', async () => {
  const tab = makeTab(); const api = makeRuntime(); const sent = [];
  const request = gated(tab, api, sent);
  const burst = ['attachment_list', 'attachment_add', 'account_read', 'attachment_list'].map((type) => request(type));
  const direct = currentCodexCapabilities(tab, api.read);
  await settle();
  assert.equal(api.reads.length, 1);
  assert.equal(api.waiting, 1);
  api.answer();
  assert.equal((await Promise.all(burst)).length, 4);
  assert.equal(await direct, tab.codexCapabilities);
  assert.equal(api.reads.length, 1);
  assert.equal(tab.codexRuntime.cliVersion, '0.160.0');
});

test('a notification storm marks the cache stale without reading; the next demand reads once', async () => {
  const tab = makeTab(); const api = makeRuntime(); const sent = [];
  storeCodexCapabilities(tab, ADVERTISED);
  for (let i = 0; i < 200; i += 1) invalidateCodexCapabilities(tab); // account/rateLimits/updated ×200
  await settle();
  assert.equal(api.reads.length, 0, 'invalidation alone never reads');
  assert.equal(knownCodexCapabilities(tab), ADVERTISED);

  const first = gated(tab, api, sent)('attachment_list');
  for (let i = 0; i < 200; i += 1) invalidateCodexCapabilities(tab); // the storm goes on during the read
  const second = gated(tab, api, sent)('attachment_add');
  await settle();
  assert.equal(api.reads.length, 1);
  api.answer();
  await Promise.all([first, second]);
  assert.equal(sent.length, 2);

  // The answer landed after the storm, so it is newer than what the storm announced.
  await gated(tab, api, sent)('attachment_list');
  assert.equal(api.reads.length, 1);
  invalidateCodexCapabilities(tab); // one more notification after the answer
  const later = gated(tab, api, sent)('attachment_list');
  await settle();
  assert.equal(api.reads.length, 2);
  api.answer(); await later;
});

test('another account or connection never reuses the previous epoch\'s capabilities', async () => {
  for (const change of [{ accountId: 'work' }, { connectionEpoch: 'epoch-2' }]) {
    const tab = makeTab(); const api = makeRuntime({ attachment_list: { supported: false, reason: 'Not on this runtime.' } });
    storeCodexCapabilities(tab, ADVERTISED);
    assert.equal(tab.codexCapabilitiesEpoch, codexCapabilityEpoch(tab));
    Object.assign(tab, change);
    assert.equal(knownCodexCapabilities(tab), null, JSON.stringify(change));

    // Invalidation notices the change and forgets the old answer for direct readers too.
    invalidateCodexCapabilities(tab);
    assert.equal(tab.codexCapabilities, null);

    const current = currentCodexCapabilities(tab, api.read);
    await settle();
    assert.equal(api.reads.length, 1, 'the new epoch is read, not assumed');
    api.answer();
    assert.equal((await current).attachment_list.supported, false);
    assert.equal(tab.codexCapabilitiesEpoch, codexCapabilityEpoch(tab));
  }
});

test('a tab that moves on while its capabilities are read gets the new epoch\'s answer and refuses the old request', async () => {
  const tab = makeTab(); const api = makeRuntime(); const sent = [];
  const request = gated(tab, api, sent)('attachment_list');
  const direct = currentCodexCapabilities(tab, api.read);
  await settle();
  tab.connectionEpoch = 'epoch-2'; // reconnect while the read is out
  api.answer({ capabilities: { attachment_list: { supported: true }, old_epoch_only: { supported: true } } });
  await settle();
  assert.equal(api.reads.length, 2, 'the answer of the old epoch is not stored: the new epoch is read');
  assert.equal(tab.codexCapabilities ?? null, null);
  api.answer({ capabilities: { attachment_list: { supported: true } } });
  assert.equal((await direct).old_epoch_only, undefined);
  await assert.rejects(request, /This conversation changed\./);
  assert.deepEqual(sent, []);

  // A thread change keeps the runtime's capabilities but still refuses the request of the old conversation.
  const other = makeTab(); const otherSent = [];
  storeCodexCapabilities(other, ADVERTISED);
  const stale = gated(other, makeRuntime(), otherSent);
  other.threadId = 'thread-2';
  await assert.rejects(stale('attachment_list'), /This conversation changed\./);
  assert.deepEqual(otherSent, []);
});

test('a dropped cache is read again; a failed re-read falls back to the last answer of the same epoch', async () => {
  const tab = makeTab(); const api = makeRuntime(); const sent = [];
  storeCodexCapabilities(tab, ADVERTISED);
  invalidateCodexCapabilities(tab);
  const request = gated(tab, api, sent)('attachment_add');
  await settle(); api.fail('Codex request superseded or disconnected');
  assert.deepEqual(await request, { ok: 'attachment_add' }, 'the bridge enforces support; the last answer is the best one left');

  const retry = gated(tab, api, sent)('attachment_add');
  await settle();
  assert.equal(api.reads.length, 2, 'still stale after a failed read');
  api.answer(); await retry;

  dropCodexCapabilities(tab);
  assert.equal(knownCodexCapabilities(tab), null);
  const unreadable = gated(tab, api, sent);
  const refused = unreadable('attachment_add');
  const legacy = unreadable('account_read');
  await settle();
  assert.equal(api.reads.length, 3);
  api.fail('Codex is not connected');
  await assert.rejects(refused, /Codex is not connected/, 'the real reason, not "not advertised"');
  assert.deepEqual(await legacy, { ok: 'account_read' });
});

test('a runtime without capabilities_read keeps the pre-existing bridge actions only', async () => {
  const tab = makeTab(); const api = makeRuntime(); const sent = [];
  const request = gated(tab, api, sent);
  const refused = request('attachment_list');
  await settle(); api.fail('Unknown message type: capabilities_read');
  await assert.rejects(refused, new RegExp(NOT_ADVERTISED.replace(/\./g, '\\.')));
  assert.deepEqual(tab.codexCapabilities, {});
  assert.deepEqual(await request('config_read'), { ok: 'config_read' });
  assert.equal(api.reads.length, 1, 'the empty answer is cached for the epoch');
});

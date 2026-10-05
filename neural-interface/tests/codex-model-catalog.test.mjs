import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexModelCatalog, codexContextAvailability } from '../public/shared/cdx/cdx-model-catalog.js';

const astra = { id: 'gpt-6-astra', isDefault: true, contextWindow: 272000, maxContextWindow: 872000, supportsExtendedContext: true };
const tab = (overrides = {}) => ({ accountId: 'default', connectionEpoch: 'first', ws: {}, connected: true, bootstrapped: true, model: astra.id, ...overrides });
const ready = tab => !!(tab.connected && tab.bootstrapped && !tab.closed);
const catalog = (request, onChange) => new CodexModelCatalog({ request, isReady: ready, onChange });
const deferred = () => Promise.withResolvers();
const tick = () => new Promise(resolve => setImmediate(resolve));

test('failed discovery stays retryable and fallback choices never advertise capabilities', async () => {
  let calls = 0;
  const models = catalog(async () => {
    if (++calls === 1) throw new Error('temporary failure');
    return { models: [astra] };
  });
  const target = tab();
  assert.ok((await models.request(target)).length);
  assert.equal(models.state(target).status, 'error');
  assert.equal(models.state(target).models, null);
  assert.equal(models.state(target).pending, null);
  assert.match(models.state(target).error, /temporary failure/);
  const recovered = await models.request(target);
  assert.equal(calls, 2);
  assert.equal(models.state(target).status, 'ready');
  assert.equal(recovered[0].supportsExtendedContext, true);
  assert.equal(target.model, astra.id);
});

test('refresh errors preserve the last successful catalog, including valid empty lists', async () => {
  let response = { models: [astra] };
  const models = catalog(async () => response);
  const target = tab();
  const good = await models.request(target);
  response = { models: [], error: 'model/list failed' };
  assert.equal(await models.request(target, { force: true }), good);
  assert.equal(models.state(target).status, 'error');
  response = { models: [] };
  assert.deepEqual(await models.request(target), []);
  assert.equal(models.state(target).status, 'ready');
  response = { models: [{ ...astra, hidden: true }] };
  assert.deepEqual(await models.request(target, { force: true }), []);
});

test('discovery waits for bootstrap and deduplicates simultaneous retries', async () => {
  let calls = 0;
  const response = deferred();
  const models = catalog(() => { calls++; return response.promise; });
  const target = tab({ connected: false, bootstrapped: false });
  await models.request(target, { force: true });
  assert.equal(calls, 0);
  assert.equal(models.state(target).status, 'idle');
  target.connected = target.bootstrapped = true;
  const first = models.request(target, { force: true });
  assert.equal(models.request(target, { force: true }), first);
  await tick();
  assert.equal(calls, 1);
  response.resolve({ models: [astra] });
  await first;
});

test('reconnection replaces a pending request and ignores its late response', async () => {
  const old = deferred();
  let calls = 0, oldSignal;
  const models = catalog((_tab, signal) => {
    if (++calls === 1) { oldSignal = signal; return old.promise; }
    return { models: [astra] };
  });
  const target = tab();
  const first = models.request(target);
  await tick();
  target.ws = {};
  target.connectionEpoch = 'second';
  await models.request(target, { force: true });
  assert.equal(oldSignal.aborted, true);
  old.resolve({ models: [{ id: 'obsolete-model' }] });
  await first;
  assert.equal(models.state(target).models[0].id, astra.id);
  assert.equal(models.state(target).status, 'ready');
});

test('account changes and same-account competing tabs cannot overwrite newer catalogs', async () => {
  const old = deferred();
  let calls = 0;
  const models = catalog(() => ++calls === 1 ? old.promise : { models: [astra] });
  const firstTab = tab();
  const first = models.request(firstTab);
  await tick();
  const otherTab = tab({ ws: {}, connectionEpoch: 'other' });
  await models.request(otherTab, { force: true });
  firstTab.accountId = 'other-account';
  old.resolve({ models: [{ id: 'wrong-account-model' }] });
  await first;
  assert.equal(models.state(otherTab).models[0].id, astra.id);
  assert.equal(models.state(firstTab).models, null);
});

test('disconnect and explicit invalidation allow another live discovery', async () => {
  const old = deferred();
  let calls = 0;
  const models = catalog(() => ++calls === 1 ? old.promise : { models: [astra] });
  const target = tab();
  const first = models.request(target);
  await tick();
  target.connected = false;
  models.disconnect(target);
  assert.equal(models.state(target).pending, null);
  assert.equal(models.state(target).status, 'idle');
  target.connected = true;
  await models.request(target);
  models.invalidate(target);
  await models.request(target);
  assert.equal(calls, 3);
  old.resolve({ models: [] });
  await first;
  assert.equal(models.state(target).models[0].id, astra.id);
});

test('missing metadata, discovery failures, unsupported models, and busy states have distinct explanations', () => {
  const target = tab();
  const availability = (state, model = astra) => codexContextAvailability({ tab: target, catalog: { status: state }, model, connected: true });
  assert.match(availability('loading').reason, /Loading/);
  assert.equal(availability('error').retry, true);
  assert.equal(availability('ready', { id: astra.id }).retry, true);
  assert.equal(availability('ready', { id: astra.id, supportsExtendedContext: true }).supported, false);
  assert.match(availability('ready', { ...astra, supportsExtendedContext: false, maxContextWindow: 272000 }).reason, /not advertised/);
  assert.equal(availability('ready').supported, true);
  for (const key of ['running', 'startingThread', 'compacting']) {
    target[key] = true;
    assert.equal(availability('ready').busy, true);
    assert.match(availability('ready').reason, /Wait/);
    target[key] = false;
  }
  assert.equal(availability('ready').busy, false);
});
test('live model access-program metadata survives the Codex catalog normalization', async () => {
  const tab = { accountId: 'a', connectionEpoch: 'e', ws: {} };
  const catalog = new CodexModelCatalog({ isReady: () => true, request: async () => ({ models: [{
    model: 'future-model', displayName: 'Future model', supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'Deep reasoning' }],
    availableAccessPrograms: { cyber: ['standard', 'daybreakRed'] },
  }] }) });
  const choices = await catalog.request(tab);
  assert.deepEqual(choices[0].availableAccessPrograms, { cyber: ['standard', 'daybreakRed'] });
  assert.match(choices[0].desc, /Access programs: standard, daybreak Red/);
  assert.equal(choices[0].supportedReasoningEfforts[0].reasoningEffort, 'ultra');
});

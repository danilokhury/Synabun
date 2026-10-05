// OpenCode panel, cluster 7: environment (MCP, update notice, model data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mcpRowView, isNewerVersion, updateNoticeText, modelRowMeta, sessionModelOf,
  isProviderCatalogEvent, PROVIDER_CATALOG_EVENTS,
} from '../public/shared/ocp-v2/ocp-v2-status-logic.js';
import { createSharedFetch } from '../public/shared/ocp-v2/ocp-v2-providers.js';

const read = (name) => readFileSync(new URL(`../public/shared/ocp-v2/${name}`, import.meta.url), 'utf8');

// ── O21 MCP servers ─────────────────────────────────────────────────────────

test('each MCP status has a label, a tone and the one action that makes sense', () => {
  assert.deepEqual(mcpRowView({ name: 'github', status: 'connected', managed: false }), {
    name: 'github', label: 'connected', tone: 'ok', action: 'disconnect', actionLabel: 'Disconnect', note: '',
  });
  assert.deepEqual(mcpRowView({ name: 'docs', status: 'disabled' }).action, 'connect');
  const failed = mcpRowView({ name: 'broken', status: 'failed', error: 'spawn ENOENT' });
  assert.deepEqual([failed.tone, failed.action, failed.actionLabel, failed.note], ['error', 'connect', 'Retry', 'spawn ENOENT']);
  assert.deepEqual([mcpRowView({ name: 'x', status: 'needs_auth' }).action, mcpRowView({ name: 'x', status: 'needs_auth' }).actionLabel], ['authenticate', 'Sign in']);
  assert.equal(mcpRowView({ name: 'x', status: 'needs_client_registration' }).action, null);
  assert.equal(mcpRowView({ name: 'x', status: 'made-up' }).label, 'failed');
});

test('the SynaBun entry is shown but offers no action', () => {
  const view = mcpRowView({ name: 'SynaBun', status: 'connected', managed: true });
  assert.deepEqual([view.action, view.actionLabel, view.note], [null, '', 'managed by SynaBun']);
  assert.equal(mcpRowView({ name: 'SynaBun', status: 'failed', managed: true, error: 'x' }).action, null);
});

// ── O27 update notice (D5) ──────────────────────────────────────────────────

test('the update notice appears only for a newer version and never offers to upgrade in the panel', () => {
  assert.equal(isNewerVersion('1.18.35', '1.18.34'), true);
  assert.equal(isNewerVersion('1.19.0', '1.18.34'), true);
  assert.equal(isNewerVersion('v2.0.0', '1.18.34'), true);
  assert.equal(isNewerVersion('1.18.34', '1.18.34'), false);
  assert.equal(isNewerVersion('1.18.9', '1.18.34'), false);
  assert.equal(isNewerVersion('', '1.18.34'), false);
  assert.equal(isNewerVersion('1.18.35', ''), true);
  assert.equal(updateNoticeText('1.18.35', '1.18.34'), 'OpenCode 1.18.35 is available (running 1.18.34). Update it from a terminal: opencode upgrade');
  assert.equal(updateNoticeText('1.18.34', '1.18.34'), '');
  assert.equal(updateNoticeText('', '1.18.34'), '');
  // Notice only: the status module never calls an upgrade endpoint.
  const status = read('ocp-v2-status.js');
  assert.equal(/upgrade\(|global\.upgrade|\/global\/upgrade/.test(status), false);
  assert.match(status, /eventType === 'installation\.update-available'/);
});

// ── O23 model picker data ───────────────────────────────────────────────────

test('a model row shows a non-active status and the catalog price', () => {
  assert.deepEqual(modelRowMeta({ status: 'active', cost: { input: 3, output: 15 } }), { status: '', price: '$3 / $15' });
  assert.deepEqual(modelRowMeta({ status: 'beta', cost: { input: 0.25, output: 1.253 } }), { status: 'beta', price: '$0.25 / $1.25' });
  assert.deepEqual(modelRowMeta({ status: 'deprecated', cost: { input: 0, output: 0 } }), { status: 'deprecated', price: 'free' });
  assert.deepEqual(modelRowMeta({ cost: { input: 75, output: 150 } }), { status: '', price: '$75 / $150' });
  assert.deepEqual(modelRowMeta({ status: 'active' }), { status: '', price: '' });
  assert.deepEqual(modelRowMeta(null), { status: '', price: '' });
});

test('a session resumes on the model it last ran on', () => {
  assert.deepEqual(sessionModelOf({ model: { id: 'claude-x', providerID: 'anthropic', variant: 'high' } }), { providerID: 'anthropic', modelID: 'claude-x' });
  assert.deepEqual(sessionModelOf({ model: { modelID: 'm', providerID: 'p' } }), { providerID: 'p', modelID: 'm' });
  assert.equal(sessionModelOf({ model: { id: 'claude-x' } }), null);
  assert.equal(sessionModelOf({}), null);
  assert.equal(sessionModelOf(null), null);
  // The panel no longer restores from the info it was handed (a session-menu
  // row has no model): it reads the whole session first (review F06,
  // tests/opencode-review1-panel.test.mjs).
  const panel = read('ocp-v2-panel.js');
  // and only from a read made now, never from a cached Session (review 2, R03).
  // Review 3 (T07): the read and its guards are loadSelectedSession
  // (ocp-v2-session-actions.js); the panel hands it what to apply.
  const actions = read('ocp-v2-session-actions.js');
  assert.match(actions, /const detail = await loadSessionDetail\(api, sessionId, info\);/);
  assert.match(actions, /if \(!detail\.fresh\) return detail\.info;/);
  assert.match(panel, /return loadSelectedSession\(getDefaultStore\(\), api, sid, info, \(full\) => \{/);
  assert.match(panel, /applySessionSelections\(getDefaultStore\(\), full\);/);
});

test('catalog and integration events make the pickers re-read the provider list', () => {
  for (const type of PROVIDER_CATALOG_EVENTS) assert.equal(isProviderCatalogEvent(type), true, type);
  assert.equal(isProviderCatalogEvent('integration.something.new'), true);
  assert.equal(isProviderCatalogEvent('message.updated'), false);
  assert.equal(isProviderCatalogEvent(undefined), false);
  assert.match(read('ocp-v2-status.js'), /isProviderCatalogEvent\(eventType\)[\s\S]{0,120}ocp-providers-changed/);
});

test('the provider list is read once for a burst of callers, again after it changed', async () => {
  let reads = 0;
  let clock = 1000;
  const shared = createSharedFetch(async () => { reads += 1; return { ok: true, n: reads }; }, { shareMs: 3000, now: () => clock });
  const [a, b, c] = await Promise.all([shared(), shared(), shared()]);
  assert.deepEqual([a.n, b.n, c.n, reads], [1, 1, 1, 1]);
  clock += 2999;
  assert.equal((await shared()).n, 1);
  clock += 2;
  assert.equal((await shared()).n, 2, 'a later, deliberate refresh reads the server again');
  shared.invalidate();
  assert.equal((await shared()).n, 3);

  // A failed read is not kept.
  let fail = true;
  const flaky = createSharedFetch(async () => { if (fail) throw new Error('offline'); return 'ok'; }, { now: () => clock });
  await assert.rejects(flaky(), /offline/);
  fail = false;
  assert.equal(await flaky(), 'ok');
});

test('every module that needs the provider list asks through the shared read', () => {
  for (const name of ['ocp-v2-modelpicker.js', 'ocp-v2-variantpicker.js', 'ocp-v2-context-gauge.js', 'ocp-v2-send.js']) {
    const source = read(name);
    assert.match(source, /fetchProvidersFull\(\)/, name);
    assert.equal(source.includes("fetch('/api/opencode/providers/full')"), false, `${name} has no private fetch`);
  }
});

// ── O22 connect a provider ──────────────────────────────────────────────────

test('an empty model picker and an auth error both lead to Settings', () => {
  const picker = read('ocp-v2-modelpicker.js');
  assert.equal((picker.match(/_menu\.appendChild\(connectProviderOption\(\)\)/g) || []).length, 2);
  assert.match(picker, /openProviderSettings\(\);/);
  assert.match(read('ocp-v2-render.js'), /inlineAction\('Open Settings', \(\) => openProviderSettings\(\), store\)/);
  assert.match(read('ocp-v2-settings-link.js'), /openSettingsModal\(\{ scrollTo: PROVIDERS_CONTROL \}\)/);
});

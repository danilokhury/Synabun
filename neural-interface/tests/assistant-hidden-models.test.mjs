import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import express from 'express';
import {
  ASSISTANT_HIDDEN_SYNC_TYPE, createAssistantHiddenModelsRouter, createAssistantHiddenModelsStore, createHiddenModels, normalizeModelIds, resolveHiddenModelId,
} from '../lib/assistant-hidden-models.js';
import { createOpencodeHiddenModelsStore, HIDDEN_MODELS_SYNC_TYPE } from '../lib/opencode-hidden-models.js';
import { createAssistantCatalog, findModel, hiddenModelId } from '../lib/assistant-catalog.js';
import { buildRouteOptions, evaluateRoute, normalizeRouteRequest, targetFromAnswer } from '../lib/assistant-router.js';
import { CLAUDE_MODELS, CODEX_MODELS, PRICING, fakeFetch } from './assistant-catalog.fixtures.mjs';

// The acceptance models: older Claude variants and an old Codex model.
const OLD_CLAUDE = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', resolvedModel: 'claude-opus-4-8', contextWindow: 200000, effortLevels: [] },
  { id: 'claude-opus-5', label: 'Opus 5', resolvedModel: 'claude-opus-5', contextWindow: 200000, effortLevels: [] },
  { id: 'claude-fable-5', label: 'Fable 5', resolvedModel: 'claude-fable-5', contextWindow: 200000, effortLevels: [] },
];
const OVERRIDES = {
  '/api/claude/models': { ...CLAUDE_MODELS, models: [...CLAUDE_MODELS.models, ...OLD_CLAUDE] },
  '/api/codex/models': { ...CODEX_MODELS, models: [...CODEX_MODELS.models, { id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5', inputModalities: ['text', 'image'] }] },
};
const UNWANTED = { 'claude-code': ['claude-opus-4-8', 'claude-opus-5', 'claude-fable-5'], codex: ['gpt-5.5'], opencode: [] };
const BRAIN = { provider: 'claude-code', model: 'sonnet', effort: null };

function tempDir(t) {
  const dir = mkdtempSync(resolve(tmpdir(), 'synabun-asst-hidden-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function catalogWith(hidden) {
  const catalog = createAssistantCatalog({ fetchJson: fakeFetch(OVERRIDES), claudePricing: PRICING, readHidden: () => hidden });
  return { catalog, full: await catalog.full() };
}

// ── store + facade ───────────────────────────────────────────────────────────

test('normalizeModelIds: unique (case-insensitive), sorted, blanks dropped', () => {
  assert.deepEqual(normalizeModelIds(['opus', 'Opus', ' gpt-5.5 ', '', 7, null, 'claude-opus-5']), ['claude-opus-5', 'gpt-5.5', 'opus']);
  assert.deepEqual(normalizeModelIds('opus'), []);
});

test('store: per-provider lists persist atomically, bump the version, notify, and re-read hand edits', (t) => {
  const path = resolve(tempDir(t), 'data', 'assistant-hidden-models.json');
  const store = createAssistantHiddenModelsStore({ path, now: () => Date.parse('2026-09-25T10:00:00Z') });
  assert.deepEqual(store.read(), { providers: { 'claude-code': [], codex: [] }, version: 0, updatedAt: null });
  const seen = [];
  store.onChange((_v, meta) => seen.push(meta.provider));
  assert.equal(store.set('claude-code', ['claude-opus-5']).changed, true);
  assert.equal(store.set('claude-code', ['claude-opus-5']).changed, false);
  assert.equal(store.read().version, 1);
  assert.deepEqual(seen, ['claude-code']);
  assert.throws(() => store.set('opencode', ['x/y']), /provider must be/);
  writeFileSync(path, JSON.stringify({ version: 7, providers: { codex: ['gpt-5.5'] } }));
  utimesSync(path, new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(store.list('codex'), ['gpt-5.5']);
  assert.deepEqual(store.list('claude-code'), []);
});

test('facade: hide/show per provider; OpenCode goes through the Settings → OpenCode store', (t) => {
  const dir = tempDir(t);
  const opencodeStore = createOpencodeHiddenModelsStore({ path: resolve(dir, 'opencode-hidden-models.json') });
  const hidden = createHiddenModels({ file: resolve(dir, 'assistant-hidden-models.json'), opencodeStore });
  const events = [];
  hidden.onChange((e) => events.push(e.provider));
  const first = hidden.update('claude-code', { hide: ['claude-opus-5', 'CLAUDE-OPUS-5'] });
  assert.deepEqual(first.added, ['claude-opus-5']);
  assert.equal(hidden.update('claude-code', { hide: ['claude-opus-5'] }).changed, false);
  hidden.update('opencode', { hide: ['ollama-cloud/deepseek-v4-pro'] });
  assert.deepEqual(opencodeStore.list(), ['ollama-cloud/deepseek-v4-pro'], 'Settings → OpenCode sees the same list');
  opencodeStore.set([]);
  assert.deepEqual(hidden.all(), { 'claude-code': ['claude-opus-5'], codex: [], opencode: [] });
  assert.deepEqual(hidden.update('claude-code', { show: ['Claude-Opus-5'] }).removed, ['claude-opus-5']);
  assert.deepEqual(events, ['claude-code', 'opencode', 'opencode', 'claude-code']);
});

test('resolveHiddenModelId: provider inference, unlisted claude-* ids, unknown and ambiguous ids', async () => {
  const { catalog } = await catalogWith({});
  const rows = await catalog.manageRows();
  assert.deepEqual(resolveHiddenModelId({ id: 'gpt-5.5', rowsByProvider: rows }), { provider: 'codex', id: 'gpt-5.5' });
  assert.deepEqual(resolveHiddenModelId({ id: 'Opus 4.8', rowsByProvider: rows }), { provider: 'claude-code', id: 'claude-opus-4-8' }, 'labels resolve too');
  assert.deepEqual(resolveHiddenModelId({ id: 'deepseek-v4-pro', rowsByProvider: rows }), { provider: 'opencode', id: 'ollama-cloud/deepseek-v4-pro' });
  assert.deepEqual(resolveHiddenModelId({ id: 'claude-opus-4-1', rowsByProvider: rows }), { provider: 'claude-code', id: 'claude-opus-4-1' }, 'an unlisted claude-* id can be hidden');
  assert.throws(() => resolveHiddenModelId({ id: 'gpt-9-nope', rowsByProvider: rows }), (e) => e.code === 'MODEL_UNKNOWN' && Array.isArray(e.suggestions) && e.suggestions.length > 0);
  assert.deepEqual(resolveHiddenModelId({ id: 'gone-model', action: 'show', rowsByProvider: rows, hiddenByProvider: { codex: ['gone-model'] } }), { provider: 'codex', id: 'gone-model' });
});

// ── endpoint ─────────────────────────────────────────────────────────────────

async function startApp(t, { guest = false } = {}) {
  const dir = tempDir(t);
  const opencodeStore = createOpencodeHiddenModelsStore({ path: resolve(dir, 'opencode-hidden-models.json') });
  const hiddenModels = createHiddenModels({ file: resolve(dir, 'assistant-hidden-models.json'), opencodeStore });
  const catalog = createAssistantCatalog({ fetchJson: fakeFetch(OVERRIDES), claudePricing: PRICING, readHidden: () => hiddenModels.all() });
  hiddenModels.onChange(() => catalog.invalidate());
  const broadcasts = [];
  const app = express();
  app.use(express.json());
  app.use('/api/assistant/hidden-models', createAssistantHiddenModelsRouter({ hiddenModels, catalog, opencodeStore, isGuestRequest: () => guest, broadcastSync: (m) => broadcasts.push(m) }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api/assistant/hidden-models`;
  const call = async (method, body) => {
    const response = await fetch(base, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json() };
  };
  return { call, hiddenModels, opencodeStore, catalog, broadcasts };
}

test('endpoint: GET/PATCH with provider inference, OpenCode delegation, broadcasts only on change', async (t) => {
  const { call, opencodeStore, catalog, broadcasts } = await startApp(t);
  assert.deepEqual((await call('GET')).json.providers, { 'claude-code': [], codex: [], opencode: [] });
  const res = await call('PATCH', { hide: ['claude-opus-4-8', 'claude-opus-5', 'claude-fable-5', 'gpt-5.5', 'ollama-cloud/deepseek-v4-pro'] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.providers, { 'claude-code': ['claude-fable-5', 'claude-opus-4-8', 'claude-opus-5'], codex: ['gpt-5.5'], opencode: ['ollama-cloud/deepseek-v4-pro'] });
  assert.deepEqual(opencodeStore.list(), ['ollama-cloud/deepseek-v4-pro']);
  assert.deepEqual(broadcasts.map((b) => b.type), [ASSISTANT_HIDDEN_SYNC_TYPE, HIDDEN_MODELS_SYNC_TYPE]);
  const brief = await catalog.get({ view: 'brain' });
  assert.ok(!brief.models['claude-code'].some((r) => ['claude-opus-4-8', 'claude-opus-5', 'claude-fable-5'].includes(r.id)), 'the catalog was invalidated');
  assert.equal((await call('PATCH', { hide: ['gpt-5.5'] })).json.changed, false);
  assert.equal(broadcasts.length, 2, 'no broadcast without a change');
  const shown = await call('PATCH', { provider: 'codex', show: ['gpt-5.5'] });
  assert.deepEqual(shown.json.providers.codex, []);
  const unknown = await call('PATCH', { hide: ['gpt-9-nope'] });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.code, 'MODEL_UNKNOWN');
  assert.ok(unknown.json.suggestions.length > 0);
  assert.equal((await call('PATCH', { provider: 'nope', hide: ['x'] })).json.code, 'PROVIDER_INVALID');
  assert.equal((await call('PATCH', {})).status, 400);
});

test('endpoint: guests get 403', async (t) => {
  const { call } = await startApp(t, { guest: true });
  assert.equal((await call('GET')).status, 403);
  assert.equal((await call('PATCH', { hide: ['gpt-5.5'] })).status, 403);
});

// ── catalog, router and agent_catalog with the unwanted models hidden ───────

test('catalog: hidden Claude / Codex models leave the brain view, agent_catalog search and the manage view marks them', async () => {
  const { catalog, full } = await catalogWith(UNWANTED);
  for (const id of UNWANTED['claude-code']) assert.ok(!full.models['claude-code'].some((r) => r.id === id), id);
  assert.ok(!full.models.codex.some((r) => r.id === 'gpt-5.5'));
  assert.equal(full.listed['claude-code'], full.models['claude-code'].length + full.hiddenRows['claude-code'].length);
  assert.ok(full.listed['claude-code'] > CLAUDE_MODELS.models.length + OLD_CLAUDE.length, 'the 1M variants are rows of their own');
  const brief = await catalog.get({ view: 'brain' });
  assert.equal(brief.hiddenCount['claude-code'], 3);
  assert.equal(brief.hiddenCount.codex, 1);
  assert.equal(brief.hiddenRows, undefined);
  const search = await catalog.get({ provider: 'claude-code', q: 'opus' });
  const found = search.models['claude-code'].map((r) => r.id);
  assert.ok(['default', 'opus', 'opus[1m]'].every((id) => found.includes(id)), found.join());
  assert.ok(!found.some((id) => UNWANTED['claude-code'].includes(id)), 'hidden ids stay out');
  for (const id of UNWANTED['claude-code'].filter((x) => /opus/.test(x))) assert.ok(found.includes(`${id}[1m]`), `${id}[1m] stays: variants hide independently`);
  assert.equal((await catalog.get({ q: 'gpt-5.5' })).models.codex.length, 0);
  const manage = await catalog.get({ view: 'manage' });
  assert.equal(manage.models.codex.find((r) => r.id === 'gpt-5.5').hidden, true);
  assert.equal(manage.models.codex.find((r) => r.id === 'gpt-6-astra').hidden, false);
});

test('findModel / hiddenModelId: [1m], alias → resolved model, case, no unlisted bypass, all hidden → null', async () => {
  const { full } = await catalogWith({ 'claude-code': ['opus', 'claude-sonnet-5', ...UNWANTED['claude-code']], codex: ['GPT-5.5'] });
  assert.equal(findModel(full, 'claude-code', 'opus[1m]').row.id, 'opus[1m]', 'hiding opus leaves opus[1m]');
  assert.equal(findModel(full, 'claude-code', 'sonnet[1m]').row.id, 'sonnet[1m]', 'hiding claude-sonnet-5 leaves sonnet[1m]');
  assert.equal(findModel(full, 'claude-code', 'sonnet'), null, 'an alias resolving to a hidden model is hidden');
  assert.equal(findModel(full, 'claude-code', 'CLAUDE-OPUS-5'), null);
  assert.equal(findModel(full, 'claude-code', 'claude-opus-4-8'), null, 'no "unlisted" bypass for a hidden claude-* id');
  assert.equal(findModel(full, 'claude-code', 'claude-opus-4-1').match, 'unlisted', 'other unlisted ids still pass');
  assert.equal(findModel(full, 'codex', 'gpt-5.5'), null);
  assert.equal(hiddenModelId(full, 'codex', 'gpt-5.5'), 'GPT-5.5');
  assert.equal(findModel(full, 'claude-code', 'haiku').row.id, 'haiku');
  const { full: none } = await catalogWith({ codex: ['gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.5'] });
  assert.equal(none.models.codex.length, 0);
  assert.equal(findModel(none, 'codex', 'gpt-7-anything'), null, 'listed but all hidden is not "unverified"');
});

test('router: a proposal naming a hidden model is corrected (model_disabled); route options never offer one', async () => {
  const { full } = await catalogWith(UNWANTED);
  const routing = { preferences: {}, askBelow: 0.75 };
  for (const [provider, model] of [['claude-code', 'claude-opus-4-8'], ['claude-code', 'claude-opus-5'], ['codex', 'gpt-5.5']]) {
    const request = normalizeRouteRequest({ task_class: 'code', confidence: 0.95, proposals: [{ kind: 'dispatch', provider, model }] }, { brain: BRAIN });
    const never = evaluateRoute({ mode: 'never', routing, request, brain: BRAIN, catalog: full });
    assert.ok(never.reasons.includes('model_disabled'), model);
    assert.equal(never.corrections[0].reason, 'model_disabled');
    assert.notEqual(never.auto.model, model);
    const ask = evaluateRoute({ mode: 'ask-unsure', routing, request, brain: BRAIN, catalog: full });
    assert.equal(ask.ask, true);
    const { options } = buildRouteOptions({ request, evaluation: ask, brain: BRAIN, catalog: full, routing });
    assert.ok(options.filter((o) => !o.disabled).every((o) => ![...UNWANTED['claude-code'], ...UNWANTED.codex].includes(o.model)), 'only the suggestion itself shows, disabled');
    assert.match(options.find((o) => o.model === model).disabledReason, /Assistant's Models list/);
  }
  assert.throws(() => targetFromAnswer({ card: { options: [] }, response: { target: { provider: 'codex', model: 'gpt-5.5' } }, catalog: full, brain: BRAIN }), (e) => e.code === 'MODEL_DISABLED');
});

test('router: the "stronger" option skips hidden Claude rows', async () => {
  const { full } = await catalogWith({ 'claude-code': ['claude-opus-5-5', 'claude-fable-5-1', ...UNWANTED['claude-code']] });
  const request = normalizeRouteRequest({ task_class: 'code', confidence: 0.5, proposals: [{ kind: 'dispatch', provider: 'codex', model: 'gpt-6-astra' }] }, { brain: BRAIN });
  const evaluation = evaluateRoute({ mode: 'always-ask', routing: {}, request, brain: BRAIN, catalog: full });
  const { options } = buildRouteOptions({ request, evaluation, brain: BRAIN, catalog: full, routing: {} });
  const hidden = new Set(['opus', 'default', 'claude-fable-5-1', ...UNWANTED['claude-code']]);
  for (const option of options.filter((o) => o.provider === 'claude-code')) assert.ok(!hidden.has(option.model), option.model);
});

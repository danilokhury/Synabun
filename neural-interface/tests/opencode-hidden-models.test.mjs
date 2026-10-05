import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import express from 'express';
import {
  createOpencodeHiddenModelsRouter, createOpencodeHiddenModelsStore, normalizeHiddenModels, HIDDEN_MODELS_SYNC_TYPE,
} from '../lib/opencode-hidden-models.js';
import { createAssistantCatalog, findModel, hiddenModelId, selectSheetModels } from '../lib/assistant-catalog.js';
import { buildRouteOptions, escalationFor, evaluateRoute, normalizeRouteRequest, targetFromAnswer } from '../lib/assistant-router.js';
import { effectiveRouting } from '../lib/assistant-config.js';
import { PRICING, fakeFetch } from './assistant-catalog.fixtures.mjs';

const PRO = 'ollama-cloud/deepseek-v4-pro';
const FLASH = 'ollama-cloud/deepseek-v4.1-flash';
const ALL_OPENCODE = [FLASH, PRO, 'ollama-cloud/deepseek-v4-flash', 'zai-coding-plan/glm-5.2', 'legacy/vis-1'];
const BRAIN = { provider: 'opencode', model: FLASH, effort: null };

function tempDir(t) {
  const dir = mkdtempSync(resolve(tmpdir(), 'synabun-hidden-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function catalogWith(hidden, overrides = {}) {
  const catalog = createAssistantCatalog({ fetchJson: fakeFetch(overrides), claudePricing: PRICING, readHidden: () => hidden });
  return { catalog, full: await catalog.full() };
}

// ── store ────────────────────────────────────────────────────────────────────

test('normalizeHiddenModels keeps unique sorted provider/model ids only', () => {
  assert.deepEqual(normalizeHiddenModels(['b/y', 'a/x', 'a/x', ' c/z ', 'bare', '/lead', 'trail/', 7, null]), ['a/x', 'b/y', 'c/z']);
  assert.deepEqual(normalizeHiddenModels('a/x'), []);
});

test('store: never written → initialized false; set persists, bumps the version, reports changes and re-reads hand edits', (t) => {
  const path = resolve(tempDir(t), 'data', 'opencode-hidden-models.json');
  const store = createOpencodeHiddenModelsStore({ path, now: () => Date.parse('2026-09-25T10:00:00Z') });
  assert.deepEqual(store.read(), { models: [], initialized: false, version: 0, updatedAt: null });
  const seen = [];
  store.onChange((value, meta) => seen.push([value.models, meta.changed]));
  const first = store.set([PRO, FLASH]);
  assert.deepEqual(first.models, [PRO, FLASH].sort());
  assert.equal(first.initialized, true);
  assert.equal(first.version, 1);
  assert.equal(first.changed, true);
  assert.equal(store.has(PRO), true);
  assert.equal(store.set([FLASH, PRO]).changed, false, 'same set in another order is no change');
  assert.deepEqual(seen.map(([, changed]) => changed), [true, false]);
  // A second process (or a hand edit) sees the file.
  assert.deepEqual(createOpencodeHiddenModelsStore({ path }).list(), [PRO, FLASH].sort());
  writeFileSync(path, JSON.stringify({ models: ['zai-coding-plan/glm-5.2'], version: 9 }));
  utimesSync(path, new Date(), new Date(Date.now() + 5000));
  assert.deepEqual(store.list(), ['zai-coding-plan/glm-5.2']);
  assert.equal(store.read().version, 9);
  // An empty list is still a written (initialized) store: migration never runs again.
  const cleared = store.set([]);
  assert.deepEqual(cleared.models, []);
  assert.equal(cleared.initialized, true);
  assert.throws(() => store.set('nope'), (error) => error.code === 'HIDDEN_MODELS_INVALID' && error.status === 400);
});

// ── endpoint ─────────────────────────────────────────────────────────────────

async function startApp(t, { guest = false } = {}) {
  const store = createOpencodeHiddenModelsStore({ path: resolve(tempDir(t), 'opencode-hidden-models.json') });
  const broadcasts = [];
  const app = express();
  app.use(express.json());
  app.use('/api/opencode/hidden-models', createOpencodeHiddenModelsRouter({ store, isGuestRequest: () => guest, broadcastSync: (m) => broadcasts.push(m) }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api/opencode/hidden-models`;
  const call = async (method, body) => {
    const response = await fetch(base, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, json: await response.json() };
  };
  return { call, store, broadcasts };
}

test('endpoint: GET/PUT the list, broadcast only on change, one-time migration, bad bodies refused', async (t) => {
  const { call, store, broadcasts } = await startApp(t);
  const empty = await call('GET');
  assert.equal(empty.status, 200);
  assert.deepEqual({ models: empty.json.models, initialized: empty.json.initialized }, { models: [], initialized: false });

  // A window holding pre-server localStorage choices migrates them once.
  const migrated = await call('PUT', { models: [PRO], migrate: true });
  assert.equal(migrated.status, 200);
  assert.equal(migrated.json.migrated, true);
  assert.deepEqual(migrated.json.models, [PRO]);
  assert.deepEqual(broadcasts, [{ type: HIDDEN_MODELS_SYNC_TYPE, models: [PRO], version: 1 }]);
  // A second window's stale local list never overwrites the server copy.
  const late = await call('PUT', { models: [FLASH], migrate: true });
  assert.equal(late.json.migrated, false);
  assert.deepEqual(late.json.models, [PRO]);
  assert.deepEqual(store.list(), [PRO]);
  assert.equal(broadcasts.length, 1);

  // A regular save replaces the list; the same list again is no broadcast.
  const saved = await call('PUT', { models: [PRO, FLASH] });
  assert.equal(saved.json.changed, true);
  assert.equal(broadcasts.length, 2);
  await call('PUT', { models: [FLASH, PRO] });
  assert.equal(broadcasts.length, 2);
  assert.deepEqual((await call('GET')).json.models, [PRO, FLASH].sort());

  const bad = await call('PUT', { models: 'x' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'HIDDEN_MODELS_INVALID');
});

test('endpoint: guests may read but not write', async (t) => {
  const { call, store } = await startApp(t, { guest: true });
  assert.equal((await call('GET')).status, 200);
  const refused = await call('PUT', { models: [PRO] });
  assert.equal(refused.status, 403);
  assert.deepEqual(store.list(), []);
});

// ── catalog ──────────────────────────────────────────────────────────────────

test('catalog: hidden OpenCode models leave the rows, the total, the sheet, the brain view and search', async () => {
  const { catalog, full } = await catalogWith([PRO, 'legacy/vis-1']);
  const ids = full.models.opencode.map((row) => row.id);
  assert.ok(!ids.includes(PRO) && !ids.includes('legacy/vis-1'));
  assert.equal(full.opencodeTotal, 3);
  assert.equal(full.opencodeListed, 5, 'the list itself was available');
  assert.deepEqual(full.opencodeHidden, [PRO, 'legacy/vis-1']);
  const sheet = selectSheetModels(full, { brain: { provider: 'opencode', model: PRO }, preferences: { code: { provider: 'opencode', model: PRO } } });
  assert.ok(!sheet.opencode.some((row) => row.id === PRO), 'a pinned brain/preference model that is hidden stays off the sheet');
  const brief = await catalog.get({ view: 'brain' });
  assert.equal(brief.opencodeHidden, undefined, 'the brain gets a count, not the list');
  assert.equal(brief.opencodeHiddenCount, 2);
  assert.ok(!brief.models.opencode.some((row) => row.id === PRO));
  const search = await catalog.get({ provider: 'opencode', q: 'pro' });
  assert.deepEqual(search.models.opencode, []);
  assert.equal(catalog.find('opencode', PRO), null);
  const info = catalog.brainInfo({ provider: 'opencode', model: PRO });
  assert.equal(info.source, 'disabled');
  assert.equal(info.vision, null);
});

test('catalog: invalidate() re-reads the hidden set', async () => {
  let hidden = [];
  const catalog = createAssistantCatalog({ fetchJson: fakeFetch(), claudePricing: PRICING, readHidden: () => hidden });
  assert.equal((await catalog.full()).opencodeTotal, 5);
  hidden = [PRO];
  assert.equal((await catalog.full()).opencodeTotal, 5, 'cached within the TTL');
  catalog.invalidate();
  assert.equal((await catalog.full()).opencodeTotal, 4);
});

test('findModel: hidden ids are unknown; all hidden is not "unverified"; only a missing list is', async () => {
  const { full } = await catalogWith([PRO]);
  assert.equal(findModel(full, 'opencode', PRO), null);
  assert.equal(findModel(full, 'opencode', 'deepseek-v4-pro'), null, 'bare id of a hidden model');
  assert.equal(findModel(full, 'opencode', FLASH).match, 'exact');
  assert.equal(hiddenModelId(full, 'opencode', 'DeepSeek-V4-Pro'), PRO);
  assert.equal(hiddenModelId(full, 'codex', PRO), null);

  const all = (await catalogWith(ALL_OPENCODE)).full;
  assert.deepEqual(all.models.opencode, []);
  assert.equal(all.opencodeTotal, 0);
  assert.equal(findModel(all, 'opencode', PRO), null, 'every model disabled: nothing is accepted');
  assert.equal(findModel(all, 'opencode', 'someone/else'), null, 'not even an id the list never had');

  const down = { ok: false, error: 'OpenCode server not running', data: {} };
  const offline = (await catalogWith([PRO], { '/api/opencode/providers/full': down })).full;
  assert.equal(offline.opencodeListed, 0);
  assert.deepEqual(findModel(offline, 'opencode', 'someone/else'), { row: null, match: 'unverified' }, 'OpenCode down: cannot check');
  assert.equal(findModel(offline, 'opencode', PRO), null, 'a hidden id is refused even while OpenCode is down');
});

// ── router ───────────────────────────────────────────────────────────────────

test('evaluateRoute: a hidden model is corrected (never) or asked about (ask-unsure) as model_disabled', async () => {
  const { full } = await catalogWith([PRO]);
  const req = normalizeRouteRequest({ task_class: 'code', confidence: 0.95, proposals: [{ kind: 'dispatch', provider: 'opencode', model: PRO }] }, { brain: BRAIN });
  const never = evaluateRoute({ mode: 'never', routing: effectiveRouting({}), request: req, brain: BRAIN, catalog: full });
  assert.equal(never.ask, false);
  assert.ok(never.reasons.includes('model_disabled'));
  assert.equal(never.auto.model, null, 'falls back to the provider default');
  assert.deepEqual(never.corrections[0], { field: 'model', from: PRO, to: null, reason: 'model_disabled' });
  const unsure = evaluateRoute({ mode: 'ask-unsure', routing: effectiveRouting({}), request: req, brain: BRAIN, catalog: full });
  assert.equal(unsure.ask, true);
  assert.deepEqual(unsure.reasons, ['model_disabled']);
});

test('evaluateRoute: a remembered route onto a hidden model is not applied', async () => {
  const { full } = await catalogWith([PRO]);
  const routing = effectiveRouting({ preferences: { code: { kind: 'dispatch', provider: 'opencode', model: PRO } } });
  const req = normalizeRouteRequest({ task_class: 'code', confidence: 0.95, proposals: [{ kind: 'dispatch', provider: 'opencode' }] }, { brain: BRAIN });
  const never = evaluateRoute({ mode: 'never', routing, request: req, brain: BRAIN, catalog: full });
  assert.notEqual(never.source, 'remembered');
  assert.equal(never.auto.model, null);
  assert.deepEqual(never.corrections, [{ field: 'model', from: PRO, to: null, reason: 'model_disabled' }]);
  const unsure = evaluateRoute({ mode: 'ask-unsure', routing, request: req, brain: BRAIN, catalog: full });
  assert.equal(unsure.ask, true);
  assert.ok(unsure.reasons.includes('model_disabled'));
  // Visible again → the remembered route applies as before.
  const visible = (await catalogWith([])).full;
  assert.equal(evaluateRoute({ mode: 'never', routing, request: req, brain: BRAIN, catalog: visible }).auto.model, PRO);
});

test('route card: a hidden suggestion is a disabled option, the default skips it, and picking it is refused', async () => {
  const { full } = await catalogWith([PRO]);
  const routing = effectiveRouting({ preferences: { code: { kind: 'dispatch', provider: 'opencode', model: PRO } } });
  const req = normalizeRouteRequest({ task_class: 'code', confidence: 0.95, proposals: [{ kind: 'dispatch', provider: 'opencode', model: PRO }] }, { brain: BRAIN });
  const evaluation = evaluateRoute({ mode: 'always-ask', routing, request: req, brain: BRAIN, catalog: full });
  const { options, defaultOptionId } = buildRouteOptions({ request: req, evaluation, brain: BRAIN, catalog: full, routing });
  const suggested = options.find((o) => o.badge === 'suggested');
  assert.equal(suggested.model, PRO);
  assert.equal(suggested.disabled, true);
  assert.match(suggested.disabledReason, /Assistant's Models list/);
  assert.notEqual(defaultOptionId, suggested.id);
  assert.ok(!options.some((o) => o.badge === 'remembered'), 'the hidden remembered route is not offered');
  assert.ok(!options.some((o) => !o.disabled && o.model === PRO));
  const card = { options };
  assert.throws(() => targetFromAnswer({ card, response: { optionId: suggested.id }, catalog: full, brain: BRAIN }), /Assistant's Models list/);
  assert.throws(
    () => targetFromAnswer({ card, response: { optionId: 'other', target: { provider: 'opencode', model: PRO } }, catalog: full, brain: BRAIN }),
    (error) => error.code === 'MODEL_DISABLED' && /disabled in the Assistant's Models list/.test(error.message),
  );
});

test('escalationFor: ladder rungs, remembered complex routes and transient retries skip hidden models', async () => {
  const { full } = await catalogWith([PRO]);
  const failed = { provider: 'opencode', model: FLASH, state: 'failed', completionReason: 'provider_error' };
  const ladder = effectiveRouting({ ladders: { opencode: [FLASH, PRO, 'zai-coding-plan/glm-5.2'] } });
  assert.equal(escalationFor({ run: failed, catalog: full, routing: ladder }).to.model, 'zai-coding-plan/glm-5.2', 'the hidden rung is skipped');
  const onlyHidden = effectiveRouting({ ladders: { opencode: [FLASH, PRO] }, preferences: { complex: { provider: 'opencode', model: PRO } } });
  const next = escalationFor({ run: failed, catalog: full, routing: onlyHidden });
  assert.notEqual(next?.to?.model, PRO);
  const transient = { provider: 'opencode', model: PRO, state: 'failed', completionReason: 'provider_error', failure: { cause: 'transient' } };
  const retry = escalationFor({ run: transient, catalog: full, routing: effectiveRouting({}) });
  assert.notEqual(retry?.kind, 'retry', 'no retry on a model the user disabled since');
  assert.notEqual(retry?.to?.model, PRO);
});

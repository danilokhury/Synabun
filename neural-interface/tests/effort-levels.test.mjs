import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import express from 'express';
import {
  codexReasoningEffort, effortLabel, modelEfforts, normalizeEffort, repairPreferenceEfforts, sortEfforts,
} from '../lib/effort-levels.js';
import { createAssistantCatalog, parseOpenCodeProviders, withClaudeContextVariants, normalizeClaudeRows } from '../lib/assistant-catalog.js';
import { evaluateRoute, targetFromAnswer, escalationFor } from '../lib/assistant-router.js';
import { buildAssistantPersona } from '../lib/assistant-persona.js';
import { createAssistantApi } from '../lib/assistant-api.js';
import { createAssistantConfigStore } from '../lib/assistant-config.js';
import { TASK_CLASS_META } from '../lib/assistant-router.js';
import { PRICING, fakeFetch } from './assistant-catalog.fixtures.mjs';

process.env.SYNABUN_TYPESAFE = 'off';

async function fixtureCatalog() {
  return createAssistantCatalog({ fetchJson: fakeFetch(), claudePricing: PRICING }).full();
}

test('one vocabulary: canonical order, labels, thinking just above none', () => {
  assert.deepEqual(sortEfforts(['max', 'low', 'ultra', 'xhigh', 'off', 'none', 'thinking', 'minimal', 'medium', 'high', 'turbo', 'low']),
    ['none', 'thinking', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'turbo']);
  assert.equal(effortLabel('xhigh'), 'XHigh');
  assert.equal(effortLabel('minimal'), 'Min');
  assert.equal(effortLabel('deep-think'), 'Deep Think');
});

test('modelEfforts reads every row shape; [] = none, null = unknown', () => {
  assert.deepEqual(modelEfforts({ efforts: ['high', 'low'] }), ['low', 'high']);
  assert.deepEqual(modelEfforts({ effortLevels: [] }), []);
  assert.deepEqual(modelEfforts({ supportedReasoningEfforts: [{ reasoningEffort: 'max' }, { effort: 'low' }, 'ultra'] }), ['low', 'max', 'ultra']);
  assert.deepEqual(modelEfforts({ variants: { max: {}, low: {}, high: { disabled: true }, thinking: {} } }), ['thinking', 'low', 'max']);
  assert.equal(modelEfforts({ id: 'x' }), null);
  assert.equal(modelEfforts(null), null);
});

test('OpenCode catalog rows list enabled variants in canonical order', () => {
  const rows = parseOpenCodeProviders({ all: [{ id: 'zai', models: { 'glm-5.3-flash': { variants: { max: {}, low: {}, high: {}, xhigh: { disabled: true } } }, plain: {} } }], connected: ['zai'] });
  assert.deepEqual(rows.find((r) => r.id === 'zai/glm-5.3-flash').efforts, ['low', 'high', 'max']);
  assert.deepEqual(rows.find((r) => r.id === 'zai/plain').efforts, []);
});

test('normalizeEffort: supported / unsupported / clamp / off / no efforts / unknown', async () => {
  const catalog = await fixtureCatalog();
  const check = (provider, model, effort) => normalizeEffort({ provider, model, effort, catalog });
  assert.deepEqual(check('claude-code', 'opus', 'max'), { effort: 'max', corrected: null });
  // Sonnet runs low/medium/high: xhigh → the highest level below it.
  assert.deepEqual(check('claude-code', 'sonnet', 'xhigh'), { effort: 'high', corrected: { from: 'xhigh', to: 'high' } });
  // Below every level → the lowest (minimal → low).
  assert.deepEqual(check('codex', 'gpt-6-astra', 'minimal'), { effort: 'low', corrected: { from: 'minimal', to: 'low' } });
  assert.deepEqual(check('codex', 'gpt-6-astra', 'ultra'), { effort: 'high', corrected: { from: 'ultra', to: 'high' } });
  for (const off of ['off', 'default', 'auto', '', null]) assert.deepEqual(check('codex', 'gpt-6-astra', off), { effort: null, corrected: null });
  // Haiku has no efforts.
  assert.deepEqual(check('claude-code', 'haiku', 'high'), { effort: null, corrected: { from: 'high', to: null } });
  // OpenCode variants.
  assert.equal(check('opencode', 'ollama-cloud/deepseek-v4.1-flash', 'max').effort, 'max');
  assert.equal(check('opencode', 'ollama-cloud/deepseek-v4.1-flash', 'medium').effort, 'low');
  // Unknown model or unverified catalog: passed through unchanged.
  assert.deepEqual(check('codex', 'gpt-9-imaginary', 'ultra'), { effort: 'ultra', corrected: null });
  assert.deepEqual(normalizeEffort({ provider: 'codex', model: 'gpt-6-astra', effort: 'ultra', catalog: { models: {} } }), { effort: 'ultra', corrected: null });
  assert.deepEqual(normalizeEffort({ provider: 'codex', model: 'gpt-6-astra', effort: 'ultra', catalog: null }), { effort: 'ultra', corrected: null });
  // No model = the provider default row (Opus 5.5 for Claude).
  assert.equal(check('claude-code', null, 'max').effort, 'max');
});

test('normalizeEffort resolves [1m] and [extended] ids to their rows', () => {
  const claude = withClaudeContextVariants(normalizeClaudeRows([{ id: 'opus', resolvedModel: 'claude-opus-5-5', contextWindow: 200000, effortLevels: ['low', 'medium', 'high'] }]));
  const catalog = {
    models: {
      'claude-code': claude,
      codex: [{ provider: 'codex', id: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }, { provider: 'codex', id: 'gpt-6-luna[extended]', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }],
    },
  };
  assert.ok(claude.some((row) => row.id === 'opus[1m]'), 'fixture has a 1M row');
  assert.equal(normalizeEffort({ provider: 'claude-code', model: 'opus[1m]', effort: 'max', catalog }).effort, 'high');
  assert.equal(normalizeEffort({ provider: 'codex', model: 'gpt-6-luna[extended]', effort: 'ultra', catalog }).effort, 'max');
  // An [extended] id without its own row falls back to the base row.
  const baseOnly = { models: { codex: [catalog.models.codex[0]] } };
  assert.equal(normalizeEffort({ provider: 'codex', model: 'gpt-6-luna[extended]', effort: 'ultra', catalog: baseOnly }).effort, 'max');
});

test('Codex workers get every level unchanged: max stays max, ultra reaches the CLI', () => {
  for (const level of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) assert.equal(codexReasoningEffort(level), level);
  assert.equal(codexReasoningEffort('MAX'), 'max');
  assert.equal(codexReasoningEffort('off'), undefined);
  assert.equal(codexReasoningEffort(''), undefined);
  assert.equal(codexReasoningEffort('turbo'), undefined);
});

test('saved preferences are repaired once, idempotently; unverified providers are left alone', async () => {
  const catalog = await fixtureCatalog();
  const prefs = {
    chat: { kind: 'direct', provider: 'codex', model: 'gpt-6-astra', effort: 'minimal' },
    code: { kind: 'dispatch', provider: 'claude-code', model: 'opus', effort: 'xhigh' },
  };
  const { fixes, unverified } = repairPreferenceEfforts(prefs, catalog);
  assert.equal(unverified, false);
  assert.deepEqual(fixes.map((f) => [f.key, f.from, f.to]), [['chat', 'minimal', 'low']]);
  assert.equal(repairPreferenceEfforts({ chat: fixes[0].target }, catalog).fixes.length, 0, 'idempotent');
  const empty = repairPreferenceEfforts(prefs, { models: { codex: [], 'claude-code': [] } });
  assert.deepEqual(empty, { fixes: [], unverified: true });
});

test('router: an unsupported effort is corrected and reported; a model correction re-checks the effort', async () => {
  const catalog = await fixtureCatalog();
  const brain = { provider: 'claude-code', model: 'opus' };
  const request = (proposal) => ({ taskClass: 'code', summary: 's', confidence: 0.95, needsVision: false, proposals: [{ kind: 'dispatch', reason: null, ...proposal }] });
  const ok = evaluateRoute({ mode: 'never', routing: {}, request: request({ provider: 'claude-code', model: 'sonnet', effort: 'max' }), brain, catalog });
  assert.equal(ok.auto.effort, 'high');
  assert.deepEqual(ok.corrections, [{ field: 'effort', from: 'max', to: 'high', reason: 'effort_unsupported' }]);
  assert.equal(ok.source, 'corrected');
  // ask-unsure without asking also reports it.
  const unsure = evaluateRoute({ mode: 'ask-unsure', routing: {}, request: request({ provider: 'codex', model: 'gpt-6-astra', effort: 'minimal' }), brain, catalog });
  assert.equal(unsure.ask, false);
  assert.equal(unsure.auto.effort, 'low');
  assert.equal(unsure.corrections[0].field, 'effort');
  // An unknown model is corrected to the provider default, whose levels decide the effort.
  const fixed = evaluateRoute({ mode: 'never', routing: {}, request: request({ provider: 'claude-code', model: 'opus-imaginary-9', effort: 'ultra' }), brain, catalog });
  assert.ok(fixed.corrections.some((c) => c.field === 'model'));
  assert.equal(fixed.auto.effort, 'max', 'the default model (Opus 5.5) runs up to max');
  // A card answer is checked too.
  const answer = targetFromAnswer({ card: { options: [] }, response: { optionId: 'other', target: { provider: 'claude-code', model: 'haiku', effort: 'high' } }, catalog, brain });
  assert.equal(answer.target.effort, null);
  assert.deepEqual(answer.corrections, [{ field: 'effort', from: 'high', to: null, reason: 'effort_unsupported' }]);
  // Escalation targets carry a level their model runs.
  const retry = escalationFor({ run: { provider: 'claude-code', model: 'sonnet', effort: 'max', state: 'failed', completionReason: 'provider_error', failure: { cause: 'transient' } }, catalog, routing: {} });
  assert.equal(retry.kind, 'retry');
  assert.equal(retry.to.effort, 'high');
});

test('PUT /routing normalizes preference efforts against the catalog and reports the correction', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-effort-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configStore = createAssistantConfigStore({ path: resolve(root, 'assistant-config.json') });
  const catalog = createAssistantCatalog({ fetchJson: fakeFetch(), claudePricing: PRICING });
  const app = express();
  app.use(express.json());
  app.use('/api/assistant', createAssistantApi({
    dispatcher: { limits: {}, get: () => null, list: () => [], totals: () => ({}) },
    assistantRouter: { routing: () => configStore.routing() }, configStore, catalog, taskClasses: TASK_CLASS_META, broadcastSync: () => {},
  }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/assistant/routing`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routing: { preferences: { chat: { kind: 'direct', provider: 'codex', model: 'gpt-6-astra', effort: 'minimal' }, code: { kind: 'dispatch', provider: 'claude-code', model: 'opus', effort: 'max' } } } }),
  });
  const json = await response.json();
  assert.equal(response.status, 200);
  assert.equal(json.routing.preferences.chat.effort, 'low');
  assert.equal(json.routing.preferences.code.effort, 'max');
  assert.deepEqual(json.corrections, [{ key: 'chat', field: 'effort', from: 'minimal', to: 'low', reason: 'effort_unsupported' }]);
});

test('persona: no fixed Codex effort list; efforts are per model', async () => {
  const catalog = await fixtureCatalog();
  const text = buildAssistantPersona({ brain: { provider: 'claude-code', model: 'opus' }, catalog, sheet: {} });
  assert.doesNotMatch(text, /minimal\|low\|medium\|high\|xhigh/);
  assert.doesNotMatch(text, /efforts low\|medium\|high\|xhigh\|max/);
  assert.match(text, /efforts: per model — see the routing sheet/);
});

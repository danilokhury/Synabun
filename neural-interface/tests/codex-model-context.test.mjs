import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expectedEffectiveContextWindow,
  mergeCodexModelContextCapabilities,
  normalizeCodexContextCapability,
  resolveCodexExtendedContext,
} from '../lib/codex-model-context.js';

const APP_SERVER_MODELS = [
  { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', isDefault: true },
  { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', isDefault: false },
  { id: 'gpt-5.5', displayName: 'GPT-5.5', isDefault: false },
];

const RUNTIME_CATALOG = {
  fetched_at: '2026-08-20T05:42:03.644983Z',
  models: [
    {
      slug: 'gpt-5.6-sol',
      context_window: 272000,
      max_context_window: 872000,
      effective_context_window_percent: 95,
    },
    {
      slug: 'gpt-5.6-terra',
      context_window: '272000',
      max_context_window: '872000',
      effective_context_window_percent: '95',
    },
    {
      slug: 'not-available-to-this-account',
      context_window: 1000000,
      max_context_window: 2000000,
      effective_context_window_percent: 100,
    },
  ],
};

test('normalizes snake_case runtime context metadata', () => {
  assert.deepEqual(normalizeCodexContextCapability(RUNTIME_CATALOG.models[0]), {
    id: 'gpt-5.6-sol',
    contextWindow: 272000,
    maxContextWindow: 872000,
    effectiveContextWindowPercent: 95,
  });
});

test('merges runtime capabilities only into app-server models available to the account', () => {
  const merged = mergeCodexModelContextCapabilities(APP_SERVER_MODELS, RUNTIME_CATALOG);
  assert.deepEqual(merged.map((model) => model.id), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.5',
  ]);
  assert.equal(merged.some((model) => model.id === 'not-available-to-this-account'), false);
  assert.deepEqual(merged[0], {
    ...APP_SERVER_MODELS[0],
    contextWindow: 272000,
    maxContextWindow: 872000,
    effectiveContextWindowPercent: 95,
    expectedEffectiveContextWindow: 828400,
    supportsExtendedContext: true,
  });
  assert.equal(merged[2].supportsExtendedContext, false);
});

test('future app-server metadata takes precedence over the runtime catalog', () => {
  const [merged] = mergeCodexModelContextCapabilities([{
    id: 'gpt-5.6-sol',
    contextWindow: 300000,
    maxContextWindow: 900000,
    effectiveContextWindowPercent: 90,
  }], RUNTIME_CATALOG);
  assert.equal(merged.contextWindow, 300000);
  assert.equal(merged.maxContextWindow, 900000);
  assert.equal(merged.effectiveContextWindowPercent, 90);
  assert.equal(merged.expectedEffectiveContextWindow, 810000);
});

test('effective context is derived only when a valid runtime percentage exists', () => {
  assert.equal(expectedEffectiveContextWindow(872000, 95), 828400);
  assert.equal(expectedEffectiveContextWindow(872000, undefined), null);
  assert.equal(expectedEffectiveContextWindow(872000, 0), null);
  assert.equal(expectedEffectiveContextWindow(872000, 101), null);
});

test('extended mode resolves the selected available model to a thread-only context config', () => {
  const models = mergeCodexModelContextCapabilities(APP_SERVER_MODELS, RUNTIME_CATALOG);
  const resolved = resolveCodexExtendedContext({
    models,
    selectedModel: 'GPT-5.6-TERRA',
    contextMode: 'extended',
  });
  assert.deepEqual(resolved, {
    contextMode: 'extended',
    applied: true,
    model: 'gpt-5.6-terra',
    config: { model_context_window: 872000 },
    requestedContextWindow: 872000,
    expectedEffectiveContextWindow: 828400,
    reason: null,
  });
  assert.deepEqual(Object.keys(resolved.config), ['model_context_window']);
  assert.equal('model_auto_compact_token_limit' in resolved.config, false);
});

test('blank selection resolves only an explicit app-server default model', () => {
  const models = mergeCodexModelContextCapabilities(APP_SERVER_MODELS, RUNTIME_CATALOG);
  assert.equal(resolveCodexExtendedContext({
    models,
    contextMode: 'extended',
  }).model, 'gpt-5.6-sol');

  const withoutDefault = models.map(({ isDefault: _isDefault, ...model }) => model);
  assert.deepEqual(resolveCodexExtendedContext({
    models: withoutDefault,
    contextMode: 'extended',
  }), {
    contextMode: 'extended',
    applied: false,
    model: null,
    config: null,
    requestedContextWindow: null,
    expectedEffectiveContextWindow: null,
    reason: 'model-unavailable',
  });
});

test('extended mode fails closed for unknown, unsupported, and inconsistent models', () => {
  const models = mergeCodexModelContextCapabilities(APP_SERVER_MODELS, RUNTIME_CATALOG);
  assert.equal(resolveCodexExtendedContext({
    models,
    selectedModel: 'not-available-to-this-account',
    contextMode: 'extended',
  }).reason, 'model-unavailable');
  assert.equal(resolveCodexExtendedContext({
    models,
    selectedModel: 'gpt-5.5',
    contextMode: 'extended',
  }).reason, 'extended-context-unavailable');

  const [inconsistent] = mergeCodexModelContextCapabilities(
    [{ id: 'gpt-bad', contextWindow: 900000 }],
    [{ slug: 'gpt-bad', max_context_window: 800000 }],
  );
  assert.equal(inconsistent.maxContextWindow, null);
  assert.equal(resolveCodexExtendedContext({
    models: [inconsistent],
    selectedModel: 'gpt-bad',
    contextMode: 'extended',
  }).applied, false);
});

test('default and invalid modes never emit a context override', () => {
  const models = mergeCodexModelContextCapabilities(APP_SERVER_MODELS, RUNTIME_CATALOG);
  for (const contextMode of ['default', 'unexpected', null]) {
    const resolved = resolveCodexExtendedContext({
      models,
      selectedModel: 'gpt-5.6-sol',
      contextMode,
    });
    assert.equal(resolved.contextMode, 'default');
    assert.equal(resolved.applied, false);
    assert.equal(resolved.config, null);
    assert.equal(resolved.reason, 'default-context');
  }
});

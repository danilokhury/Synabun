// Context-window variants in the Assistant's Models list: every selectable
// window is its own catalog row ("opus" / "opus[1m]", "gpt-x" / "gpt-x[extended]")
// and each hides on its own; the manage view lists archived ids, "not listed" too.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalModelId, claudeSupportsOneMillion, contextLabel, createAssistantCatalog, findModel, hiddenModelId,
  normalizeClaudeRows, normalizeCodexRows, withClaudeContextVariants,
} from '../lib/assistant-catalog.js';
import { resolveHiddenModelId } from '../lib/assistant-hidden-models.js';
import { evaluateRoute, normalizeRouteRequest } from '../lib/assistant-router.js';
import { parseSlashCommand } from '../public/shared/assistant/asst-slash.js';
import { CLAUDE_MODELS, PRICING, fakeFetch } from './assistant-catalog.fixtures.mjs';

const CODEX = {
  ok: true,
  models: [
    { id: 'gpt-6-sol', model: 'gpt-6-sol', displayName: 'GPT-6-Sol', isDefault: true, contextWindow: 272000, maxContextWindow: 872000 },
    { id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5', contextWindow: 272000, maxContextWindow: 272000 },
  ],
};
const BRAIN = { provider: 'claude-code', model: 'sonnet', effort: null };

async function catalogWith(hidden) {
  const catalog = createAssistantCatalog({ fetchJson: fakeFetch({ '/api/codex/models': CODEX }), claudePricing: PRICING, readHidden: () => hidden });
  return { catalog, full: await catalog.full() };
}
const ids = (rows) => rows.map((r) => r.id);

test('variant rows: a 1M sibling per 1M-capable Claude model, an [extended] row per Codex model with a larger max window', () => {
  const claude = withClaudeContextVariants(normalizeClaudeRows(CLAUDE_MODELS.models, { pricing: PRICING }));
  const list = ids(claude);
  assert.ok(list.includes('opus') && list.includes('opus[1m]'));
  assert.equal(list.indexOf('opus[1m]'), list.indexOf('opus') + 1, 'right after its base row');
  assert.ok(!list.includes('default[1m]'), 'default has no 1M form');
  assert.ok(!list.some((id) => /haiku.*\[1m\]/.test(id)), 'Haiku has no 1M window');
  const oneM = claude.find((r) => r.id === 'opus[1m]');
  assert.equal(oneM.contextWindow, 1_000_000);
  assert.match(oneM.label, /1M context/);
  assert.equal(contextLabel(oneM), '1M');
  assert.equal(contextLabel(claude.find((r) => r.id === 'opus')), '200k');
  const listed = withClaudeContextVariants([{ id: 'opus', upstream: 'claude-opus-5-5', label: 'Opus' }, { id: 'opus[1m]', upstream: 'claude-opus-5-5', label: 'Opus (1M context)' }]);
  assert.deepEqual(ids(listed), ['opus', 'opus[1m]'], 'a [1m] id the CLI lists is not duplicated');
  assert.equal(claudeSupportsOneMillion('claude-opus-4-6'), true);
  assert.equal(claudeSupportsOneMillion('claude-opus-4-1-20250805'), false);
  assert.equal(claudeSupportsOneMillion('claude-haiku-4-5-20251001'), false);
  const codex = normalizeCodexRows(CODEX.models);
  assert.deepEqual(ids(codex), ['gpt-6-sol', 'gpt-6-sol[extended]', 'gpt-5.5']);
  const extended = codex[1];
  assert.equal(extended.contextWindow, 872000);
  assert.equal(extended.isDefault, false);
  assert.equal(extended.upstream, 'gpt-6-sol');
  assert.equal(contextLabel(extended), 'extended 872k');
  assert.equal(contextLabel(codex[0]), '272k');
  assert.equal(canonicalModelId('claude-code', 'claude-opus-4-6:1000000'), 'claude-opus-4-6[1m]');
  assert.equal(canonicalModelId('claude-code', 'claude-opus-4-6:200000'), 'claude-opus-4-6');
});

test('independent hiding: opus vs opus[1m], gpt base vs [extended], in both directions', async () => {
  let { full } = await catalogWith({ 'claude-code': ['opus'], codex: ['gpt-6-sol'] });
  assert.equal(findModel(full, 'claude-code', 'opus'), null);
  assert.equal(findModel(full, 'claude-code', 'opus[1m]').row.id, 'opus[1m]');
  assert.equal(findModel(full, 'codex', 'gpt-6-sol'), null);
  assert.equal(findModel(full, 'codex', 'gpt-6-sol[extended]').row.contextWindow, 872000);
  ({ full } = await catalogWith({ 'claude-code': ['opus[1m]'], codex: ['gpt-6-sol[extended]'] }));
  assert.equal(findModel(full, 'claude-code', 'opus[1m]'), null);
  assert.equal(findModel(full, 'claude-code', 'opus').row.id, 'opus');
  assert.equal(findModel(full, 'codex', 'gpt-6-sol[extended]'), null);
  assert.equal(findModel(full, 'codex', 'gpt-6-sol').row.id, 'gpt-6-sol');
  assert.equal(findModel(full, 'codex', 'gpt-5.5[extended]'), null, 'no extended row, no fallback to the base window');
});

test('context-aware alias matching: a resolved id hides its aliases at that window only', async () => {
  const { full } = await catalogWith({ 'claude-code': ['claude-opus-5-5[1m]'] });
  assert.equal(hiddenModelId(full, 'claude-code', 'opus[1m]'), 'claude-opus-5-5[1m]');
  assert.equal(hiddenModelId(full, 'claude-code', 'opus'), null);
  assert.equal(hiddenModelId(full, 'claude-code', 'default'), null);
  assert.equal(findModel(full, 'claude-code', 'claude-opus-5-5').row.id, 'default', 'the 200k resolved id still runs');
  const { full: base } = await catalogWith({ 'claude-code': ['claude-opus-5-5'] });
  assert.equal(hiddenModelId(base, 'claude-code', 'opus'), 'claude-opus-5-5');
  assert.equal(hiddenModelId(base, 'claude-code', 'opus[1m]'), null);
  assert.equal(hiddenModelId(base, 'claude-code', 'opus:200000'), 'claude-opus-5-5', 'legacy composite ids are context-aware too');
  // Ids typed in /models or the PATCH body keep their window.
  const rowsByProvider = { 'claude-code': [...base.models['claude-code'], ...base.hiddenRows['claude-code']] };
  assert.deepEqual(resolveHiddenModelId({ id: 'opus', rowsByProvider }), { provider: 'claude-code', id: 'opus' });
  assert.deepEqual(resolveHiddenModelId({ id: 'opus[1m]', rowsByProvider }), { provider: 'claude-code', id: 'opus[1m]' });
  assert.deepEqual(resolveHiddenModelId({ id: 'claude-opus-5-5[1m]', rowsByProvider }), { provider: 'claude-code', id: 'claude-opus-5-5[1m]' });
});

test('router: a hidden variant is corrected (model_disabled), its sibling is not', async () => {
  const { full } = await catalogWith({ 'claude-code': ['opus[1m]'], codex: ['gpt-6-sol[extended]'] });
  const routing = { preferences: {}, askBelow: 0.75 };
  const route = (provider, model) => evaluateRoute({ mode: 'never', routing, brain: BRAIN, catalog: full, request: normalizeRouteRequest({ task_class: 'code', confidence: 0.95, proposals: [{ kind: 'dispatch', provider, model }] }, { brain: BRAIN }) });
  for (const [provider, model] of [['claude-code', 'opus[1m]'], ['codex', 'gpt-6-sol[extended]']]) {
    const evaluation = route(provider, model);
    assert.ok(evaluation.reasons.includes('model_disabled'), model);
    assert.notEqual(evaluation.auto.model, model);
  }
  for (const [provider, model] of [['claude-code', 'opus'], ['codex', 'gpt-6-sol']]) {
    assert.ok(!route(provider, model).reasons.includes('model_disabled'), model);
  }
});

test('manage view: archived ids per provider with the rows they cover; ids no provider lists are "not listed"', async () => {
  const { catalog } = await catalogWith({ 'claude-code': ['opus[1m]', 'claude-opus-5-5', 'claude-gone-1'], codex: ['gpt-6-sol[extended]'] });
  const manage = await catalog.get({ view: 'manage' });
  const archived = Object.fromEntries(manage.archived['claude-code'].map((a) => [a.id, a]));
  assert.deepEqual(ids(archived['opus[1m]'].rows), ['opus[1m]']);
  assert.equal(archived['opus[1m]'].rows[0].context, '1M');
  assert.deepEqual(ids(archived['claude-opus-5-5'].rows).sort(), ['default', 'opus']);
  assert.equal(archived['claude-gone-1'].listed, false);
  assert.equal(manage.archived.codex[0].rows[0].context, 'extended 872k');
  const opus = manage.models['claude-code'].find((r) => r.id === 'opus');
  assert.equal(opus.hidden, true);
  assert.equal(opus.hiddenBy, 'claude-opus-5-5', 'restore sends the list entry, not the alias');
  assert.equal(manage.models['claude-code'].find((r) => r.id === 'sonnet[1m]').context, '1M');
});

test('/models archived opens the manager on the Archived tab', () => {
  assert.deepEqual(parseSlashCommand('/models archived'), { name: 'models', action: 'open', tab: 'archived' });
  assert.deepEqual(parseSlashCommand('/models archive'), { name: 'models', action: 'open', tab: 'archived' });
});

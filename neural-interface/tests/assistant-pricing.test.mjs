// The list-price table: one source for the catalog, the usage ledger and the side panel.
// The expected values below are the providers' published prices, typed here by hand from
//   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing   (read 2026-10-01)
//   OpenAI     https://developers.openai.com/api/docs/pricing             (read 2026-10-01)
//              https://developers.openai.com/api/docs/models/gpt-6-sol    (gpt-6-sol)
// so a change to the table that drifts from them fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LONG_PROMPT_TOKENS, PRICING_SOURCES, PRICING_VERIFIED, claudeLegacyPricing, claudeTokensCostUsd, claudeUsageCostUsd,
  listPrice, priceModelId, pricingRows, tokensCostUsd,
} from '../lib/assistant-pricing.js';
import { codexUsageCostUsd, createModelPricing } from '../lib/assistant-budget.js';
import { createAssistantCatalog, formatModelLine, compactRow, normalizeClaudeRows, normalizeCodexRows } from '../lib/assistant-catalog.js';

// $ per million tokens: [input, cache write 5 min, cache write 1 h, cache read, output].
const ANTHROPIC = {
  'claude-fable-5-1': [10, 12.5, 20, 0.25, 50],
  'claude-fable-5': [10, 12.5, 20, 1, 50],
  'claude-opus-5-5': [4, 5, 8, 0.2, 20],
  'claude-opus-5': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-8': [5, 6.25, 10, 0.5, 25],
  'claude-sonnet-5-5': [2, 2.5, 4, 0.2, 10],
  'claude-sonnet-5': [2, 2.5, 4, 0.2, 10],
  'claude-sonnet-4-6': [3, 3.75, 6, 0.3, 15],
  'claude-haiku-4-5': [1, 1.25, 2, 0.1, 5],
};
// [input, cached input, cache writes, output] for a short prompt, then for a prompt over 272K input tokens.
const OPENAI = {
  'gpt-6-astra': [[10, 1, 12.5, 50], [20, 2, 25, 75]],
  'gpt-6.1-sol': [[2, 0.1, 2.5, 10], [4, 0.2, 5, 15]],
  'gpt-6-sol': [[2, 0.2, 2.5, 10], [4, 0.4, 5, 15]],
  'gpt-6-luna': [[0.1, 0.01, 0.125, 0.5], [0.2, 0.02, 0.25, 0.75]],
};

test('every model the Assistant can route to has its published list price, per token class', () => {
  for (const [model, [input, write5m, write1h, read, output]] of Object.entries(ANTHROPIC)) {
    const price = listPrice('claude-code', model);
    assert.deepEqual([price.input, price.cacheWrite, price.cacheWrite1h, price.cacheRead, price.output, price.long], [input, write5m, write1h, read, output, null], model);
    assert.deepEqual([price.unit, price.source, price.verified], ['usd_per_mtok', PRICING_SOURCES.anthropic, PRICING_VERIFIED]);
  }
  for (const [model, [short, long]] of Object.entries(OPENAI)) {
    const price = listPrice('codex', model);
    assert.deepEqual([price.input, price.cacheRead, price.cacheWrite, price.output], short, model);
    assert.deepEqual([price.long.input, price.long.cacheRead, price.long.cacheWrite, price.long.output, price.long.size], [...long, 272_000], `${model} over 272K`);
    assert.equal(price.source, PRICING_SOURCES.openai);
  }
  assert.equal(LONG_PROMPT_TOKENS, 272_000);
  // Every row of the table is accounted for above or is a retired model kept for old sessions.
  const known = new Set([...Object.keys(ANTHROPIC), ...Object.keys(OPENAI), 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-3-5-sonnet', 'claude-3-5-haiku']);
  assert.deepEqual(pricingRows().map((row) => row.model).filter((model) => !known.has(model)), []);
});

test('a price is found under every spelling the providers use, and never guessed', () => {
  assert.deepEqual(['claude-opus-5-5[1m]', 'Claude-Opus-5-5', 'claude-haiku-4-5-20251001', 'gpt-6-sol[extended]', 'openai/gpt-6.1-sol'].map(priceModelId), ['claude-opus-5-5', 'claude-opus-5-5', 'claude-haiku-4-5', 'gpt-6-sol', 'gpt-6.1-sol']);
  assert.equal(listPrice('claude-code', 'claude-opus-5-5[1m]').input, 4);
  assert.equal(listPrice('claude-code', 'claude-haiku-4-5-20251001').output, 5);
  assert.equal(listPrice('codex', 'gpt-6.1-sol[extended]').cacheRead, 0.1);
  for (const [provider, model] of [['claude-code', 'opus[1m]'], ['claude-code', 'claude-opus-9'], ['codex', 'gpt-9'], ['opencode', 'gpt-6-sol'], ['codex', ''], ['claude-code', null]]) {
    assert.equal(listPrice(provider, model), null, `${provider} ${model}: no price is better than a wrong one`);
  }
});

test('tokens at list price reproduce what the Claude CLI and the ledger booked for real turns', () => {
  // Rows of a real session ledger (2026-10-01): [input, cacheWrite, cacheRead, output, reasoning] and the cost the CLI reported.
  const T = (input, cacheWrite, cacheRead, output, reasoning) => ({ input, cacheWrite, cacheRead, output, reasoning });
  // The CLI writes its cache at the 1-hour rate (2x input): that is what its reported cost contains.
  assert.equal(claudeTokensCostUsd('claude-opus-5-5[1m]', T(10, 67_041, 213_599, 957, 12_043)), 0.8390878);
  assert.equal(claudeTokensCostUsd('claude-opus-5-5[1m]', T(14, 124_624, 744_315, 2555, 16_797)), 1.532951);
  assert.equal(claudeTokensCostUsd('claude-sonnet-5-5', T(30, 90_226, 990_934, 5145, 978)), 0.6203808);
  assert.equal(claudeTokensCostUsd('claude-haiku-4-5-20251001', T(1088, 0, 0, 11, 0)), 0.001143);
  // A 5-minute write is 1.25x: the same tokens cost less, so a 5-minute figure is the floor of a reported one.
  assert.equal(claudeTokensCostUsd('claude-opus-5-5', T(10, 67_041, 213_599, 957, 12_043), { cacheWrite: '5m' }), 0.6379648);
  assert.equal(claudeTokensCostUsd('claude-unknown', T(1, 0, 0, 1, 0)), null);
  // Raw Anthropic usage: each cache write at its own rate when the split is given.
  assert.equal(claudeUsageCostUsd('claude-opus-5-5', { input_tokens: 10, cache_creation_input_tokens: 3000, cache_read_input_tokens: 100_000, output_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } }), 0.06104);
  assert.equal(claudeUsageCostUsd('claude-opus-5-5', { input_tokens: 10, cache_creation_input_tokens: 3000, cache_read_input_tokens: 100_000, output_tokens: 1000 }), 0.05504, 'no split: every write as a 5-minute one');
  // Codex (gpt-6-sol), a real ledger row: 14,703 input of which 9,344 cached, 329 output.
  const sol = listPrice('codex', 'gpt-6-sol');
  assert.equal(codexUsageCostUsd({ input_tokens: 14_703, cached_input_tokens: 9344, output_tokens: 329 }, sol, { long: false }), 0.0158768);
  assert.equal(tokensCostUsd(sol, T(5359, 0, 9344, 119, 210)), 0.0158768, 'the five classes give the same dollars as the provider keys');
  // A prompt over 272K input tokens is priced whole at the long rates (2x input and cache, 1.5x output).
  assert.equal(codexUsageCostUsd({ input_tokens: 300_000, cached_input_tokens: 100_000, output_tokens: 1000 }, sol, { long: true }), 0.855);
  assert.equal(tokensCostUsd(sol, T(200_000, 0, 100_000, 1000, 0), { long: true }), 0.855);
});

test('one source of truth: the side panel table is derived, the catalog and the ledger read the same rows', async () => {
  // server.js keeps no table of its own.
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /const MODEL_PRICING = claudeLegacyPricing\(\);/);
  assert.doesNotMatch(server, /'claude-[a-z0-9-]+':\s*\[\s*[\d.]+\s*,/, 'no second price list in server.js');
  const legacy = claudeLegacyPricing();
  assert.deepEqual([legacy['claude-opus-5-5'], legacy['claude-sonnet-5-5'], legacy['claude-haiku-4-5-20251001']], [[4, 20, 5, 0.2], [2, 10, 2.5, 0.2], [1, 5, 1.25, 0.1]]);

  // The catalog: Claude rows carry the table's price (Sonnet 5.5 used to have none and read "plan").
  const claude = normalizeClaudeRows([{ id: 'sonnet', resolvedModel: 'claude-sonnet-5-5', label: 'Sonnet' }, { id: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', label: 'Opus' }, { id: 'fable[1m]', resolvedModel: 'claude-fable-5-1', label: 'Fable' }]);
  assert.deepEqual(claude.map((row) => [row.id, row.price]), [
    ['sonnet', { input: 2, output: 10, cacheRead: 0.2, unit: 'usd_per_mtok', basis: 'list' }],
    ['opus[1m]', { input: 4, output: 20, cacheRead: 0.2, unit: 'usd_per_mtok', basis: 'list' }],
    ['fable[1m]', { input: 10, output: 50, cacheRead: 0.25, unit: 'usd_per_mtok', basis: 'list' }],
  ]);
  assert.equal(formatModelLine(claude[0]).includes('$2/$10'), true);

  // Codex rows stay plan-billed for routing (price null) and show the list-price equivalent the ledger books.
  const pricing = createModelPricing({ path: '/nonexistent/models.json' });
  const codex = normalizeCodexRows([{ model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', contextWindow: 272_000, maxContextWindow: 872_000 }, { model: 'gpt-0-unlisted', displayName: 'Unlisted' }], { priceOf: pricing.codexPrice });
  assert.deepEqual(codex.map((row) => [row.id, row.price, row.listPrice || null]), [
    ['gpt-6.1-sol', null, { input: 2, output: 10, cacheRead: 0.1, unit: 'usd_per_mtok', basis: 'plan' }],
    ['gpt-6.1-sol[extended]', null, { input: 2, output: 10, cacheRead: 0.1, unit: 'usd_per_mtok', basis: 'plan' }],
    ['gpt-0-unlisted', null, null],
  ]);
  assert.match(formatModelLine(codex[0]), /^gpt-6\.1-sol · large · plan \(list \$2\/\$10\) · /);
  assert.match(formatModelLine(codex[2]), /^gpt-0-unlisted · \S+ · plan( ·|$)/);
  assert.deepEqual([compactRow(codex[0]).price, compactRow(codex[0]).listPrice, 'listPrice' in compactRow(codex[2])], [null, [2, 10], false]);

  // A catalog built with no pricing argument and the ledger's own lookup agree on every model of the table.
  const catalog = createAssistantCatalog({ fetchJson: async (path) => (path === '/api/codex/models' ? { models: Object.keys(OPENAI).map((model) => ({ model, displayName: model, contextWindow: 272_000 })) }
    : path === '/api/claude/models' ? { models: Object.keys(ANTHROPIC).map((model) => ({ id: model, label: model })) } : null) });
  const built = await catalog.full();
  for (const row of built.models.codex) {
    const booked = pricing.codexPrice(row.id);
    assert.deepEqual([row.listPrice.input, row.listPrice.output, row.listPrice.cacheRead], [booked.input, booked.output, booked.cacheRead], row.id);
  }
  for (const row of built.models['claude-code']) {
    const booked = pricing.claudePrice(row.upstream);
    assert.deepEqual([row.price.input, row.price.output, row.price.cacheRead], [booked.input, booked.output, booked.cacheRead], row.id);
  }
});

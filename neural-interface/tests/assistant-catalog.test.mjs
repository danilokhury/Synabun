import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOpenCodeProviders, normalizeClaudeRows, normalizeCodexRows, guessTier, findModel, selectSheetModels,
  createAssistantCatalog, formatModelLine, priceText, enabledStandIn, rowMakes, compactRow, withClaudeContextVariants, providerEmpty,
} from '../lib/assistant-catalog.js';

import { CLAUDE_MODELS, CODEX_MODELS, OPENCODE_FULL, OPENCODE_MEDIA, PRICING, fakeFetch } from './assistant-catalog.fixtures.mjs';

test('OpenCode rows: connected providers only, v2 capabilities and v1 modalities, price, context, variants', () => {
  const rows = parseOpenCodeProviders(OPENCODE_FULL);
  const ids = rows.map((row) => row.id);
  assert.ok(ids.includes('ollama-cloud/deepseek-v4.1-flash'));
  assert.ok(!ids.some((id) => id.startsWith('not-connected/')), 'unconnected providers are skipped');
  const flash = rows.find((row) => row.id === 'ollama-cloud/deepseek-v4.1-flash');
  assert.equal(flash.vision, true);
  assert.equal(flash.visionSource, 'catalog');
  assert.deepEqual(flash.price, { input: 0.15, output: 0.6, cacheRead: 0.003, unit: 'usd_per_mtok', basis: 'list' });
  assert.equal(flash.contextWindow, 1048576);
  assert.deepEqual(flash.efforts, ['low', 'high', 'max']);
  assert.equal(flash.isDefault, true);
  assert.equal(flash.tier, 'small');
  assert.equal(rows.find((row) => row.id === 'ollama-cloud/deepseek-v4-pro').tier, 'large');
  assert.equal(rows.find((row) => row.id === 'legacy/vis-1').vision, true, 'v1 modalities shape');
  assert.equal(rows.find((row) => row.id === 'zai-coding-plan/glm-5.2').price.basis, 'free');
  // Glob filter narrows the list.
  assert.deepEqual(parseOpenCodeProviders(OPENCODE_FULL, { filter: ['ollama-cloud/*flash*'] }).map((r) => r.id).sort(), ['ollama-cloud/deepseek-v4-flash', 'ollama-cloud/deepseek-v4.1-flash']);
});

test('Claude rows are priced by resolved model and always see images; Codex rows read inputModalities and drop hidden/computer-use', () => {
  const claude = normalizeClaudeRows(CLAUDE_MODELS.models, { pricing: PRICING });
  const opus = claude.find((row) => row.id === 'opus');
  assert.deepEqual(opus.price, { input: 4, output: 20, cacheRead: 0.2, unit: 'usd_per_mtok', basis: 'list' });
  assert.equal(opus.vision, true);
  assert.equal(opus.tier, 'large');
  assert.equal(claude.find((row) => row.id === 'haiku').tier, 'small');
  assert.equal(claude.find((row) => row.id === 'sonnet').tier, 'medium');
  assert.equal(claude.find((row) => row.id === 'default').isDefault, true);
  const codex = normalizeCodexRows(CODEX_MODELS.models);
  assert.deepEqual(codex.map((row) => row.id), ['gpt-6-astra', 'gpt-5.6-luna']);
  assert.equal(codex[0].vision, true);
  assert.equal(codex[0].isDefault, true);
  assert.deepEqual(codex[0].efforts, ['low', 'high']);
  assert.equal(codex[0].tier, 'large');
  assert.equal(codex[1].tier, 'small');
});

test('guessTier uses name hints, then output-price bands', () => {
  assert.equal(guessTier({ id: 'x/some-mini' }), 'small');
  assert.equal(guessTier({ id: 'x/some-pro' }), 'large');
  assert.equal(guessTier({ id: 'x/qwen3.5:397b' }), 'large');
  assert.equal(guessTier({ id: 'x/unknown', price: { output: 1 } }), 'small');
  assert.equal(guessTier({ id: 'x/unknown', price: { output: 5 } }), 'medium');
  assert.equal(guessTier({ id: 'x/unknown', price: { output: 30 } }), 'large');
  assert.equal(guessTier({ id: 'x/unknown', price: { output: 0 } }), 'medium');
});

test('findModel: exact, alias, resolved, unlisted claude ids, unverified empty lists, unknown → null', () => {
  const catalog = { models: { 'claude-code': normalizeClaudeRows(CLAUDE_MODELS.models, { pricing: PRICING }), codex: normalizeCodexRows(CODEX_MODELS.models), opencode: parseOpenCodeProviders(OPENCODE_FULL) } };
  assert.equal(findModel(catalog, 'claude-code', 'opus').match, 'exact');
  assert.equal(findModel(catalog, 'claude-code', 'opus[1m]'), null, 'context-aware: "opus[1m]" never falls back to the 200k "opus" row');
  assert.equal(findModel(catalog, 'claude-code', 'claude-sonnet-5').match, 'resolved');
  assert.equal(findModel(catalog, 'claude-code', 'claude-future-9').match, 'unlisted');
  assert.equal(findModel(catalog, 'opencode', 'deepseek-v4.1-flash').row.id, 'ollama-cloud/deepseek-v4.1-flash', 'bare OpenCode model id resolves when unambiguous');
  assert.equal(findModel(catalog, 'codex', 'gpt-9-imaginary'), null);
  assert.deepEqual(findModel({ models: { codex: [] } }, 'codex', 'anything'), { row: null, match: 'unverified' });
});

test('routing sheet: one Claude row per family, OpenCode sampled with the brain model and a vision model, lines formatted', () => {
  const catalog = { models: { 'claude-code': normalizeClaudeRows(CLAUDE_MODELS.models, { pricing: PRICING }), codex: normalizeCodexRows(CODEX_MODELS.models), opencode: parseOpenCodeProviders(OPENCODE_FULL) } };
  const sheet = selectSheetModels(catalog, { brain: { provider: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash' }, max: 5 });
  const claudeIds = sheet['claude-code'].map((row) => row.id);
  assert.ok(claudeIds.includes('opus'), 'alias preferred over "default" for the same model');
  assert.ok(!claudeIds.includes('default'));
  assert.ok(!claudeIds.includes('claude-sonnet-4-6'), 'older family members are skipped');
  assert.equal(sheet.opencode[0].id, 'ollama-cloud/deepseek-v4.1-flash', 'the brain model comes first');
  assert.ok(sheet.opencode.length <= 5);
  const line = formatModelLine(sheet.opencode[0]);
  assert.equal(line, 'ollama-cloud/deepseek-v4.1-flash · small · $0.15/$0.60 · vision · 1M ctx · effort low|high|max');
  assert.equal(priceText(null), 'plan');
});

test('createAssistantCatalog caches, serves a compact brain view and search, and reports brain capabilities', async () => {
  let clock = 1000;
  const fetchJson = fakeFetch();
  const catalog = createAssistantCatalog({ fetchJson, claudePricing: PRICING, now: () => clock, listAccounts: () => ({ codex: [{ id: 'default' }] }) });
  assert.equal(catalog.peek(), null);
  const full = await catalog.get();
  assert.equal(full.models.opencode.length, 5);
  assert.equal(full.opencodeTotal, 5);
  assert.deepEqual(full.accounts, { codex: [{ id: 'default' }] });
  await catalog.get();
  assert.equal(fetchJson.calls.length, 5, 'second call within the TTL is cached');
  clock += 31_000;
  await catalog.get();
  assert.equal(fetchJson.calls.length, 10);
  const brief = await catalog.get({ view: 'brain' });
  assert.deepEqual(Object.keys(brief.models.opencode[0]).sort(), ['ctx', 'ctxLabel', 'default', 'defaultEffort', 'efforts', 'id', 'label', 'outputs', 'price', 'tier', 'vision'].sort());
  assert.equal(brief.models.opencode[0].outputs, undefined, 'only a model that makes images or video carries outputs');
  const search = await catalog.get({ provider: 'opencode', q: 'pro' });
  assert.deepEqual(search.models.opencode.map((row) => row.id), ['ollama-cloud/deepseek-v4-pro']);
  assert.deepEqual(Object.keys(search.models), ['opencode']);
  const info = catalog.brainInfo({ provider: 'opencode', model: 'ollama-cloud/deepseek-v4.1-flash' });
  assert.equal(info.vision, true);
  assert.equal(info.label, 'DeepSeek V4.1 Flash');
  assert.equal(catalog.brainInfo({ provider: 'opencode', model: 'ollama-cloud/deepseek-v4-pro' }).vision, false);
  assert.equal(catalog.brainInfo({ provider: 'claude-code', model: null }).vision, true, 'default Claude model');
  assert.equal(catalog.brainInfo({ provider: 'opencode', model: null }).vision, null, 'unknown OpenCode default');
});

test('hidden Claude / Codex models: dropped from every view, [1m] / resolved-model matching, no unlisted bypass', async () => {
  const hidden = { 'claude-code': ['claude-opus-5-5', 'haiku'], codex: ['gpt-5.6-luna'] };
  const catalog = createAssistantCatalog({ fetchJson: fakeFetch(), claudePricing: PRICING, readHidden: () => hidden });
  const full = await catalog.full();
  assert.deepEqual(full.models['claude-code'].map((r) => r.id), ['opus[1m]', 'claude-fable-5-1', 'claude-fable-5-1[1m]', 'sonnet', 'sonnet[1m]', 'claude-sonnet-4-6', 'claude-sonnet-4-6[1m]'], 'default and opus resolve to the hidden model; the 1M variants hide on their own');
  assert.deepEqual(full.models.codex.map((r) => r.id), ['gpt-6-astra']);
  assert.equal(findModel(full, 'claude-code', 'opus[1m]').row.id, 'opus[1m]', 'hiding claude-opus-5-5 leaves the 1M variant');
  assert.equal(findModel(full, 'claude-code', 'haiku[1m]'), null);
  assert.equal(findModel(full, 'claude-code', 'claude-opus-5-5'), null, 'hidden before the unlisted branch');
  assert.equal(catalog.hiddenId('claude-code', 'HAIKU'), 'haiku');
  const brief = await catalog.get({ view: 'brain' });
  assert.deepEqual(brief.hiddenCount, { 'claude-code': 3, codex: 1, opencode: 0 });
  assert.equal(brief.hidden, undefined);
  const all = createAssistantCatalog({ fetchJson: fakeFetch(), claudePricing: PRICING, readHidden: () => ({ codex: ['gpt-6-astra', 'gpt-5.6-luna'] }) });
  assert.equal(findModel(await all.full(), 'codex', 'gpt-9'), null, 'every model hidden → nothing is "unverified"');
});

test('enabledStandIn: the same model at another context window, else the enabled default; null when all are hidden and for OpenCode', async () => {
  // Like a live list: the base GPT-6 row hidden, its extended window kept on.
  const codex = { ...CODEX_MODELS, models: CODEX_MODELS.models.map((m) => (m.id === 'gpt-6-astra' ? { ...m, maxContextWindow: 872000 } : m)) };
  const hidden = { 'claude-code': ['opus', 'haiku'], codex: ['gpt-6-astra'] };
  const full = await createAssistantCatalog({ fetchJson: fakeFetch({ '/api/codex/models': codex }), claudePricing: PRICING, readHidden: () => hidden }).full();
  assert.equal(enabledStandIn(full, 'codex', 'gpt-6-astra').id, 'gpt-6-astra[extended]');
  assert.equal(enabledStandIn(full, 'codex').id, 'gpt-6-astra[extended]', 'a null model: the hidden default is never the answer');
  assert.equal(enabledStandIn(full, 'claude-code', 'opus').id, 'default', 'same resolved model');
  assert.equal(enabledStandIn(full, 'claude-code', 'haiku').id, 'default', 'no sibling → the enabled default');
  assert.equal(enabledStandIn(full, 'claude-code', 'OPUS').id, 'default', 'case-insensitive');
  assert.equal(enabledStandIn(full, 'opencode', 'ollama-cloud/deepseek-v4-pro'), null, 'OpenCode has no known default');
  const none = await createAssistantCatalog({ fetchJson: fakeFetch({ '/api/codex/models': codex }), claudePricing: PRICING, readHidden: () => ({ codex: ['gpt-6-astra', 'gpt-6-astra[extended]', 'gpt-5.6-luna'] }) }).full();
  assert.equal(enabledStandIn(none, 'codex', 'gpt-6-astra'), null);
  assert.equal(enabledStandIn(none, 'codex'), null);
});

// ── What a model generates (image / video creation) ─────────────────────────

test('outputs: OpenCode v2 capabilities.output, v1 modalities.output, unknown without data; only true qualifies', () => {
  const rows = parseOpenCodeProviders(OPENCODE_MEDIA);
  const by = (id) => rows.find((row) => row.id === id);
  assert.deepEqual(by('media-lab/pixel-flash').outputs, { image: true, video: false });
  assert.equal(by('media-lab/pixel-flash').outputsSource, 'catalog');
  assert.deepEqual(by('media-lab/motion-1').outputs, { image: false, video: true });
  assert.deepEqual(by('legacy-media/reel-1').outputs, { image: false, video: true }, 'v1 models.dev shape');
  assert.equal(by('legacy-media/reel-1').outputsSource, 'catalog');
  assert.deepEqual(by('media-lab/text-only').outputs, { image: null, video: null }, 'no output data: unknown');
  assert.equal(by('media-lab/text-only').outputsSource, 'unknown');
  assert.equal(rowMakes(by('media-lab/pixel-flash'), 'image'), true);
  assert.equal(rowMakes(by('media-lab/pixel-flash'), 'video'), false);
  assert.equal(rowMakes(by('media-lab/text-only'), 'image'), false, 'null never qualifies');
  assert.equal(rowMakes(by('media-lab/pixel-flash'), 'audio'), false);
  assert.equal(rowMakes(null, 'image'), false);
  // The long-standing fixture carries no output data at all.
  assert.ok(parseOpenCodeProviders(OPENCODE_FULL).every((row) => row.outputs.image === null && row.outputs.video === null));
});

test('outputs: Claude makes neither; Codex GPT models make images through the built-in tool, never video; variants inherit', () => {
  const claude = withClaudeContextVariants(normalizeClaudeRows(CLAUDE_MODELS.models, { pricing: PRICING }));
  assert.ok(claude.every((row) => row.outputs.image === false && row.outputs.video === false && row.outputsSource === 'provider'));
  assert.ok(claude.some((row) => row.id === 'opus[1m]'), 'the 1M variant exists and carries the same outputs');
  const codex = normalizeCodexRows([...CODEX_MODELS.models.map((m) => (m.id === 'gpt-6-astra' ? { ...m, maxContextWindow: 872000 } : m)), { id: 'o-lab-1', model: 'o-lab-1', displayName: 'Lab' }]);
  const astra = codex.find((row) => row.id === 'gpt-6-astra');
  assert.deepEqual(astra.outputs, { image: true, video: false });
  assert.equal(astra.outputsSource, 'tool');
  assert.deepEqual(codex.find((row) => row.id === 'gpt-6-astra[extended]').outputs, { image: true, video: false }, 'the extended row inherits');
  assert.deepEqual(codex.find((row) => row.id === 'o-lab-1').outputs, { image: null, video: false }, 'a non-GPT Codex model: unknown images, no video');
});

test('outputs: sheet tokens, pinned makers, compact rows', () => {
  const opencode = parseOpenCodeProviders(OPENCODE_MEDIA);
  const flash = opencode.find((row) => row.id === 'media-lab/pixel-flash');
  assert.equal(formatModelLine(flash), 'media-lab/pixel-flash · small · $0.30/$2.50 · vision · image-out · 33k ctx');
  assert.equal(formatModelLine(opencode.find((row) => row.id === 'media-lab/motion-1')), 'media-lab/motion-1 · large · $1/$12 · vision · video-out · 33k ctx');
  const codexLine = formatModelLine(normalizeCodexRows(CODEX_MODELS.models)[0]);
  assert.match(codexLine, /^gpt-6-astra · large · plan · vision · image-out · 272k ctx/);
  // max 3: the brain's own model, then both makers, before any tier sampling.
  const catalog = { models: { 'claude-code': [], codex: [], opencode } };
  const sheet = selectSheetModels(catalog, { brain: { provider: 'opencode', model: 'media-lab/text-only' }, max: 3 });
  assert.deepEqual(sheet.opencode.map((row) => row.id), ['media-lab/text-only', 'media-lab/pixel-flash', 'legacy-media/reel-1'], 'the brain model, then the cheapest image maker and the cheapest video maker');
  assert.deepEqual(compactRow(flash).outputs, { image: true, video: false });
  assert.equal(compactRow(opencode.find((row) => row.id === 'media-lab/text-only')).outputs, undefined);
});

// ── Review fixes (2026-09-28, Codex review run 35d06cf3) ────────────────────

test('review #5: an explicit OpenCode `connected` list decides, even an empty one; without one every listed provider counts', () => {
  const body = (connected) => ({ ok: true, data: { all: OPENCODE_MEDIA.data.all, default: {}, ...(connected === undefined ? {} : { connected }) } });
  assert.deepEqual(parseOpenCodeProviders(body([])), [], 'nothing connected: no OpenCode model (the reproduction picked a disconnected video maker)');
  assert.deepEqual([...new Set(parseOpenCodeProviders(body(['studio'])).map((row) => row.upstream))], ['studio']);
  assert.deepEqual([...new Set(parseOpenCodeProviders(body(undefined)).map((row) => row.upstream))], ['media-lab', 'studio', 'legacy-media'], 'no list at all: every listed provider, as before');
  assert.deepEqual(parseOpenCodeProviders({ ok: false, error: 'OpenCode server not running', data: {} }), [], 'OpenCode down');
});

test('review #7: pinned routes never crowd the cheapest image / video maker off the sheet', () => {
  const plain = Array.from({ length: 9 }, (_, i) => ({
    provider: 'opencode', id: `pinned/m${i}`, upstream: `pinned-${i}`, label: `M${i}`, tier: 'small', vision: false,
    outputs: { image: null, video: null }, outputsSource: 'unknown', toolcall: true, price: { input: 1, output: 1 }, status: 'active',
  }));
  const makers = parseOpenCodeProviders(OPENCODE_MEDIA);
  const catalog = { models: { 'claude-code': [], codex: [], opencode: [...plain, ...makers] } };
  const preferences = Object.fromEntries(plain.map((row, i) => [`class-${i}`, { kind: 'dispatch', provider: 'opencode', model: row.id }]));
  const sheet = selectSheetModels(catalog, { brain: { provider: 'opencode', model: 'pinned/m0' }, preferences, max: 8 });
  const ids = sheet.opencode.map((row) => row.id);
  assert.equal(ids.length, 8);
  assert.equal(ids[0], 'pinned/m0', 'the brain model still comes first');
  assert.ok(ids.includes('media-lab/pixel-flash'), 'the cheapest image maker keeps its slot');
  assert.ok(ids.includes('legacy-media/reel-1'), 'the cheapest video maker keeps its slot');
  // A pinned maker takes its own reserved slot instead of a second one.
  const withMaker = selectSheetModels(catalog, { brain: { provider: 'opencode', model: 'media-lab/pixel-flash' }, preferences, max: 8 });
  assert.equal(withMaker.opencode[0].id, 'media-lab/pixel-flash');
  assert.equal(withMaker.opencode.filter((row) => row.id.startsWith('pinned/')).length, 6, 'one slot left for the video maker');
});

test('re-review #2: an authoritative empty OpenCode list rejects named models; an unavailable one stays "unverified"', async () => {
  const empty = await createAssistantCatalog({ fetchJson: fakeFetch({ '/api/opencode/providers/full': { ok: true, data: { all: OPENCODE_MEDIA.data.all, default: {}, connected: [] } } }), claudePricing: PRICING }).full();
  assert.deepEqual([empty.known.opencode, empty.models.opencode.length, providerEmpty(empty, 'opencode')], [true, 0, true]);
  assert.equal(findModel(empty, 'opencode', 'media-lab/text-only'), null, 'the reproduction accepted it as "unverified"');
  const down = await createAssistantCatalog({ fetchJson: fakeFetch({ '/api/opencode/providers/full': { ok: false, error: 'OpenCode server not running', data: {} } }), claudePricing: PRICING }).full();
  assert.deepEqual([down.known.opencode, providerEmpty(down, 'opencode')], [false, false]);
  assert.deepEqual(findModel(down, 'opencode', 'media-lab/text-only'), { row: null, match: 'unverified' }, 'OpenCode down keeps today\'s leniency');
});

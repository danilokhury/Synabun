import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ONE_M_CONTEXT,
  DEFAULT_CONTEXT,
  modelBase,
  catalogModel,
  catalogContextWindow,
  mainLoopContextWindow,
  gaugeContextWindow,
} from '../public/shared/cp/cp-context-window.js';

// The Claude sidepanel's context gauge read the first result.modelUsage key, which
// after a resume is whatever the transcript's cost-state saved first — Haiku, for a
// 1M Opus session that ran Explore agents — so 1M sessions showed "/ 200k".

// Shape of /api/claude/models on Claude Code 2.1.280.
const MODELS = [
  { id: 'default', label: 'Default (recommended) — Opus 5.5', resolvedModel: 'claude-opus-5-5[1m]', contextWindow: 1_000_000, tier: 'default' },
  { id: 'opus[1m]', label: 'Opus 5.5 (1M context)', resolvedModel: 'claude-opus-5-5[1m]', contextWindow: 1_000_000 },
  { id: 'claude-fable-5-1[1m]', label: 'Fable 5.1', resolvedModel: 'claude-fable-5-1', contextWindow: 1_000_000 },
  { id: 'sonnet', label: 'Sonnet 5', resolvedModel: 'claude-sonnet-5', contextWindow: 200_000 },
  { id: 'haiku', label: 'Haiku 4.5', resolvedModel: 'claude-haiku-4-5-20251001', contextWindow: 200_000 },
];
const byId = (id) => MODELS.find(m => m.id === id);

const usage = (contextWindow, extra = {}) => ({
  inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
  webSearchRequests: 0, costUSD: 0.01, contextWindow, maxOutputTokens: 64_000, ...extra,
});

// Key order of the cost-state saved in transcript 86ed9aaf-…: Haiku first.
const RESUMED_OPUS_1M = {
  'claude-haiku-4-5-20251001': usage(200_000, { costUSD: 0.001073 }),
  'claude-opus-5-5[1m]': usage(1_000_000, { costUSD: 147.77 }),
  'claude-opus-5-5': usage(200_000, { costUSD: 22.39 }),
};

test('modelBase drops the 1M marker and the date stamp', () => {
  assert.equal(modelBase('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(modelBase('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(modelBase('claude-opus-5'), 'claude-opus-5');
  assert.equal(modelBase(undefined), '');
});

test('a resumed 1M session whose usage lists Haiku first reads 1M', () => {
  assert.equal(Object.keys(RESUMED_OPUS_1M)[0], 'claude-haiku-4-5-20251001', 'the old first-key read');
  assert.equal(mainLoopContextWindow(RESUMED_OPUS_1M, 'claude-opus-5-5', byId('default')), 1_000_000);
  assert.equal(mainLoopContextWindow(RESUMED_OPUS_1M, 'claude-opus-5-5', byId('opus[1m]')), 1_000_000);
  assert.equal(mainLoopContextWindow(RESUMED_OPUS_1M, 'claude-opus-5-5'), 1_000_000, 'no selection: the larger window');
});

test('the main loop decides after a mid-session model switch', () => {
  const switched = {
    'claude-opus-5-5[1m]': usage(1_000_000),
    'claude-sonnet-5': usage(200_000),
  };
  assert.equal(mainLoopContextWindow(switched, 'claude-sonnet-5', byId('sonnet')), 200_000);
  assert.equal(mainLoopContextWindow(switched, 'claude-opus-5-5', byId('opus[1m]')), 1_000_000);
});

test('one model at two windows: the selected variant wins when it ran, else the larger', () => {
  const both = {
    'claude-opus-4-8': usage(200_000),
    'claude-opus-4-8[1m]': usage(1_000_000),
  };
  const opus200 = { id: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', contextWindow: 200_000 };
  const opus1m = { id: 'claude-opus-4-8[1m]', resolvedModel: 'claude-opus-4-8[1m]', contextWindow: 1_000_000 };
  assert.equal(mainLoopContextWindow(both, 'claude-opus-4-8', opus200), 200_000);
  assert.equal(mainLoopContextWindow(both, 'claude-opus-4-8', opus1m), 1_000_000);
  assert.equal(mainLoopContextWindow(both, 'claude-opus-4-8', byId('sonnet')), 1_000_000, 'a selection that did not run is ignored');
});

test('the CLI report beats the picker when the 1M pick ran at 200K', () => {
  assert.equal(mainLoopContextWindow({ 'claude-opus-5-5': usage(200_000) }, 'claude-opus-5-5', byId('default')), 200_000);
});

test('Fable, dated Haiku and provider keys resolve through the base id', () => {
  const fable = { 'claude-haiku-4-5-20251001': usage(200_000), 'claude-fable-5-1[1m]': usage(1_000_000) };
  assert.equal(mainLoopContextWindow(fable, 'claude-fable-5-1', byId('claude-fable-5-1[1m]')), 1_000_000);
  assert.equal(mainLoopContextWindow({ 'claude-haiku-4-5-20251001': usage(200_000) }, 'claude-haiku-4-5-20251001', byId('haiku')), 200_000);
  const bedrock = { 'us.anthropic.claude-opus-5-5-v1[1m]': usage(1_000_000, { canonicalModel: 'claude-opus-5-5' }) };
  assert.equal(mainLoopContextWindow(bedrock, 'claude-opus-5-5'), 1_000_000);
});

test('no identifiable main loop keeps the previous window', () => {
  assert.equal(mainLoopContextWindow(RESUMED_OPUS_1M, null), 0);
  assert.equal(mainLoopContextWindow(RESUMED_OPUS_1M, '<synthetic>'), 0);
  assert.equal(mainLoopContextWindow(RESUMED_OPUS_1M, 'claude-sonnet-5'), 0);
  assert.equal(mainLoopContextWindow(undefined, 'claude-opus-5-5'), 0);
  assert.equal(mainLoopContextWindow({ 'claude-opus-5-5[1m]': usage(0) }, 'claude-opus-5-5'), 0, 'zeroed startup-error result');
});

test('catalogModel resolves unknown ids to the CLI default, like the dropdown', () => {
  assert.equal(catalogModel(MODELS, 'sonnet')?.id, 'sonnet');
  assert.equal(catalogModel(MODELS, 'claude-opus-4-8:1000000')?.id, 'default');
  assert.equal(catalogModel(MODELS, '')?.id, 'default');
  assert.equal(catalogModel([], 'sonnet'), null);
});

test('catalogContextWindow reads the catalog, then the id itself', () => {
  assert.equal(catalogContextWindow(MODELS, 'opus[1m]'), 1_000_000);
  assert.equal(catalogContextWindow(MODELS, 'sonnet'), 200_000);
  assert.equal(catalogContextWindow(MODELS, 'claude-opus-4-8:200000'), 1_000_000, 'unknown ids spawn as the CLI default');
  // Before the catalog loads
  assert.equal(catalogContextWindow([], 'opus[1m]'), ONE_M_CONTEXT);
  assert.equal(catalogContextWindow([], 'claude-opus-4-8:1000000'), 1_000_000);
  assert.equal(catalogContextWindow([], 'claude-opus-4-8:200000'), 200_000);
  assert.equal(catalogContextWindow([], 'default'), DEFAULT_CONTEXT);
  assert.equal(catalogContextWindow(undefined, ''), DEFAULT_CONTEXT);
});

test('gaugeContextWindow: report, then selection, and never below the context in use', () => {
  assert.equal(gaugeContextWindow({ reported: 1_000_000, selected: 200_000, used: 50_000, models: MODELS }), 1_000_000);
  assert.equal(gaugeContextWindow({ reported: 0, selected: 1_000_000, used: 50_000, models: MODELS }), 1_000_000);
  assert.equal(gaugeContextWindow({}), DEFAULT_CONTEXT);
  assert.equal(gaugeContextWindow({ reported: 200_000, selected: 200_000, used: 350_000, models: MODELS }), 1_000_000, 'a stale 200K');
  assert.equal(gaugeContextWindow({ reported: 200_000, used: 350_000, models: [] }), ONE_M_CONTEXT, 'before the catalog loads');
  assert.equal(gaugeContextWindow({ reported: 200_000, used: 200_000, models: MODELS }), 200_000, 'a full window is not stale');
  assert.equal(gaugeContextWindow({ reported: 1_000_000, used: 1_200_000, models: MODELS }), 1_000_000, 'nothing larger is known');
});

// ── Source contracts: the panel is a browser module ──

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const { historyRowsFromEntry } = await import('../lib/claude-history.js');
const history = await read('../lib/claude-history.js');
const [panel, server] = await Promise.all([
  read('../public/shared/ui-claude-panel.js'),
  read('../server.js'),
]);

// Source of one top-level function: from its signature to the next top-level one.
function fnBody(src, signature) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = src.slice(start + signature.length);
  const next = rest.search(/\n(?:async )?function /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

test('the result handler takes the main loop out of modelUsage', () => {
  assert.doesNotMatch(panel, /Object\.keys\(ev\.modelUsage\)/);
  const body = fnBody(panel, 'function handleTabEvent(tab, ev) {');
  assert.match(body, /mainLoopContextWindow\(ev\.modelUsage, tab\.mainModel, catalogModel\(_models, tab\.model\)\)/);
  assert.match(body, /if \(scope === tab && ev\.message\.model\) tab\.mainModel = ev\.message\.model;/);
  assert.match(body, /cache_creation_input_tokens \|\| 0\) > 0\)/, 'zero-usage synthetic messages leave the gauge alone');
  assert.match(body, /tab\._modelChangedMidTurn = false;/);
});

test('the gauge, /context and /doctor share the tab-scoped window', () => {
  assert.doesNotMatch(panel, /_getContextWindow/);
  const reading = fnBody(panel, 'function _contextMenuData(tab, { full = false } = {}) {');
  assert.match(reading, /window: source \? _contextWindowFor\(tab\) : 0, source \};/, 'the cog and the popover');
  assert.doesNotMatch(fnBody(panel, 'function _contextWindowFor(tab) {'), /#cp-model/, 'reads the tab, not the shared dropdown');
  assert.match(panel, /const ctxw = _contextWindowFor\(tab\);/, '/doctor');
  assert.match(panel, /const cw = _contextWindowFor\(tab\);/, '/context');
});

test('picking a model drops the previous model\'s window', () => {
  assert.match(panel, /\$model\.addEventListener\('change', \(\) => \{[\s\S]*?tab\.contextWindow = 0;\s*if \(tab\.running\) tab\._modelChangedMidTurn = true;/);
  assert.match(fnBody(panel, 'function refreshModels() {'), /if \(tab\) renderGauge\(tab\);/);
});

test('snapshots keep only windows recorded by the fixed reader', () => {
  assert.match(fnBody(panel, 'function writeSessionSnapshot(tab) {'), /v: 3,/);
  assert.match(fnBody(panel, 'function _normalizeSnapshotEntry(entry) {'), /contextWindow: Number\(entry\.v\) >= 3 \?/);
});

test('switching sessions in a tab saves the outgoing one first', () => {
  const body = fnBody(panel, 'async function selectSession(sid, label) {');
  const flush = body.indexOf('flushSessionSnapshotSave(tab);');
  assert.ok(flush >= 0, 'flushes the outgoing session');
  assert.ok(flush < body.indexOf('tab.sessionId = sid;'), 'before the tab changes session');
  assert.match(body, /tab\.mainModel = null;/);
});

test('session history reports the last real main-loop usage', () => {
  const start = server.indexOf("app.get('/api/claude-code/sessions/:sessionId/messages'");
  assert.ok(start >= 0);
  const route = server.slice(start, server.indexOf('\napp.', start + 1));
  // The line parser moved to lib/claude-history.js (historyRowsFromEntry): the
  // route keeps the latest usage it returns, and the rule itself lives there.
  // (Since review R13 the collector keeps it, for the active branch only.)
  assert.match(route, /const lastUsage = page\.usage;/);
  assert.match(history, /if \(p\.usage\) usage = p\.usage;/);
  assert.doesNotMatch(route, /lastModel/);
  assert.match(history, /usage && !obj\.isSidechain/);
  assert.match(history, /cache_creation_input_tokens \|\| 0\) > 0\)/);
  const real = historyRowsFromEntry({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 3, cache_read_input_tokens: 40 } } });
  assert.equal(real.usage.cache_read_input_tokens, 40);
  const sidechain = historyRowsFromEntry({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 3 } } });
  assert.equal(sidechain.usage, null);
  const synthetic = historyRowsFromEntry({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 0, output_tokens: 0 } } });
  assert.equal(synthetic.usage, null);
});

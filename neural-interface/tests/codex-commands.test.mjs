import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_COMMANDS, CODEX_COMMAND_BY_NAME, parseCodexCommand, codexCommandHints,
  latestCompletedCodexText, reviewTarget, configValue, configRestriction, capabilityAvailability,
  configChanges, sessionSettings, flattenNativeCatalog, modelServiceTiers, fastServiceTier,
} from '../public/shared/cdx/cdx-commands.js';

test('command registry provides matching dispatch IDs, correct clear help and unavailable reasons', () => {
  assert.equal(CODEX_COMMANDS.length, CODEX_COMMAND_BY_NAME.size);
  assert.deepEqual(parseCodexCommand('/REVIEW custom inspect security\nand permissions'), {
    name: 'review', args: 'custom inspect security\nand permissions', raw: '/REVIEW custom inspect security\nand permissions',
  });
  assert.match(CODEX_COMMAND_BY_NAME.get('clear').desc, /fresh conversation/);
  const hints = codexCommandHints({ plugin_list: { supported: false, reason: 'Upstream development API' }, hooks_list: { supported: true, experimental: true } });
  assert.match(hints.find((entry) => entry.name === 'plugins').desc, /Unavailable: Upstream development API/);
  assert.match(hints.find((entry) => entry.name === 'hooks').desc, /Experimental/);
  assert.equal(capabilityAvailability({}, 'background_list').supported, false);
  assert.equal(capabilityAvailability({}, 'account_logout').supported, true);
  assert.equal(capabilityAvailability({}, 'plugin_list').supported, false);
});

test('copy uses latest completed message and ignores old plans and newer streaming content', () => {
  const items = new Map([
    ['plan', { type: 'plan', buffer: 'Old plan', completed: true }],
    ['answer', { type: 'agentMessage', buffer: 'Current answer', completed: true }],
    ['next', { type: 'agentMessage', buffer: 'Unfinished', completed: false }],
  ]);
  assert.equal(latestCompletedCodexText(items), 'Current answer');
  items.set('next', { type: 'agentMessage', buffer: 'New answer', status: 'complete' });
  assert.equal(latestCompletedCodexText(items), 'New answer');
  assert.equal(latestCompletedCodexText([{ type: 'agentMessage', buffer: 'draft' }]), '');
});

test('review targets use native schema and reject missing branch/commit/instructions', () => {
  assert.deepEqual(reviewTarget('uncommittedChanges'), { type: 'uncommittedChanges' });
  assert.deepEqual(reviewTarget('baseBranch', 'main'), { type: 'baseBranch', branch: 'main' });
  assert.deepEqual(reviewTarget('commit', 'deadbeef'), { type: 'commit', sha: 'deadbeef' });
  assert.deepEqual(reviewTarget('custom', '  check race conditions  '), { type: 'custom', instructions: 'check race conditions' });
  assert.throws(() => reviewTarget('commit', ' '), /Enter/);
});

test('nested config, managed requirements and unknown configured enums round trip', () => {
  const original = { features: { apps: true }, web_search: 'indexed', approval_policy: { granular: { rules: true } }, model: 'future-model' };
  const defs = [{ key: 'features.apps', type: 'checkbox' }, { key: 'web_search', type: 'select' }, { key: 'approval_policy', type: 'select' }, { key: 'model', type: 'select' }];
  const inputs = {
    'features.apps': { checked: true }, web_search: { value: 'indexed' }, model: { value: 'future-model' },
    approval_policy: { value: JSON.stringify(original.approval_policy), dataset: { originalValue: JSON.stringify(original.approval_policy) } },
  };
  assert.equal(configValue(original, 'features.apps'), true);
  assert.deepEqual(configChanges(defs, inputs, original), {});
  inputs.web_search.value = 'disabled';
  assert.deepEqual(configChanges(defs, inputs, original), { web_search: 'disabled' });
  assert.deepEqual(configRestriction({ requirements: { requirements: { featureRequirements: { apps: false } } } }, 'features.apps'), { fixed: false, reason: 'Required by managed configuration' });
  assert.deepEqual(configRestriction({ allowedWebSearchModes: ['disabled'] }, 'web_search').allowed, ['disabled']);
});

test('session settings exclude saved-default-only fields and preserve explicit tier reset', () => {
  assert.deepEqual(sessionSettings({ model: 'gpt-6', model_reasoning_effort: 'high', service_tier: null, web_search: 'live', 'features.apps': true }), { model: 'gpt-6', effort: 'high', serviceTier: null });
  assert.throws(() => configChanges([{ key: 'limit', type: 'number', label: 'Limit' }], { limit: { value: '-3' } }, {}), /positive whole number/);
});

test('native catalog nesting and model service tiers use metadata without invented defaults', () => {
  assert.deepEqual(flattenNativeCatalog({ skills: { data: [{ skills: [{ name: 'repo-skill', enabled: true }] }] } }, 'skills'), [{ name: 'repo-skill', enabled: true }]);
  assert.deepEqual(flattenNativeCatalog({ terminals: { data: [{ processId: '1' }], nextCursor: 'two' } }, 'terminals'), [{ processId: '1' }]);
  assert.equal(fastServiceTier({ serviceTiers: [{ id: 'priority', name: 'Fast' }] }), 'priority');
  assert.equal(fastServiceTier({ serviceTiers: [{ id: 'flex', name: 'Flex' }] }), null);
  assert.deepEqual(modelServiceTiers({ serviceTiers: [{ id: 'new-tier', name: 'New tier' }] }), [{ value: 'new-tier', label: 'New tier' }]);
});

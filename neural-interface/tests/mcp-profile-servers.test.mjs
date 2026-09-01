import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentDisallowedTools,
  MCP_SERVER_WRITE_TOOLS,
  reconcileProfileServers,
  selectProfileServerNames,
} from '../lib/mcp-profile-servers.js';

function makeRegistry(overrides = {}) {
  return {
    servers: {
      SynaBun: { type: 'stdio', command: 'node', builtin: true },
      'meta-ads': { type: 'http', url: 'https://mcp.facebook.com/ads' },
    },
    profiles: {
      core: { label: 'Core', groups: ['git'], servers: [] },
      standard: { label: 'Standard', groups: ['git'], servers: ['SynaBun', 'meta-ads'] },
      full: { label: 'Full', groups: ['git'], servers: ['SynaBun', 'meta-ads'] },
    },
    activeProfile: 'standard',
    profileDefaults: { autoAddNewServers: true, excludeProfiles: ['core'] },
    ...overrides,
  };
}

test('profile server selection returns external servers and never builtins', () => {
  const reg = makeRegistry();
  assert.deepEqual(selectProfileServerNames(reg, 'standard'), ['meta-ads']);
  assert.deepEqual(selectProfileServerNames(reg, 'core'), []);
  // Defaults to the active profile.
  assert.deepEqual(selectProfileServerNames(reg), ['meta-ads']);
  // Unknown profile and junk input degrade to empty rather than throwing.
  assert.deepEqual(selectProfileServerNames(reg, 'nope'), []);
  assert.deepEqual(selectProfileServerNames(null), []);
});

test('selection drops names that are no longer registered', () => {
  const reg = makeRegistry();
  reg.profiles.standard.servers.push('deleted-server');
  assert.deepEqual(selectProfileServerNames(reg, 'standard'), ['meta-ads']);
});

test('first reconcile seeds knownServers and prunes builtins without granting anything new', () => {
  const reg = makeRegistry({ profileDefaults: { autoAddNewServers: true, excludeProfiles: ['core'] } });
  const changed = reconcileProfileServers(reg);

  assert.equal(changed, true);
  assert.deepEqual(reg.profileDefaults.knownServers, ['meta-ads']);
  // SynaBun is builtin — runtimes inject it themselves, so it must not sit in servers[].
  assert.deepEqual(reg.profiles.standard.servers, ['meta-ads']);
  assert.deepEqual(reg.profiles.core.servers, []);
});

test('a de-selected server stays de-selected across restarts', () => {
  const reg = makeRegistry();
  reconcileProfileServers(reg);

  // User unticks meta-ads for the `standard` profile in the External Servers grid.
  reg.profiles.standard.servers = [];

  // Three more startups must not silently re-grant it.
  for (let i = 0; i < 3; i++) reconcileProfileServers(reg);
  assert.deepEqual(reg.profiles.standard.servers, []);
  // Other profiles are untouched by that removal.
  assert.deepEqual(reg.profiles.full.servers, ['meta-ads']);
});

test('a genuinely new server is auto-granted to every non-excluded profile', () => {
  const reg = makeRegistry();
  reconcileProfileServers(reg);

  reg.servers['stripe'] = { type: 'stdio', command: 'stripe-mcp' };
  const changed = reconcileProfileServers(reg);

  assert.equal(changed, true);
  assert.deepEqual(reg.profiles.standard.servers, ['meta-ads', 'stripe']);
  assert.deepEqual(reg.profiles.full.servers, ['meta-ads', 'stripe']);
  assert.deepEqual(reg.profiles.core.servers, [], 'core is in excludeProfiles');
  assert.deepEqual(reg.profileDefaults.knownServers, ['meta-ads', 'stripe']);
});

test('autoAddNewServers off records the server but grants it to nobody', () => {
  const reg = makeRegistry();
  reconcileProfileServers(reg);
  reg.profileDefaults.autoAddNewServers = false;

  reg.servers['stripe'] = { type: 'stdio', command: 'stripe-mcp' };
  reconcileProfileServers(reg);

  assert.deepEqual(reg.profiles.standard.servers, ['meta-ads']);
  // Still recorded, so flipping the flag back on later does not retroactively grant it.
  assert.deepEqual(reg.profileDefaults.knownServers, ['meta-ads', 'stripe']);
});

test('reconcile is idempotent once settled', () => {
  const reg = makeRegistry();
  reconcileProfileServers(reg);
  const snapshot = JSON.stringify(reg);

  assert.equal(reconcileProfileServers(reg), false);
  assert.equal(JSON.stringify(reg), snapshot);
});

test('reconcile repairs a missing profileDefaults and non-array servers', () => {
  const reg = makeRegistry({ profileDefaults: undefined });
  reg.profiles.full.servers = 'not-an-array';

  assert.equal(reconcileProfileServers(reg), true);
  assert.equal(reg.profileDefaults.autoAddNewServers, true);
  assert.deepEqual(reg.profileDefaults.excludeProfiles, ['core']);
  assert.deepEqual(reg.profiles.full.servers, []);
});

test('agent deny list covers only the servers that agent actually got', () => {
  const withMeta = JSON.stringify({
    mcpServers: { SynaBun: { type: 'stdio' }, 'meta-ads': { type: 'http' } },
  });
  const deny = buildAgentDisallowedTools(withMeta);

  assert.equal(deny.length, MCP_SERVER_WRITE_TOOLS['meta-ads'].length);
  assert.ok(deny.includes('mcp__meta-ads__ads_activate_entity'), 'the tool that spends budget');
  assert.ok(deny.includes('mcp__meta-ads__ads_delete_custom_audience'));
  assert.ok(deny.every(name => name.startsWith('mcp__meta-ads__')));
  // Read tools must stay available — the guard is about mutation, not access.
  assert.ok(!deny.includes('mcp__meta-ads__ads_get_ad_accounts'));
  assert.ok(!deny.includes('mcp__meta-ads__ads_insights_performance_trend'));
});

test('agent deny list is empty when no guarded server is present', () => {
  assert.deepEqual(buildAgentDisallowedTools(JSON.stringify({ mcpServers: { SynaBun: {} } })), []);
  assert.deepEqual(buildAgentDisallowedTools('{"mcpServers":{}}'), []);
  assert.deepEqual(buildAgentDisallowedTools('not json'), []);
  assert.deepEqual(buildAgentDisallowedTools(undefined), []);
});

test('every guarded meta-ads tool is a mutation, never a read', () => {
  for (const tool of MCP_SERVER_WRITE_TOOLS['meta-ads']) {
    assert.match(
      tool,
      /_(create|update|delete|activate|connect|disconnect|boost)/,
      `${tool} does not look like a mutation — read tools must not be blocked`,
    );
  }
});

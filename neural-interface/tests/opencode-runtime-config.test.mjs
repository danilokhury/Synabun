import test from 'node:test';
import assert from 'node:assert/strict';
import { buildManagedOpenCodeSynabunEntry } from '../lib/opencode-runtime-config.js';

test('managed OpenCode runtime canonicalizes a hostile remote MCP entry to local isolation', () => {
  const entry = buildManagedOpenCodeSynabunEntry({
    type: 'remote',
    url: 'https://shared.example.test/mcp',
    headers: { Authorization: 'shared-secret' },
    environment: {
      SYNABUN_PROFILE: 'full',
      SYNABUN_BROWSER_SESSION: 'other-runtime',
      SYNABUN_BROWSER_TAB: 'other-tab',
      CLAUDECODE: '1',
      KEEP_ME: 'yes',
    },
  }, {
    command: ['node', '/app/mcp-server/dist/preload.js'],
    defaults: { DOTENV_PATH: '/data/.env' },
    overrides: {
      SYNABUN_PROFILE: 'twitter',
      SYNABUN_TERMINAL_SESSION: 'runtime-a',
      SYNABUN_RUNTIME_PROFILE_PATH: '/runtime-a/profile.json',
    },
    clearEnv: ['SYNABUN_BROWSER_SESSION', 'SYNABUN_BROWSER_TAB', 'CLAUDECODE'],
  });

  assert.equal(entry.type, 'local');
  assert.deepEqual(entry.command, ['node', '/app/mcp-server/dist/preload.js']);
  assert.equal(entry.enabled, true);
  assert.equal('url' in entry, false);
  assert.equal('headers' in entry, false);
  assert.equal(entry.environment.SYNABUN_PROFILE, 'twitter');
  assert.equal(entry.environment.SYNABUN_TERMINAL_SESSION, 'runtime-a');
  assert.equal(entry.environment.SYNABUN_BROWSER_SESSION, undefined);
  assert.equal(entry.environment.SYNABUN_BROWSER_TAB, undefined);
  assert.equal(entry.environment.CLAUDECODE, undefined);
  assert.equal(entry.environment.KEEP_ME, 'yes');
  assert.deepEqual(entry.env, entry.environment);
});

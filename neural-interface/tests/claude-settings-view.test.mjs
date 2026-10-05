// C19: the "settings in effect" view never returns a secret.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { slimResolvedSettings } from '../lib/claude-settings-view.js';

test('scalars are shown, containers are counted, anything that can be a secret is only "set"', () => {
  const view = slimResolvedSettings({
    effective: {
      model: 'opus', fastMode: true, cleanupPeriodDays: 30, language: 'x'.repeat(300),
      env: { ANTHROPIC_API_KEY: 'sk-ant-secret', OTHER: '1' },
      apiKeyHelper: '/usr/local/bin/get-key --profile prod',
      otelHeadersHelper: 'cat /secrets/headers',
      awsAuthRefresh: 'aws sso login',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl -H "Authorization: Bearer abc" https://x' }] }] },
      permissions: { defaultMode: 'acceptEdits', allow: ['Bash(npm test:*)', 'Read'], deny: ['Bash(rm:*)'], ask: [] },
      enabledPlugins: { 'a@b': true, 'c@d': true },
      statusLine: { type: 'command', command: 'secret-statusline --token abc' },
    },
    provenance: {
      model: { source: 'user', path: '/home/me/.claude/settings.json' }, fastMode: { source: 'flag' },
      permissions: { source: 'project', path: '/repo/.claude/settings.json' }, env: { source: 'managed', policyOrigin: 'file' },
    },
    sources: [{ source: 'user', path: '/home/me/.claude/settings.json', settings: { model: 'opus', env: { K: 'v' } } }, { source: 'flag', settings: { fastMode: true } }, { nope: 1 }],
  });
  const by = Object.fromEntries(view.rows.map(r => [r.key, r]));
  assert.deepEqual(by.model, { key: 'model', value: 'opus', source: 'your settings', path: '/home/me/.claude/settings.json' });
  assert.deepEqual([by.fastMode.value, by.fastMode.source], ['true', 'session flags']);
  assert.equal(by.cleanupPeriodDays.value, '30');
  assert.equal(by.language.value.length, 120);
  assert.equal(by.permissions.value, 'mode acceptEdits, 2 allow, 1 deny');
  assert.equal(by.enabledPlugins.value, '2 keys');
  assert.equal(by.hooks.value, '1 key');
  for (const key of ['env', 'apiKeyHelper', 'otelHeadersHelper', 'awsAuthRefresh']) assert.equal(by[key].value, 'set', key);
  assert.equal(by.env.source, 'managed policy');
  const wire = JSON.stringify(view);
  for (const secret of ['sk-ant-secret', 'get-key', 'Bearer abc', '/secrets/headers', 'secret-statusline', 'aws sso login']) assert.equal(wire.includes(secret), false, `${secret} leaked`);
  assert.deepEqual(view.sources, [
    { source: 'user', label: 'your settings', path: '/home/me/.claude/settings.json', keys: 2 },
    { source: 'flag', label: 'session flags', path: '', keys: 1 },
  ]);
  assert.deepEqual(view.rows.map(r => r.key), [...view.rows.map(r => r.key)].sort(), 'sorted by key');
  assert.deepEqual(slimResolvedSettings(null), { rows: [], sources: [] });
});

test('the route resolves only for a registered project and is advertised as a capability', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("app.get('/api/claude-code/settings/resolved'"), server.indexOf("app.get('/api/claude-code/settings/resolved'") + 1400);
  assert.match(route, /loadHookProjects\(\)\.some\(p => resolve\(p\.path\) === resolve\(requested\)\)/);
  assert.match(route, /slimResolvedSettings\(await sdk\.resolveSettings\(/);
  assert.match(server, /settingsView: true,/);
});

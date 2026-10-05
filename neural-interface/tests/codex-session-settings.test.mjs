import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexSessionSettingsStore } from '../lib/codex-session-settings.js';

test('session settings persist by account/thread and merge only supported settings', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-settings-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'settings.json');
  const store = new CodexSessionSettingsStore(path);
  store.set('default', 'thread-a', { serviceTier: 'priority', approvalPolicy: 'on-request', ignored: 'value' });
  store.set('default', 'thread-a', { serviceTier: null, disabledPluginIds: ['plugin-a'] });
  store.set('other-account', 'thread-a', { personality: 'friendly' });
  const reopened = new CodexSessionSettingsStore(path);
  assert.deepEqual(reopened.get('default', 'thread-a'), { serviceTier: null, approvalPolicy: 'on-request', disabledPluginIds: ['plugin-a'] });
  assert.deepEqual(reopened.get('other-account', 'thread-a'), { personality: 'friendly' });
  assert.deepEqual(reopened.get('default', 'thread-b'), {});
  assert.equal(readFileSync(path, 'utf8').includes('ignored'), false);
  const detached = reopened.get('default', 'thread-a');
  detached.approvalPolicy = 'never';
  detached.disabledPluginIds.push('plugin-b');
  assert.equal(reopened.get('default', 'thread-a').approvalPolicy, 'on-request');
  assert.deepEqual(reopened.get('default', 'thread-a').disabledPluginIds, ['plugin-a']);
  reopened.set('default', 'thread-a', { disabledPluginIds: [] });
  assert.deepEqual(new CodexSessionSettingsStore(path).get('default', 'thread-a').disabledPluginIds, []);
});

test('malformed existing state is surfaced without overwriting it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-settings-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'settings.json');
  writeFileSync(path, '{malformed');
  const store = new CodexSessionSettingsStore(path);
  assert.throws(() => store.set('default', 'thread-a', { serviceTier: 'priority' }));
  assert.equal(readFileSync(path, 'utf8'), '{malformed');
});

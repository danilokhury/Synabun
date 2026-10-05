import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createAssistantConfigStore, normalizeRouteMode, validateRoutingPatch, effectiveRouting, DEFAULT_ROUTING } from '../lib/assistant-config.js';

function tempPath(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'synabun-assistant-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return resolve(root, 'assistant-config.json');
}

test('route mode aliases', () => {
  assert.equal(normalizeRouteMode('always'), 'always-ask');
  assert.equal(normalizeRouteMode('ASK'), 'always-ask');
  assert.equal(normalizeRouteMode('unsure'), 'ask-unsure');
  assert.equal(normalizeRouteMode('ask-unsure'), 'ask-unsure');
  assert.equal(normalizeRouteMode('autonomous'), 'never');
  assert.equal(normalizeRouteMode('never'), 'never');
  assert.equal(normalizeRouteMode(''), null);
  assert.equal(normalizeRouteMode('sometimes'), null);
});

test('routing patches are validated field by field', () => {
  assert.throws(() => validateRoutingPatch({ defaultMode: 'sometimes' }), (e) => e.code === 'ROUTING_INVALID' && e.field === 'defaultMode');
  assert.throws(() => validateRoutingPatch({ askBelow: 2 }), (e) => e.field === 'askBelow');
  assert.throws(() => validateRoutingPatch({ preferences: { code: { provider: 'nope' } } }), (e) => e.field === 'preferences.code.provider');
  assert.throws(() => validateRoutingPatch({ preferences: { bogus: null } }, { taskClasses: ['code'] }), (e) => e.field === 'preferences.bogus');
  const clean = validateRoutingPatch({ defaultMode: 'always', preferences: { code: { provider: 'claude-code', model: 'sonnet', effort: 'high', kind: 'dispatch' }, review: null } });
  assert.deepEqual(clean, { defaultMode: 'always-ask', preferences: { code: { kind: 'dispatch', provider: 'claude-code', model: 'sonnet', effort: 'high' }, review: null } });
  assert.deepEqual(effectiveRouting({ defaultMode: 'bogus', askBelow: 9 }).defaultMode, DEFAULT_ROUTING.defaultMode);
});

test('store: missing file → defaults; patch writes atomically, keeps unknown keys, versions, 409 on stale version', (t) => {
  const path = tempPath(t);
  const store = createAssistantConfigStore({ path });
  assert.equal(store.routing().defaultMode, 'ask-unsure');
  assert.equal(store.version(), 0);
  writeFileSync(path, JSON.stringify({ defaultBrain: { provider: 'opencode' }, persona: { extra: 'be terse' } }));
  const first = store.patchRouting({ defaultMode: 'never', askBelow: 0.6 });
  assert.equal(first.version, 1);
  assert.equal(first.routing.defaultMode, 'never');
  const onDisk = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(onDisk.defaultBrain, { provider: 'opencode' }, 'unknown keys survive');
  assert.equal(onDisk.persona.extra, 'be terse');
  assert.throws(() => store.patchRouting({ askBelow: 0.5 }, { expectedVersion: 0 }), (e) => e.code === 'VERSION_CONFLICT' && e.status === 409);
  store.patchRouting({ askBelow: 0.5 }, { expectedVersion: 1 });
  assert.equal(store.routing().askBelow, 0.5);
});

test('store: preferences set and delete; hand edits are picked up by mtime', (t) => {
  const path = tempPath(t);
  const store = createAssistantConfigStore({ path, now: () => Date.parse('2026-09-23T10:00:00Z') });
  store.setPreference('code', { kind: 'dispatch', provider: 'claude-code', model: 'sonnet', effort: 'high', label: 'Sonnet 5' });
  assert.deepEqual(store.routing().preferences.code, { kind: 'dispatch', provider: 'claude-code', model: 'sonnet', effort: 'high', label: 'Sonnet 5', at: '2026-09-23T10:00:00.000Z', by: 'user' });
  store.setPreference('code', null);
  assert.equal(store.routing().preferences.code, undefined);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.routing.defaultMode = 'always-ask';
  writeFileSync(path, JSON.stringify(raw));
  const later = new Date(Date.now() + 5000);
  utimesSync(path, later, later);
  assert.equal(store.routing().defaultMode, 'always-ask', 'mtime change reloads');
});

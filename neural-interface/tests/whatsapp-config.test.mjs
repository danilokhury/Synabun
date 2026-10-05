import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWhatsAppConfigStore, currentLevel, effectiveConfig, validateConfigPatch,
  SERVICE_DEFAULTS, SERVICE_FIELDS, USER_DEFAULTS, USER_FIELDS, WHATSAPP_CONFIG_KEY,
} from '../lib/whatsapp/config.js';

function kvStore(initial = null) {
  const kv = { value: initial === null ? null : (typeof initial === 'string' ? initial : JSON.stringify(initial)), gets: 0, sets: 0, keys: new Set() };
  return {
    kv,
    get: (key) => { kv.gets += 1; kv.keys.add(key); return kv.value; },
    set: (key, value) => { kv.sets += 1; kv.keys.add(key); kv.value = value; },
    stored: () => (kv.value ? JSON.parse(kv.value) : null),
  };
}

test('defaults, the kv key, and a corrupt row reads as defaults', () => {
  const s = kvStore();
  const store = createWhatsAppConfigStore({ get: s.get, set: s.set, ttlMs: 0 });
  const cfg = store.read();
  assert.deepEqual(Object.fromEntries(USER_FIELDS.map((k) => [k, cfg[k]])), USER_DEFAULTS);
  assert.deepEqual(USER_DEFAULTS, { enabled: false, level: 'ask', progress: 'key', forwardBackground: true, replyLabel: null, maxMessages: 3, rotation: 'idle6h', selfTrigger: 'all', activityText: false, strictWorkerApprovals: false, computerUse: false, brain: null });
  assert.equal(cfg.mode, 'self');
  assert.equal(cfg.version, 0);
  assert.deepEqual([...s.kv.keys], [WHATSAPP_CONFIG_KEY]);
  assert.equal(WHATSAPP_CONFIG_KEY, 'whatsapp_config');

  const logs = [];
  const broken = kvStore('{not json');
  const store2 = createWhatsAppConfigStore({ get: broken.get, set: broken.set, ttlMs: 0, log: (...args) => logs.push(args) });
  assert.equal(store2.read().level, 'ask');
  assert.equal(logs.length, 1);
  // A bad stored value falls back field by field.
  const odd = effectiveConfig({ level: 'root', maxMessages: 4, replyLabel: 'x'.repeat(40), progress: 'all', mode: 'group', paused: 'yes', owner: { masked: '••••1234', boundAt: 5, via: 'claim' } });
  assert.equal(odd.level, 'ask');
  assert.equal(odd.maxMessages, 3);
  assert.equal(odd.replyLabel, null);
  assert.equal(odd.progress, 'all');
  assert.equal(odd.mode, 'self');
  assert.equal(odd.paused, false);
  assert.deepEqual(odd.owner, { masked: '••••1234', boundAt: 5, via: 'claim' });
});

test('validateConfigPatch: every user field, unknown fields, service-owned fields', () => {
  const ok = validateConfigPatch({ enabled: true, level: 'read-only', progress: 'off', forwardBackground: false, replyLabel: '  Bot  ', maxMessages: 5, rotation: 'never', selfTrigger: 'prefix', activityText: true, strictWorkerApprovals: true });
  assert.equal(ok.replyLabel, 'Bot');
  assert.equal(validateConfigPatch({ replyLabel: '' }).replyLabel, null);
  const bad = [
    ['enabled', 'yes'], ['level', 'root'], ['progress', 'some'], ['forwardBackground', 1], ['replyLabel', 'x'.repeat(25)], ['replyLabel', 'two\nlines'],
    ['replyLabel', 42], ['maxMessages', 2], ['maxMessages', '3'], ['rotation', 'hourly'], ['selfTrigger', 'none'], ['activityText', 'on'], ['strictWorkerApprovals', null],
  ];
  for (const [field, value] of bad) {
    assert.throws(() => validateConfigPatch({ [field]: value }), (e) => e.code === 'CONFIG_INVALID' && e.status === 400 && e.field === field, `${field}=${JSON.stringify(value)}`);
  }
  assert.throws(() => validateConfigPatch({ nope: 1 }), (e) => e.code === 'CONFIG_INVALID' && e.field === 'nope');
  for (const field of [...SERVICE_FIELDS, 'bridgeState', 'setup']) {
    assert.throws(() => validateConfigPatch({ [field]: null }), (e) => e.code === 'CONFIG_INVALID' && e.field === field, field);
  }
  assert.throws(() => validateConfigPatch([]), (e) => e.code === 'CONFIG_INVALID');
});

test('update applies, bumps the version and refuses a stale expectedVersion with 409', () => {
  const s = kvStore();
  const store = createWhatsAppConfigStore({ get: s.get, set: s.set, ttlMs: 0 });
  const first = store.update({ maxMessages: 5 }, { expectedVersion: 0 });
  assert.equal(first.config.maxMessages, 5);
  assert.equal(first.version, 1);
  assert.equal(first.pending, false);
  assert.throws(() => store.update({ maxMessages: 1 }, { expectedVersion: 0 }), (e) => e.code === 'VERSION_CONFLICT' && e.status === 409 && e.version === 1);
  assert.equal(store.update({ maxMessages: 1 }, { expectedVersion: 1 }).version, 2);
  // No change, no new version.
  assert.equal(store.update({ maxMessages: 1 }).version, 2);
  assert.throws(() => store.update({ sessionId: 'x' }), (e) => e.field === 'sessionId');
});

test('raising to autonomous needs confirmEscalation and stays pending; lowering applies at once', () => {
  let t = 1_000_000;
  const s = kvStore();
  const store = createWhatsAppConfigStore({ get: s.get, set: s.set, ttlMs: 0, now: () => t });
  assert.throws(() => store.update({ level: 'autonomous' }), (e) => e.code === 'CONFIRM_REQUIRED' && e.field === 'level' && e.status === 400);
  const pending = store.update({ level: 'autonomous', progress: 'all' }, { confirmEscalation: true });
  assert.equal(pending.pending, true);
  assert.equal(pending.config.level, 'ask', 'the level waits for the phone');
  assert.equal(pending.config.progress, 'all', 'the rest of the patch applied');
  // The service applies it after ALLOW <code>.
  store.write({ level: 'autonomous', autonomousUntil: t + 8 * 3600e3 });
  assert.equal(currentLevel(store.read(), t), 'autonomous');
  // Asking for autonomous while it is on is not a new escalation.
  assert.equal(store.update({ level: 'autonomous' }).pending, false);
  const lowered = store.update({ level: 'read-only' });
  assert.equal(lowered.pending, false);
  assert.equal(lowered.config.level, 'read-only');
  assert.equal(lowered.config.autonomousUntil, null);
  // An expired window reads as ask, and asking for autonomous again escalates again.
  store.write({ level: 'autonomous', autonomousUntil: t + 1000 });
  t += 2000;
  assert.equal(currentLevel(store.read(), t), 'ask');
  assert.throws(() => store.update({ level: 'autonomous' }), (e) => e.code === 'CONFIRM_REQUIRED');
});

test('write is the service path: service fields, the bridge state, unknown keys dropped, version only for user fields', () => {
  const s = kvStore();
  const logs = [];
  const store = createWhatsAppConfigStore({ get: s.get, set: s.set, ttlMs: 0, log: (...a) => logs.push(a) });
  const cfg = store.write({ sessionId: 'assistant-1', previousSessionIds: ['assistant-0'], paused: true, pausedBy: 'phone', bridgeState: { inflight: null }, owner: { masked: '••••4321', boundAt: 9, via: 'self_confirm' }, nope: true, version: 99 });
  assert.equal(cfg.sessionId, 'assistant-1');
  assert.deepEqual(cfg.previousSessionIds, ['assistant-0']);
  assert.equal(cfg.pausedBy, 'phone');
  assert.deepEqual(cfg.bridgeState, { inflight: null });
  assert.equal(cfg.version, 0, 'service fields do not bump the version');
  assert.equal(s.stored().nope, undefined);
  assert.equal(logs.length, 1);
  assert.equal(store.write({ level: 'read-only' }).version, 1, 'a user field written by the service bumps it');
  assert.deepEqual(Object.keys(SERVICE_DEFAULTS).sort(), ['autonomousUntil', 'mode', 'owner', 'pausedBy', 'paused', 'previousSessionIds', 'sessionId', 'version'].sort());
});

test('reads are cached for the TTL; writes and invalidate() drop the cache', () => {
  let t = 0;
  const s = kvStore({ maxMessages: 5 });
  const store = createWhatsAppConfigStore({ get: s.get, set: s.set, ttlMs: 3000, now: () => t });
  store.read();
  store.read();
  assert.equal(s.kv.gets, 1);
  // Another process edits the row: seen after the TTL.
  s.kv.value = JSON.stringify({ maxMessages: 1 });
  t += 2999;
  assert.equal(store.read().maxMessages, 5);
  t += 2;
  assert.equal(store.read().maxMessages, 1);
  s.kv.value = JSON.stringify({ maxMessages: 3 });
  store.invalidate();
  assert.equal(store.read().maxMessages, 3);
});

test('writes through the store are visible at once, inside the TTL: pause, the bridge state, the session ids', () => {
  let t = 0;
  const s = kvStore();
  const store = createWhatsAppConfigStore({ get: s.get, set: s.set, ttlMs: 60_000, now: () => t });
  assert.equal(store.read().paused, false);
  t += 10;
  store.write({ paused: true, pausedBy: 'phone' });
  assert.deepEqual([store.read().paused, store.read().pausedBy], [true, 'phone']);
  store.write({ paused: false, pausedBy: null });
  assert.deepEqual([store.read().paused, store.read().pausedBy], [false, null]);
  const bridgeState = { inflight: null, queuedIds: ['A', 'B'], lastActivityAt: 12, retired: { s0: 1000 } };
  store.write({ bridgeState, sessionId: 's1', previousSessionIds: ['s0', 's-1'] });
  const cfg = store.read();
  assert.deepEqual(cfg.bridgeState, bridgeState);
  assert.equal(cfg.sessionId, 's1');
  assert.deepEqual(cfg.previousSessionIds, ['s0', 's-1']);
  assert.deepEqual(s.stored().bridgeState, bridgeState, 'persisted in the kv row');
  // pausedBy only means something while paused.
  store.write({ paused: false, pausedBy: 'desktop' });
  assert.equal(store.read().pausedBy, null);
});

test('brain: null (same as the Assistant) or { provider, model, effort }; anything else is refused and a bad stored value reads as the default', () => {
  assert.deepEqual(validateConfigPatch({ brain: null }), { brain: null });
  assert.deepEqual(validateConfigPatch({ brain: { provider: 'codex', model: ' gpt-6 ', effort: 'high' } }), { brain: { provider: 'codex', model: 'gpt-6', effort: 'high' } });
  assert.deepEqual(validateConfigPatch({ brain: { provider: 'claude-code', model: 'opus[1m]' } }), { brain: { provider: 'claude-code', model: 'opus[1m]', effort: null } });
  assert.deepEqual(validateConfigPatch({ brain: { provider: 'opencode', model: 'anthropic/claude', effort: 'off' } }).brain.effort, null, '"off" is the model\'s default');
  for (const bad of ['opus', 42, [], { provider: 'gemini', model: 'x' }, { provider: 'codex' }, { provider: 'codex', model: '' }, { provider: 'codex', model: 'x'.repeat(201) }, { provider: 'codex', model: 'a\nb' }, { provider: 'codex', model: 'gpt', effort: 5 }, { provider: 'codex', model: 'gpt', effort: 'very high!' }, { provider: 'codex', model: 'gpt', permissionMode: 'bypassPermissions' }]) {
    assert.throws(() => validateConfigPatch({ brain: bad }), (e) => e.code === 'CONFIG_INVALID' && e.field === 'brain' && e.status === 400, JSON.stringify(bad));
  }
  assert.equal(effectiveConfig({ brain: { provider: 'gemini', model: 'x' } }).brain, null);
  assert.deepEqual(effectiveConfig({ brain: { provider: 'codex', model: 'gpt-6', effort: null } }).brain, { provider: 'codex', model: 'gpt-6', effort: null });
  // A user field like the others: versioned, and a stale expectedVersion is a 409.
  const s = kvStore();
  const store = createWhatsAppConfigStore({ get: s.get, set: s.set, ttlMs: 0 });
  const saved = store.update({ brain: { provider: 'codex', model: 'gpt-6', effort: 'low' } }, { expectedVersion: 0 });
  assert.equal(saved.version, 1);
  assert.deepEqual(s.stored().brain, { provider: 'codex', model: 'gpt-6', effort: 'low' });
  assert.throws(() => store.update({ brain: null }, { expectedVersion: 0 }), (e) => e.code === 'VERSION_CONFLICT' && e.status === 409);
  assert.equal(store.update({ brain: { provider: 'codex', model: 'gpt-6', effort: 'low' } }, { expectedVersion: 1 }).version, 1, 'the same choice changes nothing');
  assert.equal(store.update({ brain: null }, { expectedVersion: 1 }).version, 2);
  assert.equal(store.read().brain, null);
});

test('computerUse: off by default, a boolean only, turned on through update() alone (never by a service write)', () => {
  const s = kvStore();
  const logs = [];
  const store = createWhatsAppConfigStore({ get: s.get, set: s.set, ttlMs: 0, log: (...a) => logs.push(a) });
  assert.equal(USER_DEFAULTS.computerUse, false);
  assert.ok(USER_FIELDS.includes('computerUse'), 'a user-owned field');
  assert.equal(SERVICE_FIELDS.includes('computerUse'), false);
  assert.equal(store.read().computerUse, false, 'the default');
  // A stored config from before the field existed, and a bad stored value, read as off.
  assert.equal(effectiveConfig({ level: 'autonomous', autonomousUntil: Date.now() + 1000 }).computerUse, false);
  for (const bad of ['true', 1, 'on', null, {}, []]) assert.equal(effectiveConfig({ computerUse: bad }).computerUse, false, JSON.stringify(bad));
  // Validated server-side: a boolean, nothing else.
  for (const bad of ['true', 'on', 1, 0, null, {}, []]) {
    assert.throws(() => validateConfigPatch({ computerUse: bad }), (e) => e.code === 'CONFIG_INVALID' && e.field === 'computerUse' && e.status === 400 && /true or false/.test(e.message), JSON.stringify(bad));
    assert.throws(() => store.update({ computerUse: bad }), (e) => e.code === 'CONFIG_INVALID' && e.field === 'computerUse');
  }
  assert.equal(store.read().computerUse, false, 'a refused patch stores nothing');
  // Settings turns it on: versioned like every user field.
  const on = store.update({ computerUse: true }, { expectedVersion: 0 });
  assert.deepEqual([on.config.computerUse, on.version, on.pending], [true, 1, false]);
  assert.throws(() => store.update({ computerUse: false }, { expectedVersion: 0 }), (e) => e.code === 'VERSION_CONFLICT' && e.status === 409);
  assert.equal(store.read().computerUse, true);
  // The service path may turn it off (removing WhatsApp resets every setting)…
  assert.equal(store.write({ computerUse: false }).computerUse, false);
  assert.equal(store.read().version, 2, 'a changed user field bumps the version');
  // …but can never turn it on: only the person at this computer does, through update().
  for (const value of [true, 'true', 1]) assert.equal(store.write({ computerUse: value }).computerUse, false, JSON.stringify(value));
  assert.equal(s.stored().computerUse, false);
  assert.ok(logs.some((row) => row[0] === 'whatsapp:config-ignored' && /computerUse/.test(row[1])));
  assert.equal(store.read().version, 2, 'nothing changed');
});

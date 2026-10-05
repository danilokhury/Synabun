import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SYNABUN_TYPESAFE = 'off';
const { createWhatsAppService, TEST_MESSAGE, formatPairingCode } = await import('../lib/whatsapp/service.js');
const { SERVICE_DEFAULTS } = await import('../lib/whatsapp/config.js');

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const QR_REF = '2@SECRETqrREF0123456789abcdefghijkl,Zm9vYmFy,YmFyYmF6';
const OWNER_DIGITS = '15550001111';

function fakeManager() {
  const listeners = new Map();
  const calls = [];
  let hostState = 'stopped';
  const conn = { state: 'idle', mode: null, registered: false, me: null, owner: null, lastDisconnect: null, retryInMs: null, counters: {}, paused: false, awaitingConfirmUntil: null, claim: null, lastError: null };
  const m = {
    calls, conn, order: null,
    emit(name, payload) { for (const fn of [...(listeners.get(name) || [])]) fn(payload); },
    set(patch) { Object.assign(conn, patch); m.emit('state', m.status()); },
    status: () => ({ host: { state: hostState, pid: 7, restarts: 0, lastError: null }, conn: { ...conn }, runtime: { loaded: hostState === 'running', version: 'fake', fake: true, error: null } }),
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    async start(prefs) { calls.push(['start', prefs]); hostState = 'running'; if (conn.state === 'idle' && !conn.registered) m.set({ state: 'unlinked' }); return { ok: true }; },
    async configure(prefs) { calls.push(['configure', prefs]); return { ok: true }; },
    async connect(args) { calls.push(['connect', args]); m.set({ state: 'connecting' }); return { ok: true }; },
    async disconnect() { calls.push(['disconnect']); m.set({ state: conn.registered ? 'idle' : 'unlinked' }); return { ok: true }; },
    async logout() { calls.push(['logout']); m.set({ state: 'unlinked', registered: false, me: null, owner: null }); return { ok: true }; },
    async confirmOwner(accept) {
      calls.push(['confirmOwner', accept]);
      if (accept) { m.emit('owner_bound', { masked: '••••1111', via: 'self_confirm' }); m.set({ state: 'open', owner: { bound: true, masked: '••••1111' }, awaitingConfirmUntil: null }); }
      else m.set({ state: 'unlinked', registered: false });
      return { ok: true };
    },
    async claimStart({ ttlMs }) { calls.push(['claimStart', ttlMs]); const expiresAt = Date.now() + ttlMs; m.set({ claim: { active: true, expiresAt, attemptsLeft: 5 } }); return { ok: true, code: 'SB-482913', link: `https://wa.me/${OWNER_DIGITS}?text=SB-482913`, expiresAt }; },
    async claimCancel() { calls.push(['claimCancel']); m.set({ claim: null }); return { ok: true }; },
    async ownerReset() { calls.push(['ownerReset']); m.set({ owner: null }); return { ok: true }; },
    async send(text, opts) { calls.push(['send', text, opts]); return { ok: true, id: `OUT${calls.length}` }; },
    async react(id, name) { calls.push(['react', id, name]); return { ok: true }; },
    async presence(value) { calls.push(['presence', value]); return { ok: true }; },
    async markRead(ids) { calls.push(['markRead', ids]); return { ok: true }; },
    async stop() { calls.push(['stop']); m.order?.push('manager'); hostState = 'stopped'; return { ok: true }; },
    killNow() { calls.push(['killNow']); },
    async fake(action, args) { calls.push(['fake', action, args]); return action === 'snapshot' ? { sent: [{ jid: `${OWNER_DIGITS}@s.whatsapp.net`, kind: 'text', text: 'SynaBun: hi', at: 1 }] } : { ok: true }; },
  };
  return m;
}

function fakeInstaller({ installed = true, order = null } = {}) {
  const s = { installed, calls: [] };
  return {
    s,
    status: () => ({ installed: s.installed, version: s.installed ? '7.0.0-rc14' : null, pinned: '7.0.0-rc14', outdated: false, path: null, installedAt: null, approxSizeMB: 29 }),
    async install({ onProgress, signal }) {
      s.calls.push('install');
      order?.push('install');
      onProgress?.({ stage: 'downloading', line: `fetching for ${OWNER_DIGITS}` });
      await tick(20);
      if (signal?.aborted) return { ok: false, code: 'ABORTED', message: 'cancelled' };
      s.installed = true;
      return { ok: true, version: '7.0.0-rc14' };
    },
    async uninstall() { s.calls.push('uninstall'); order?.push('uninstall'); s.installed = false; return { ok: true }; },
    logTail: () => [`npm http fetch for +${OWNER_DIGITS}`],
  };
}

function fakeBridges(order) {
  const made = [];
  const factory = (deps) => {
    const b = {
      deps, inbound: [], connections: [], refreshed: 0, computerOff: [],
      onInbound: async (message) => { b.inbound.push(message); },
      onConnection: (info) => { b.connections.push(info); },
      status: () => ({ sessionId: 'assistant-wa-1', running: false, queued: 0, paused: false, pendingCards: 0, lastReplyAt: null }),
      newSession: async () => 'assistant-wa-2',
      pause: (by) => deps.config.write({ paused: true, pausedBy: by }),
      resume: () => deps.config.write({ paused: false, pausedBy: null }),
      stopAll: async () => ({ ok: true }),
      refresh: () => { b.refreshed += 1; },
      endComputerUse: (reason) => { b.computerOff.push([reason, order.includes('bridge') ? 'after shutdown' : 'before shutdown']); },
      shutdown: async () => { order.push('bridge'); b.down = true; },
    };
    made.push(b);
    return b;
  };
  factory.made = made;
  return factory;
}

function harness(t, { installed = true, stored = null, env = {}, runtime = null, catalog = null, panelBrain = null, authority = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-svc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let kv = stored ? JSON.stringify(stored) : null;
  const broadcasts = [];
  const order = [];
  const manager = fakeManager();
  manager.order = order;
  const installer = fakeInstaller({ installed, order });
  const bridgeFactory = fakeBridges(order);
  let managerMade = 0;
  const service = createWhatsAppService({
    dataHome: dir, port: 3344,
    getKvConfig: () => kv, setKvConfig: (_key, value) => { kv = value; },
    getRuntime: () => runtime,
    broadcastSync: (message) => broadcasts.push(JSON.parse(JSON.stringify(message))),
    managerFactory: () => { managerMade += 1; return manager; },
    installerFactory: () => installer,
    bridgeFactory,
    ...(authority ? { phoneAuthority: authority } : {}),
    env,
    limits: { broadcastDebounceMs: 0 },
    ...(catalog ? { getCatalog: () => catalog } : {}),
    ...(panelBrain ? { getDefaultBrain: () => panelBrain } : {}),
  });
  t.after(() => service.killNow());
  const ops = service._internals.ops;
  const cfg = () => (kv ? JSON.parse(kv) : {});
  const stream = () => {
    const s = { events: [], ended: false, abort: null, write(e) { if (!s.ended) s.events.push(e); return !s.ended; }, end(e) { if (s.ended) return; if (e) s.events.push(e); s.ended = true; }, onAbort(fn) { s.abort = fn; }, get closed() { return s.ended; } };
    return s;
  };
  const settle = async () => { await tick(); service._internals.flushBroadcast(); };
  return { dir, service, ops, manager, installer, bridgeFactory, broadcasts, order, cfg, stream, settle, managerMade: () => managerMade };
}

/** Link in self mode through the whole flow; returns the link stream. */
async function linkSelf(h) {
  const s = h.stream();
  await h.ops.link({ method: 'qr' }, () => s);
  h.manager.emit('qr', { qr: QR_REF, expiresAt: Date.now() + 60_000 });
  h.manager.set({ state: 'qr' });
  h.manager.set({ state: 'connecting' });
  h.manager.set({ state: 'open', registered: true, me: { masked: '••••1111', name: 'Owner Name' } });
  h.manager.emit('linked', { mode: 'self', me: { masked: '••••1111', name: 'Owner Name' } });
  h.manager.set({ state: 'awaiting_confirm', awaitingConfirmUntil: Date.now() + 600_000 });
  return s;
}

function assertNoSecrets(payloads) {
  const banned = new Set(['qr', 'svg', 'qrSvg', 'code', 'number', 'phone', 'name', 'text', 'waMeUrl', 'masked']);
  for (const payload of payloads) {
    const json = JSON.stringify(payload);
    (function walk(value) {
      if (!value || typeof value !== 'object') return;
      for (const [key, inner] of Object.entries(value)) { assert.equal(banned.has(key), false, `broadcast key "${key}" in ${json}`); walk(inner); }
    })(payload);
    for (const secret of ['SECRETqrREF', 'SB-482913', 'ABCD-2345', 'ABCD2345', OWNER_DIGITS, '5550001111', 'Owner Name', '<svg', 'hello from the phone']) assert.equal(json.includes(secret), false, `${secret} in ${json}`);
    assert.deepEqual(Object.keys(payload).sort(), ['brain', 'computerUse', 'connector', 'counters', 'levelExpiresAt', 'level', 'mode', 'paused', 'pausedBy', 'phase', 'rev', 'state', 'type', 'v'].sort());
    assert.equal(typeof payload.computerUse, 'boolean', 'the computer-use switch: a flag, nothing else');
    assert.ok(payload.brain === null || Object.keys(payload.brain).sort().join() === 'effort,model,provider', 'the brain choice: ids only');
    assert.equal(payload.type, 'whatsapp:status');
    assert.deepEqual(Object.keys(payload.connector).sort(), ['errorCode', 'installed', 'stage', 'updateAvailable']);
  }
}

test('nothing starts when the connector is not installed; SYNABUN_WHATSAPP=off is unavailable and builds nothing', async (t) => {
  const h = harness(t, { installed: false, stored: { enabled: true, owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await h.service.start();
  assert.equal(h.manager.calls.some(([k]) => k === 'start'), false);
  assert.equal(h.service.status().state, 'not_installed');
  const off = harness(t, { env: { SYNABUN_WHATSAPP: 'off' } });
  await off.service.start();
  assert.equal(off.managerMade(), 0);
  assert.equal(off.service.status().state, 'unavailable');
  await assert.rejects(() => off.ops.setup({ mode: 'self', method: 'qr' }), (e) => e.code === 'UNAVAILABLE' && e.status === 409);
});

test('autostart only when installed, enabled and linked; events reach the bridge', async (t) => {
  const idle = harness(t, { stored: { enabled: false, owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await idle.service.start();
  assert.equal(idle.manager.calls.some(([k]) => k === 'start'), false, 'not enabled: no start');
  assert.equal(idle.service.status().state, 'paused');

  const h = harness(t, { stored: { enabled: true, mode: 'self', owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await h.service.start();
  assert.deepEqual(h.manager.calls.filter(([k]) => k === 'start' || k === 'connect').map(([k, a]) => [k, a]), [['start', { mode: 'self', selfTrigger: 'all' }], ['connect', { purpose: 'run', mode: 'self' }]]);
  assert.equal(h.bridgeFactory.made.length, 1);
  const bridge = h.bridgeFactory.made[0];
  assert.equal(typeof bridge.deps.format.toWhatsApp, 'function');
  assert.equal(typeof bridge.deps.inbound.createCoalescer, 'function');
  assert.equal('policy' in bridge.deps, false, 'the bridge keeps the process-wide remote-policy registry');
  h.manager.set({ state: 'open', registered: true, owner: { bound: true, masked: '••••1111' } });
  assert.equal(bridge.connections.at(-1).connected, true);
  assert.equal(bridge.connections.at(-1).state, 'open');
  assert.deepEqual(bridge.connections.at(-1), { connected: true, state: 'open' });
  const seen = bridge.connections.length;
  h.manager.set({ counters: { accepted: 1 } });
  assert.equal(bridge.connections.length, seen + 1, 'every state change reaches the bridge, not only flips');
  assert.equal(h.service.status().state, 'connected');
  const message = { id: 'IN1', ts: Date.now(), chat: 'self', text: 'hello from the phone', images: [], unsupported: null, forwarded: false, quoted: null, owner: true };
  h.manager.emit('inbound', message);
  assert.deepEqual(bridge.inbound, [message], 'the manager hands over the InboundMessage itself');
  h.manager.emit('inbound', { message: { ...message, id: 'IN0' } });
  assert.equal(bridge.inbound.at(-1).id, 'IN0', 'a {message} wrapper is accepted too');
  h.manager.emit('inbound', { ...message, owner: false });
  assert.equal(bridge.inbound.length, 2, 'never a non-owner message');
  // The transport adapter sends through the manager and says connected.
  assert.equal(bridge.deps.transport.connected(), true);
  await bridge.deps.transport.send('SynaBun: hi', { replyTo: 'IN1' });
  assert.deepEqual(h.manager.calls.find(([k]) => k === 'send').slice(1), ['SynaBun: hi', { replyTo: 'IN1' }]);
  h.manager.set({ state: 'reconnecting', retryInMs: 5000 });
  assert.equal(bridge.connections.at(-1).connected, false);
  assert.equal(bridge.connections.at(-1).state, 'reconnecting');
  assert.equal(h.service.status().state, 'reconnecting');
  assert.ok(h.service.status().connection.nextRetryAt > Date.now());
});

test('linking streams the QR to the asking tab only; phases; confirm owner; every broadcast is secret-free', async (t) => {
  const h = harness(t);
  await h.service.start();
  const setup = await h.ops.setup({ mode: 'self', method: 'qr' });
  assert.equal(setup.next, 'link');
  assert.equal(h.cfg().enabled, true);
  const s = h.stream();
  await h.ops.link({ method: 'qr' }, () => s);
  assert.deepEqual(h.manager.calls.find(([k]) => k === 'connect')[1], { purpose: 'link', mode: 'self', link: { method: 'qr' } });
  assert.equal(h.service.status().state, 'linking');
  assert.equal(h.service.status().phase, 'starting');
  await assert.rejects(() => h.ops.link({ method: 'qr' }, () => h.stream()), (e) => e.code === 'LINK_BUSY' && e.status === 409, 'one link at a time');
  h.manager.emit('qr', { qr: QR_REF, expiresAt: Date.now() + 60_000 });
  const qr = s.events.find((e) => e.type === 'qr');
  assert.match(qr.svg, /^<svg /);
  assert.equal(qr.svg.includes('SECRET'), false, 'the raw ref is drawn, never written');
  assert.equal(h.service.status().phase, 'waiting');
  await h.settle();
  h.manager.set({ state: 'qr' });
  h.manager.set({ state: 'connecting' });
  assert.equal(h.service.status().phase, 'scanned');
  h.manager.set({ state: 'open', registered: true, me: { masked: '••••1111', name: 'Owner Name' } });
  h.manager.emit('linked', { mode: 'self', me: { masked: '••••1111', name: 'Owner Name' } });
  assert.deepEqual(s.events.at(-1), { type: 'linked', mode: 'self' });
  assert.equal(s.ended, true);
  h.manager.set({ state: 'awaiting_confirm', awaitingConfirmUntil: Date.now() + 600_000 });
  const confirm = h.service.status();
  assert.equal(confirm.state, 'confirm_owner');
  assert.equal(confirm.kind, 'self');
  assert.deepEqual(confirm.account, { masked: '••••1111', name: 'Owner Name' });
  await h.settle();
  await h.ops.confirmOwner({ accept: true });
  assert.equal(h.cfg().owner.masked, '••••1111');
  assert.equal(h.service.status().state, 'connected');
  await h.settle();
  // Status is masked too: no QR, SVG or digits anywhere.
  const status = JSON.stringify(h.service.status());
  for (const secret of ['SECRETqrREF', '<svg', OWNER_DIGITS]) assert.equal(status.includes(secret), false, secret);
  assert.ok(h.broadcasts.length >= 3);
  assertNoSecrets(h.broadcasts);
  const revs = h.broadcasts.map((b) => b.rev);
  assert.deepEqual(revs, [...revs].sort((a, b) => a - b), 'rev only grows');
});

test('a pairing code goes to the stream (formatted), a bad number never reaches the host', async (t) => {
  const h = harness(t);
  await assert.rejects(() => h.ops.link({ method: 'code', phone: '07911 123456' }, () => h.stream()), (e) => e.code === 'BAD_PHONE' && e.field === 'phone' && e.status === 400);
  assert.equal(h.manager.calls.some(([k]) => k === 'connect'), false);
  const s = h.stream();
  await h.ops.link({ method: 'code', phone: '+1 (555) 000-1111' }, () => s);
  assert.deepEqual(h.manager.calls.find(([k]) => k === 'connect')[1].link, { method: 'code', phone: OWNER_DIGITS });
  h.manager.emit('pairing_code', { code: 'ABCD2345', expiresAt: Date.now() + 180_000 });
  assert.equal(s.events.find((e) => e.type === 'pairing_code').code, 'ABCD-2345');
  assert.equal(formatPairingCode('abcd2345'), 'ABCD-2345');
  await h.settle();
  assertNoSecrets(h.broadcasts);
});

test('closing the link stream disconnects and stops the host; an expired link reads as link_expired', async (t) => {
  const h = harness(t);
  const s = h.stream();
  await h.ops.link({ method: 'qr' }, () => s);
  h.manager.emit('qr', { qr: QR_REF, expiresAt: Date.now() + 60_000 });
  s.abort();
  await tick(10);
  assert.ok(h.manager.calls.some(([k]) => k === 'disconnect'), 'disconnect');
  assert.ok(h.manager.calls.some(([k]) => k === 'stop'), 'the host stops (nothing linked)');
  assert.notEqual(h.service.status().state, 'linking');
  // A link that ran out.
  const s2 = h.stream();
  await h.ops.link({ method: 'qr' }, () => s2);
  h.manager.set({ state: 'qr' });
  h.manager.set({ state: 'link_expired' });
  assert.deepEqual(s2.events.at(-1), { type: 'state', state: 'link_expired' });
  await tick(10);
  assert.equal(h.service.status().state, 'link_expired');
});

test('dedicated mode: the claim stream carries the code, masked target and wa.me QR; binding ends it', async (t) => {
  const h = harness(t, { stored: { enabled: true, mode: 'dedicated', setup: { linkedAt: 1 } } });
  await h.service.start();
  h.manager.set({ state: 'open', registered: true, mode: 'dedicated', me: { masked: '••••9999', name: 'Bot' } });
  assert.deepEqual([h.service.status().state, h.service.status().kind], ['confirm_owner', 'code']);
  const s = h.stream();
  await h.ops.claimOwner({}, () => s);
  const claim = s.events[0];
  assert.equal(claim.type, 'claim');
  assert.equal(claim.code, 'SB-482913');
  assert.equal(claim.sendTo, '••••1111');
  assert.equal(claim.waMeUrl, `https://wa.me/${OWNER_DIGITS}?text=SB-482913`);
  assert.match(claim.qrSvg, /^<svg /);
  assert.equal(claim.attemptsLeft, 5);
  h.manager.set({ claim: { active: true, expiresAt: Date.now() + 1000, attemptsLeft: 4 } });
  assert.equal(s.events.at(-1).attemptsLeft, 4);
  h.manager.emit('owner_bound', { masked: '••••3333', via: 'claim' });
  assert.deepEqual(s.events.at(-1), { type: 'bound', masked: '••••3333' });
  assert.equal(s.ended, true);
  assert.equal(h.cfg().owner.via, 'claim');
  await h.settle();
  assertNoSecrets(h.broadcasts);
});

test('Autonomous: armed on the desktop, confirmed by ALLOW <code> from the phone within 5 minutes', async (t) => {
  const h = harness(t, { stored: { enabled: true, owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await h.service.start();
  await assert.rejects(() => h.ops.putConfig({ config: { level: 'autonomous' }, confirmEscalation: true }), (e) => e.code === 'PHONE_REQUIRED', 'the phone has to be there');
  h.manager.set({ state: 'open', registered: true, owner: { bound: true, masked: '••••1111' } });
  await assert.rejects(() => h.ops.putConfig({ config: { level: 'autonomous' } }), (e) => e.code === 'CONFIRM_REQUIRED');
  const r = await h.ops.putConfig({ config: { level: 'autonomous' }, confirmEscalation: true });
  assert.match(r.pending.code, /^\d{4}$/);
  assert.equal(r.config.level, 'ask', 'not yet');
  assert.ok(h.manager.calls.some(([k, text]) => k === 'send' && /ALLOW/.test(text) && !text.includes(r.pending.code)), 'the phone is told, without the code');
  const bridge = h.bridgeFactory.made[0];
  const wrong = r.pending.code === '0000' ? '1111' : '0000';
  const allow = (text, extra = {}) => h.manager.emit('inbound', { id: `A${Math.random()}`, ts: Date.now(), chat: 'self', text, images: [], unsupported: null, forwarded: false, quoted: null, owner: true, ...extra });
  allow(`ALLOW ${r.pending.code}`, { forwarded: true });
  assert.equal(h.service.status().level, 'ask', 'a forwarded ALLOW is not the owner typing it');
  allow(`allow ${wrong}`);
  assert.equal(h.service.status().level, 'ask');
  assert.equal(h.service.status().escalation.attemptsLeft, 2);
  allow(`  Allow ${r.pending.code} `);
  const status = h.service.status();
  assert.equal(status.level, 'autonomous');
  assert.ok(status.levelExpiresAt > Date.now() + 7.9 * 3600e3);
  assert.equal(status.escalation, null);
  assert.equal(bridge.inbound.some((m) => /allow/i.test(m.text) && !m.forwarded), false, 'ALLOW messages never reach the Assistant');
  assert.ok(bridge.refreshed > 0);
  // Lowering applies at once.
  const low = await h.ops.putConfig({ config: { level: 'ask' } });
  assert.equal(low.config.level, 'ask');
  assert.equal(h.service.status().level, 'ask');
  await h.settle();
  assertNoSecrets(h.broadcasts);
  assert.equal(JSON.stringify(h.service.status()).includes(`"code":"${r.pending.code}"`), false, 'the ALLOW code is only in the PUT answer');
});

test('ALLOW answers are consumed before anything is logged: with message text kept, no activity row or log line holds the code', async (t) => {
  const h = harness(t, { stored: { enabled: true, activityText: true, owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await h.service.start();
  h.manager.set({ state: 'open', registered: true, owner: { bound: true, masked: '••••1111' } });
  const r = await h.ops.putConfig({ config: { level: 'autonomous' }, confirmEscalation: true });
  const code = r.pending.code;
  const wrong = code === '0000' ? '1111' : '0000';
  const inbound = (text, extra = {}) => h.manager.emit('inbound', { id: `A${Math.random()}`, ts: Date.now(), chat: 'self', text, images: [], unsupported: null, forwarded: false, quoted: null, owner: true, ...extra });
  inbound(`ALLOW ${wrong}`);
  inbound(`ALLOW ${code}`, { forwarded: true });
  inbound(`allow ${code}`);
  assert.equal(h.service.status().level, 'autonomous');
  inbound(`ALLOW ${code}`); // late: nothing waits any more (the echo window)
  const rows = h.ops.listActivity({ limit: 200 }).entries;
  // Without the timestamps: an epoch such as 1791000075787 contains "0000" by itself.
  const dump = JSON.stringify(rows.map(({ at: _at, ...row }) => row));
  assert.equal(dump.includes(code), false, `the code is in the activity: ${dump}`);
  assert.equal(dump.includes(wrong), false, 'a wrong code neither');
  assert.ok(rows.some((e) => e.kind === 'inbound' && /ALLOW code/.test(e.detail)), 'the arrival is still recorded, without the code');
  const logsDir = h.service._internals.paths.logsDir;
  const file = readdirSync(logsDir).find((name) => /^whatsapp-\d{8}\.log$/.test(name));
  const log = readFileSync(join(logsDir, file), 'utf8');
  assert.equal(log.includes(code), false, 'nor in the log file');
  assert.equal(log.includes(wrong), false);
});

test('unlink logs out, stops the bridge and host, and resets every service-owned field', async (t) => {
  const h = harness(t, { stored: { enabled: true, sessionId: 'assistant-wa-1', previousSessionIds: ['assistant-wa-0'], paused: true, pausedBy: 'phone', owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' }, level: 'autonomous', autonomousUntil: Date.now() + 3600e3, setup: { linkedAt: 1 } } });
  await h.service.start();
  h.manager.set({ state: 'open', registered: true, owner: { bound: true, masked: '••••1111' } });
  const r = await h.ops.unlink();
  assert.equal(r.loggedOut, true);
  assert.ok(h.manager.calls.some(([k]) => k === 'logout'));
  assert.equal(h.bridgeFactory.made[0].down, true);
  const cfg = h.cfg();
  for (const [key, value] of Object.entries(SERVICE_DEFAULTS)) if (key !== 'version') assert.deepEqual(cfg[key], value, key);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.level, 'ask', 'autonomous does not survive an unlink');
  assert.equal(cfg.setup, null);
  assert.equal(h.service.status().state, 'ready');
});

test('shutdown stops the bridge before the manager; killNow is immediate', async (t) => {
  const h = harness(t, { stored: { enabled: true, owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await h.service.start();
  await h.service.shutdown({ timeoutMs: 100 });
  assert.deepEqual(h.order, ['bridge', 'manager']);
  assert.equal(h.manager.listenerCount(), 0, 'event listeners released');
  const k = harness(t, { stored: { enabled: true, owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await k.service.start();
  k.service.killNow();
  assert.ok(k.manager.calls.some(([c]) => c === 'killNow'));
  assert.equal(k.bridgeFactory.made[0].down, true);
});

test('activity: redacted, text only when activityText is on, a 0600 log file, 7-day retention', async (t) => {
  const h = harness(t, { stored: { enabled: true, owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  const logsDir = h.service._internals.paths.logsDir;
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, 'whatsapp-20000101.log'), 'old\n');
  writeFileSync(join(logsDir, 'other.log'), 'not ours\n');
  await h.service.start();
  assert.equal(readdirSync(logsDir).includes('whatsapp-20000101.log'), false, 'older than 7 days: deleted');
  assert.equal(readdirSync(logsDir).includes('other.log'), true);
  h.manager.set({ state: 'open', registered: true, owner: { bound: true, masked: '••••1111' } });
  const message = { id: 'IN1', ts: Date.now(), chat: 'self', text: `call me at +${OWNER_DIGITS}`, images: [], unsupported: null, forwarded: false, quoted: null, owner: true };
  h.manager.emit('inbound', message);
  let rows = h.ops.listActivity({ limit: 50 }).entries;
  assert.equal(rows.find((e) => e.kind === 'inbound').text, undefined, 'no text while activityText is off');
  await h.ops.putConfig({ config: { activityText: true } });
  h.manager.emit('inbound', message);
  rows = h.ops.listActivity({ limit: 50 }).entries;
  const withText = rows.find((e) => e.kind === 'inbound' && e.text);
  assert.ok(withText);
  assert.equal(withText.text.includes(OWNER_DIGITS), false, 'redacted');
  const file = readdirSync(logsDir).find((name) => /^whatsapp-\d{8}\.log$/.test(name));
  assert.ok(file);
  if (process.platform !== 'win32') assert.equal(statSync(join(logsDir, file)).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(logsDir, file), 'utf8').includes(OWNER_DIGITS), false);
  h.ops.clearActivity();
  assert.equal(h.ops.listActivity({}).entries.length, 0);
  assert.equal(readdirSync(logsDir).some((name) => name.startsWith('whatsapp-')), false);
  // The connector log is redacted on the way out too.
  assert.equal(h.ops.connectorLog({}).lines.join('\n').includes(OWNER_DIGITS), false);
});

test('setup installs first when needed, test messages are rate limited, pause is by the desktop', async (t) => {
  const h = harness(t, { installed: false });
  await h.service.start();
  const r = await h.ops.setup({ mode: 'self', method: 'qr' });
  assert.equal(r.next, 'install');
  assert.equal(h.service.status().state, 'installing');
  await tick(60);
  assert.equal(h.installer.s.installed, true);
  assert.equal(h.service.status().state, 'ready');
  await assert.rejects(() => h.ops.setup({ mode: 'group' }), (e) => e.code === 'BAD_MODE' && e.field === 'mode');
  assert.equal(JSON.stringify(h.cfg()).includes('phone'), false, 'the setup intent never stores a number');

  const c = harness(t, { stored: { enabled: true, owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await c.service.start();
  c.manager.set({ state: 'open', registered: true, owner: { bound: true, masked: '••••1111' } });
  await c.ops.test();
  assert.ok(c.manager.calls.some(([k, text]) => k === 'send' && text === TEST_MESSAGE));
  await assert.rejects(() => c.ops.test(), (e) => e.code === 'RATE_LIMITED' && e.status === 429 && e.retryAfterMs > 0);
  c.ops.pause({ by: 'agent' });
  assert.deepEqual([c.cfg().paused, c.cfg().pausedBy], [true, 'desktop']);
  assert.equal(c.service.status().state, 'paused');
  await c.ops.resume();
  assert.equal(c.service.status().state, 'connected');
});

test('fake actions exist only with SYNABUN_WHATSAPP_FAKE=1 and never return a JID', async (t) => {
  const plain = harness(t);
  await assert.rejects(() => plain.ops.fake({ action: 'scan' }), (e) => e.status === 404);
  const h = harness(t, { env: { SYNABUN_WHATSAPP_FAKE: '1' } });
  const r = await h.ops.fake({ action: 'inbound', from: 'owner', text: 'hi' });
  assert.deepEqual(h.manager.calls.find(([k, a]) => k === 'fake' && a === 'inbound')[2], { from: 'self', text: 'hi' });
  assert.equal(JSON.stringify(r.sent).includes('@s.whatsapp.net'), false);
  assert.deepEqual(r.sent[0], { kind: 'text', text: 'SynaBun: hi', react: null, at: 1 });
  await h.ops.fake({ action: 'ban' });
  assert.ok(h.manager.calls.some(([k, a]) => k === 'fake' && a === 'forbidden'));
  await assert.rejects(() => h.ops.fake({ action: 'nope' }), (e) => e.code === 'BAD_ACTION');
});

test('logged out and banned read as logged_out with a reason that survives the host stopping', async (t) => {
  const h = harness(t, { stored: { enabled: true, owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await h.service.start();
  h.manager.set({ state: 'open', registered: true, owner: { bound: true, masked: '••••1111' } });
  h.manager.set({ state: 'logged_out', registered: false });
  assert.deepEqual([h.service.status().state, h.service.status().reason], ['logged_out', 'removed']);
  h.manager.set({ state: 'idle' });
  assert.deepEqual([h.service.status().state, h.service.status().reason], ['logged_out', 'removed'], 'remembered in the config');
  const b = harness(t, { stored: { enabled: true, owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await b.service.start();
  b.manager.set({ state: 'open', registered: true });
  b.manager.set({ state: 'forbidden' });
  assert.deepEqual([b.service.status().state, b.service.status().reason], ['logged_out', 'banned']);
});

test('selfTrigger "prefix" (Message yourself): only "sb " / "sb:" messages reach the bridge, stripped; commands, ALLOW and replies to SynaBun always pass; notes are never logged; the host always gets selfTrigger "all"', async (t) => {
  const h = harness(t, { stored: { enabled: true, mode: 'self', selfTrigger: 'prefix', activityText: true, owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await h.service.start();
  assert.deepEqual(h.manager.calls.find(([k]) => k === 'start')[1], { mode: 'self', selfTrigger: 'all' }, 'the host never filters: its prefix filter would drop /stop');
  for (const [k, prefs] of h.manager.calls) if (k === 'configure') assert.equal(prefs.selfTrigger, 'all');
  h.manager.set({ state: 'open', registered: true, owner: { bound: true, masked: '••••1111' } });
  const bridge = h.bridgeFactory.made[0];
  let n = 0;
  const send = (text, extra = {}) => h.manager.emit('inbound', { id: `M${++n}`, ts: Date.now(), chat: 'self', text, images: [], unsupported: null, forwarded: false, quoted: null, owner: true, ...extra });
  send('buy milk and eggs');
  send('sbrown is not a trigger');
  send('sb');
  send('remember to call mum', { forwarded: true });
  assert.equal(bridge.inbound.length, 0, 'notes to self stay out of the bridge');
  assert.equal(JSON.stringify(h.ops.listActivity({ limit: 50 }).entries).includes('milk'), false, 'and out of the activity log');
  send('sb what is on my calendar?');
  send('SB: summarize the repo');
  send('sb:no space');
  send('/stop');
  send('/status');
  send('1', { quoted: { id: 'OUT1', text: 'Allow running npm test? 1 allow, 2 deny', fromBot: true } });
  assert.deepEqual(bridge.inbound.map((m) => m.text), ['what is on my calendar?', 'summarize the repo', 'no space', '/stop', '/status', '1']);
  assert.equal(bridge.inbound[0].id, 'M5', 'the rest of the message is untouched');
  send('/nonsense');
  send('sb', { images: [{ base64: 'AA==', mediaType: 'image/png', bytes: 1 }] });
  assert.equal(bridge.inbound.length, 7, 'an unknown slash text is a note; "sb" + a picture is for SynaBun');
  assert.equal(bridge.inbound.at(-1).text, '');
  // Switching the trigger never reconfigures the host.
  const configures = h.manager.calls.filter(([k]) => k === 'configure').length;
  await h.ops.putConfig({ config: { selfTrigger: 'all' } });
  await h.ops.putConfig({ config: { selfTrigger: 'prefix' } });
  assert.equal(h.manager.calls.filter(([k]) => k === 'configure').length, configures);
  // The ALLOW answer passes without "sb" (and with it); the phone is told plain ALLOW.
  const r = await h.ops.putConfig({ config: { level: 'autonomous' }, confirmEscalation: true });
  assert.ok(h.manager.calls.some(([k, text]) => k === 'send' && /reply ALLOW followed/.test(text)));
  send(`ALLOW ${r.pending.code}`);
  assert.equal(h.service.status().level, 'autonomous');
  assert.equal(bridge.inbound.length, 7, 'ALLOW never reaches the Assistant');
  // Dedicated mode ignores selfTrigger.
  const d = harness(t, { stored: { enabled: true, mode: 'dedicated', selfTrigger: 'prefix', owner: { masked: '••••3333', boundAt: 1, via: 'claim' } } });
  await d.service.start();
  d.manager.set({ state: 'open', registered: true, owner: { bound: true, masked: '••••3333' } });
  d.manager.emit('inbound', { id: 'D1', ts: Date.now(), chat: 'dm', text: 'hello', images: [], unsupported: null, forwarded: false, quoted: null, owner: true });
  assert.deepEqual(d.bridgeFactory.made[0].inbound.map((m) => m.text), ['hello']);
});

test('owner reset is for the second-number mode only; install and uninstall stop the host first', async (t) => {
  const h = harness(t, { stored: { enabled: true, mode: 'self', owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await h.service.start();
  await assert.rejects(() => h.ops.resetOwner(), (e) => e.code === 'WRONG_MODE' && e.status === 409);
  assert.equal(h.manager.calls.some(([k]) => k === 'ownerReset'), false, 'never sent to the host in self mode');
  const d = harness(t, { stored: { enabled: true, mode: 'dedicated', owner: { masked: '••••3333', boundAt: 1, via: 'claim' } } });
  await d.service.start();
  d.manager.set({ state: 'open', registered: true, mode: 'dedicated', owner: { bound: true, masked: '••••3333' } });
  await d.ops.resetOwner();
  d.manager.set({ owner: null });
  assert.ok(d.cfg().setup.linkedAt, 'the second account is still linked after an owner reset');
  assert.equal(d.service.status().state, 'confirm_owner', 'waiting for a new claim');
  assert.ok(d.manager.calls.some(([k]) => k === 'ownerReset'));
  // An update with the host running: stop, install, then the linked session comes back.
  await d.ops.installConnector({ update: true });
  for (let i = 0; i < 40 && d.installer.s.calls.length === 0; i++) await tick(5);
  await tick(60);
  assert.deepEqual(d.order.filter((x) => x === 'manager' || x === 'install').slice(0, 2), ['manager', 'install'], 'stopped before installing');
  assert.ok(d.manager.calls.filter(([k]) => k === 'start').length >= 2, 'restarted after the install');
  // Remove: the host stops before the connector is uninstalled.
  d.order.length = 0;
  await d.ops.remove({});
  assert.ok(d.order.indexOf('manager') !== -1 && d.order.indexOf('manager') < d.order.indexOf('uninstall'), JSON.stringify(d.order));
});

test('the bridge persists its state through the service config, and pause/resume written there show at once', async (t) => {
  const h = harness(t, { stored: { enabled: true, owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await h.service.start();
  h.manager.set({ state: 'open', registered: true, owner: { bound: true, masked: '••••1111' } });
  const { config } = h.bridgeFactory.made[0].deps;
  config.write({ bridgeState: { inflight: { sourceIds: ['IN1'], startedAt: 5 }, queuedIds: ['IN2'], lastActivityAt: 7, retired: { 'assistant-wa-0': 99 } }, sessionId: 'assistant-wa-1', previousSessionIds: ['assistant-wa-0'] });
  const stored = h.cfg();
  assert.deepEqual(stored.bridgeState, { inflight: { sourceIds: ['IN1'], startedAt: 5 }, queuedIds: ['IN2'], lastActivityAt: 7, retired: { 'assistant-wa-0': 99 } });
  assert.equal(stored.sessionId, 'assistant-wa-1');
  assert.deepEqual(stored.previousSessionIds, ['assistant-wa-0']);
  assert.deepEqual(config.read().bridgeState.queuedIds, ['IN2']);
  config.write({ paused: true, pausedBy: 'phone' });
  assert.deepEqual([config.read().paused, config.read().pausedBy], [true, 'phone'], 'no TTL wait after a write through the same store');
  assert.deepEqual([h.service.status().state, h.service.status().pausedBy], ['paused', 'phone']);
  config.write({ paused: false, pausedBy: null });
  assert.equal(h.service.status().state, 'connected');
  assert.equal(h.service.status().session.id, 'assistant-wa-1');
});

test('status says when the WhatsApp conversation runs read-only because of its brain (the Settings warning)', async (t) => {
  const runtime = { getSession: (id) => (id === 'assistant-wa-1' ? { id, title: 'WhatsApp · Sep 28', brain: { provider: 'opencode' } } : null) };
  const h = harness(t, { runtime, stored: { enabled: true, level: 'ask', sessionId: 'assistant-wa-1', owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await h.service.start();
  h.manager.set({ state: 'open', registered: true, owner: { bound: true, masked: '••••1111' } });
  assert.deepEqual(h.service.status().brainLimit, { provider: 'opencode', label: 'OpenCode', text: 'This conversation runs read-only because its brain is OpenCode; switch the WhatsApp brain to Claude for Ask/Autonomous.' });
  await h.ops.putConfig({ config: { level: 'read-only' } });
  assert.equal(h.service.status().brainLimit, null, 'read-only anyway: nothing to explain');
});

test('a session store that cannot be made private is an AUTH_PERMS error the tab explains', async (t) => {
  const h = harness(t, { stored: { enabled: true, owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await h.service.start();
  h.manager.emit('fatal', { code: 'AUTH_PERMS', message: 'SynaBun could not make the WhatsApp session files private' });
  h.manager.set({ state: 'error', lastError: 'the WhatsApp session files could not be made private' });
  const status = h.service.status();
  assert.equal(status.state, 'error');
  assert.equal(status.code, 'AUTH_PERMS');
  assert.ok(h.ops.listActivity({}).entries.some((e) => e.kind === 'error' && /could not be made private/.test(e.detail)), 'a readable activity row');
});

/** A catalog value shaped like lib/assistant-catalog.js builds it: enabled rows in `models`, the user's disabled ids in `hidden`. */
function catalogValue(hidden = {}) {
  const rows = {
    'claude-code': [{ id: 'opus', provider: 'claude-code', label: 'Opus', efforts: ['low', 'high'], isDefault: true }, { id: 'haiku', provider: 'claude-code', label: 'Haiku', efforts: [] }],
    codex: [{ id: 'gpt-6', provider: 'codex', label: 'GPT-6', efforts: ['low', 'medium', 'high'] }],
    opencode: [],
  };
  const off = (p) => hidden[p] || [];
  return {
    models: Object.fromEntries(Object.entries(rows).map(([p, list]) => [p, list.filter((row) => !off(p).includes(row.id))])),
    hiddenRows: Object.fromEntries(Object.entries(rows).map(([p, list]) => [p, list.filter((row) => off(p).includes(row.id))])),
    hidden: { 'claude-code': off('claude-code'), codex: off('codex'), opencode: [] },
    listed: { 'claude-code': 2, codex: 1, opencode: 0 }, known: { opencode: true },
  };
}
function fakeCatalog(hidden = {}) {
  const catalog = { value: catalogValue(hidden), forced: 0, peek: () => catalog.value, full: async (opts = {}) => { if (opts.force) catalog.forced += 1; return catalog.value; } };
  return catalog;
}
const LINKED = { enabled: true, owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } };

test('the WhatsApp model: default "same as the Assistant"; a choice is checked against the Assistant\'s catalog before it is stored (unknown or disabled → 400)', async (t) => {
  const catalog = fakeCatalog({ 'claude-code': ['haiku'] });
  const h = harness(t, { catalog, panelBrain: { provider: 'claude-code', model: 'opus' }, stored: LINKED });
  await h.service.start();
  const first = h.service.status();
  assert.equal(first.config.brain, null);
  assert.deepEqual(first.brainChoice, {
    choice: null, source: 'assistant', fallback: null, readOnly: null, checked: true,
    effective: { provider: 'claude-code', providerLabel: 'Claude', model: 'opus', modelLabel: 'Opus', effort: null },
  });
  // Unknown provider, model or effort, and a model the user disabled: 400, and nothing is stored.
  const refused = [
    [{ provider: 'gemini', model: 'x' }, /provider of claude-code, codex or opencode/],
    [{ provider: 'codex', model: 'gpt-9' }, /Codex does not list a model called "gpt-9"/],
    [{ provider: 'codex', model: 'gpt-6', effort: 'ultra' }, /GPT-6 does not run the effort "ultra" \(it has low, medium, high\)/],
    [{ provider: 'claude-code', model: 'haiku' }, /haiku is disabled in the Assistant's Models list/],
    [{ provider: 'opencode', model: 'anthropic/claude' }, /OpenCode does not list a model called "anthropic\/claude"/],
    ['opus', /brain must be null/],
  ];
  for (const [brain, re] of refused) {
    await assert.rejects(() => h.ops.putConfig({ config: { brain } }), (e) => e.status === 400 && e.code === 'CONFIG_INVALID' && e.field === 'brain' && re.test(e.message), JSON.stringify(brain));
  }
  assert.equal(h.cfg().brain ?? null, null, 'never silently stored');
  assert.equal(h.service.status().version, first.version);
  // A model the catalog lists: stored with the catalog's own id and effort spelling, from a fresh catalog.
  const saved = await h.ops.putConfig({ config: { brain: { provider: 'codex', model: 'GPT-6', effort: 'HIGH' } }, expectedVersion: first.version });
  assert.deepEqual(saved.config.brain, { provider: 'codex', model: 'gpt-6', effort: 'high' });
  assert.equal(saved.version, first.version + 1);
  assert.ok(catalog.forced >= 1, 'checked against what is enabled right now');
  assert.deepEqual(h.cfg().brain, { provider: 'codex', model: 'gpt-6', effort: 'high' });
  await assert.rejects(() => h.ops.putConfig({ config: { brain: null }, expectedVersion: first.version }), (e) => e.code === 'VERSION_CONFLICT' && e.status === 409);
  const status = h.service.status();
  assert.deepEqual(status.config.brain, { provider: 'codex', model: 'gpt-6', effort: 'high' });
  assert.deepEqual(status.brainChoice, {
    choice: { provider: 'codex', model: 'gpt-6', effort: 'high' }, source: 'choice', fallback: null, checked: true,
    effective: { provider: 'codex', providerLabel: 'Codex', model: 'gpt-6', modelLabel: 'GPT-6', effort: 'high' },
    // Ask / Autonomous hold on a Claude brain only: the note next to the choice.
    readOnly: { provider: 'codex', label: 'Codex' },
  });
  assert.deepEqual(status.brainLimit, { provider: 'codex', label: 'Codex', text: 'This conversation runs read-only because its brain is Codex; switch the WhatsApp brain to Claude for Ask/Autonomous.' }, 'the Safety warning follows the choice before a conversation exists');
  assert.ok(h.ops.listActivity({}).entries.some((e) => e.kind === 'settings' && /WhatsApp now runs on Codex \/ gpt-6 \(high\), from the next message/.test(e.detail)));
  // The broadcast carries the choice (ids only), so every open tab re-reads the status.
  await h.settle();
  assert.deepEqual(h.broadcasts.at(-1).brain, { provider: 'codex', model: 'gpt-6', effort: 'high' });
  assertNoSecrets(h.broadcasts);
  // The stored model is disabled later: the default is used, and the status says why.
  catalog.value = catalogValue({ 'claude-code': ['haiku'], codex: ['gpt-6'] });
  const later = h.service.status();
  assert.deepEqual(later.brainChoice.choice, { provider: 'codex', model: 'gpt-6', effort: 'high' }, 'the choice itself stays stored');
  assert.equal(later.brainChoice.source, 'assistant');
  assert.deepEqual(later.brainChoice.fallback, { reason: 'disabled', provider: 'codex', model: 'gpt-6', providerLabel: 'Codex' });
  assert.equal(later.brainChoice.effective.model, 'opus');
  assert.equal(later.brainChoice.readOnly, null);
  // Back to the default.
  const back = await h.ops.putConfig({ config: { brain: null }, expectedVersion: saved.version });
  assert.equal(back.config.brain, null);
  assert.equal(h.service.status().brainChoice.source, 'assistant');
  assert.equal(h.service.status().brainChoice.fallback, null);
});

test('the WhatsApp model: without a catalog nothing unchecked is stored (503); the default needs none; the bridge gets the catalog', async (t) => {
  const none = harness(t, { stored: LINKED });
  await none.service.start();
  await assert.rejects(() => none.ops.putConfig({ config: { brain: { provider: 'codex', model: 'gpt-6' } } }), (e) => e.status === 503 && e.code === 'CATALOG_UNAVAILABLE' && e.field === 'brain');
  assert.equal(none.cfg().brain ?? null, null);
  assert.equal((await none.ops.putConfig({ config: { brain: null } })).config.brain, null);
  assert.deepEqual(none.service.status().brainChoice, { choice: null, source: 'assistant', effective: null, fallback: null, readOnly: null, checked: false });
  // A stored value from somewhere else that is not a brain reads as the default.
  const odd = harness(t, { stored: { ...LINKED, brain: { provider: 'gemini', model: 'x' } } });
  await odd.service.start();
  assert.equal(odd.service.status().config.brain, null);
  // The bridge resolves the same choice with the same catalog.
  const catalog = fakeCatalog();
  const h = harness(t, { catalog, panelBrain: { provider: 'claude-code', model: 'opus' }, stored: LINKED });
  await h.service.start();
  h.manager.set({ state: 'open', registered: true, owner: { bound: true, masked: '••••1111' } });
  const bridge = h.bridgeFactory.made[0];
  assert.equal(bridge.deps.getCatalog(), catalog);
  assert.deepEqual(bridge.deps.getDefaultBrain(), { provider: 'claude-code', model: 'opus' });
  const before = bridge.refreshed;
  await h.ops.putConfig({ config: { brain: { provider: 'codex', model: 'gpt-6' } } });
  assert.ok(bridge.refreshed > before, 'the bridge hears a change at once');
});

test('computer use from WhatsApp: a switch Settings saves on this computer; in the status and the sync payload; an older stored config reads as off', async (t) => {
  // Stored before the field existed.
  const h = harness(t, { stored: { enabled: true, level: 'ask', mode: 'self', owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await h.service.start();
  h.manager.set({ state: 'open', registered: true, owner: { bound: true, masked: '••••1111' } });
  assert.equal(h.service.status().config.computerUse, false);
  assert.equal(h.service.status().computerUse, false);
  assert.equal(h.ops.getConfig().config.computerUse, false);
  assert.equal(h.service.toSyncPayload().computerUse, false);
  // Validated here: a boolean, nothing else, and nothing is stored on a refusal.
  for (const bad of ['true', 'on', 1, null, {}]) {
    await assert.rejects(() => h.ops.putConfig({ config: { computerUse: bad } }), (e) => e.code === 'CONFIG_INVALID' && e.field === 'computerUse' && e.status === 400, JSON.stringify(bad));
  }
  assert.equal(h.cfg().computerUse, undefined);
  const bridge = h.bridgeFactory.made[0];
  const refreshed = bridge.refreshed;
  const version = h.service.status().version;
  const on = await h.ops.putConfig({ config: { computerUse: true }, expectedVersion: version });
  assert.deepEqual([on.config.computerUse, on.version, on.pending], [true, version + 1, null], 'a plain switch: no phone code');
  assert.equal(h.cfg().computerUse, true, 'persisted');
  assert.equal(bridge.refreshed, refreshed + 1, 'the bridge re-applies the policy at once');
  assert.deepEqual([h.service.status().computerUse, h.service.status().config.computerUse, h.ops.getConfig().config.computerUse], [true, true, true]);
  await h.settle();
  assert.equal(h.broadcasts.at(-1).computerUse, true, 'open Settings tabs hear it');
  assert.ok(h.service._internals.activity.some((row) => row.kind === 'security' && /Computer use from WhatsApp turned on from this computer/.test(row.detail)), JSON.stringify(h.service._internals.activity.slice(-3)));
  await assert.rejects(() => h.ops.putConfig({ config: { computerUse: false }, expectedVersion: version }), (e) => e.code === 'VERSION_CONFLICT', 'a stale tab reloads first');
  await h.ops.putConfig({ config: { computerUse: false } });
  assert.equal(h.cfg().computerUse, false);
  assert.ok(h.service._internals.activity.some((row) => /Computer use from WhatsApp turned off from this computer/.test(row.detail)));
  // Nothing that arrives from the phone reaches the setting: messages go to the bridge, and its config handle cannot turn it on.
  h.manager.emit('inbound', { message: { id: 'IN1', ts: Date.now(), chat: 'self', text: '/computer on', images: [], owner: true, forwarded: false, quoted: null } });
  h.manager.emit('inbound', { message: { id: 'IN2', ts: Date.now(), chat: 'self', text: 'ALLOW computer', images: [], owner: true, forwarded: false, quoted: null } });
  await tick();
  assert.equal(h.cfg().computerUse, false);
  bridge.deps.config.write({ computerUse: true });
  assert.equal(h.cfg().computerUse, false, 'the bridge (the phone\'s only path in) cannot write it on');
  assert.equal(h.service.status().computerUse, false);
});

// ── The phone's authority: one holder, the bridge the service built last ──
import { readFileSync as readSource } from 'node:fs';
import { fileURLToPath as sourcePath } from 'node:url';
import { createPhoneAuthority } from '../lib/remote-policy.js';

test('the phone\'s authority: each bridge the service builds gets a fresh capability, the one before stops working, a bridge that is gone leaves none', async (t) => {
  const authority = createPhoneAuthority();
  const issuer = { issue: authority.issue, revoke: authority.revoke }; // what server.js hands the service: no verifier
  const linked = () => ({ enabled: true, mode: 'self', owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } });
  const a = harness(t, { stored: linked(), authority: issuer });
  await a.service.start();
  assert.equal(a.bridgeFactory.made.length, 1);
  const first = a.bridgeFactory.made[0].deps.authority;
  assert.equal(typeof first, 'symbol');
  assert.equal(authority.verify(first), true, 'the bridge holds the working capability');
  // The service keeps no copy and shows none.
  assert.equal(JSON.stringify(a.service.status()).includes('authority'), false);
  assert.equal(Object.values(a.service).some((v) => typeof v === 'symbol'), false);
  assert.equal(JSON.stringify(a.cfg()).includes('authority'), false);

  // A bridge built again (here: by a second service on the same authority) gets a fresh one; the old one is dead at once.
  const b = harness(t, { stored: linked(), authority: issuer });
  await b.service.start();
  const second = b.bridgeFactory.made[0].deps.authority;
  assert.equal(typeof second, 'symbol');
  assert.notEqual(second, first);
  assert.deepEqual([authority.verify(first), authority.verify(second)], [false, true], 'exactly one holder: the newest bridge');

  // Dropping the bridge (unlink) revokes it.
  b.manager.set({ state: 'open', registered: true, owner: { bound: true, masked: '••••1111' } });
  await b.ops.unlink();
  assert.equal(b.bridgeFactory.made[0].down, true);
  assert.deepEqual([authority.verify(first), authority.verify(second)], [false, false], 'no bridge, no capability');

  // …and so does the process going down.
  const c = harness(t, { stored: linked(), authority: issuer });
  await c.service.start();
  const third = c.bridgeFactory.made[0].deps.authority;
  assert.equal(authority.verify(third), true);
  c.service.killNow();
  assert.equal(authority.verify(third), false);

  // A service wired without an issuer builds a bridge that can never grant.
  const d = harness(t, { stored: linked() });
  await d.service.start();
  assert.equal(d.bridgeFactory.made[0].deps.authority, null);
});

test('wiring: server.js makes the phone\'s authority once and splits it (verifier → runtime, issuer → WhatsApp service); the bridge keeps it in its closure', () => {
  const read = (rel) => readSource(sourcePath(new URL(rel, import.meta.url)), 'utf8');
  const count = (text, needle) => text.split(needle).length - 1;
  const server = read('../server.js');
  assert.equal(count(server, 'createPhoneAuthority()'), 1, 'made once');
  assert.match(server, /^const _phoneAuthority = createPhoneAuthority\(\);$/m, 'a module-level constant');
  assert.equal(count(server, '_phoneAuthority.'), 3, 'three uses and no more: issue, revoke, verify');
  assert.doesNotMatch(server, /export[^\n]*_phoneAuthority/);
  assert.doesNotMatch(server, /[=(,:]\s*_phoneAuthority\s*[,;)}\n]/, 'the whole object is never handed to anyone');
  const service = server.slice(server.indexOf('createWhatsAppService({'));
  assert.match(service.slice(0, service.indexOf('});')), /phoneAuthority: \{ issue: _phoneAuthority\.issue, revoke: _phoneAuthority\.revoke \},/, 'the service gets the issuer, never the verifier');
  const runtime = server.slice(server.indexOf('_assistantRuntime = createAssistantRuntime({'));
  assert.match(runtime.slice(0, 400), /phoneAuthority: _phoneAuthority\.verify,/, 'the runtime gets the verifier, never the issuer');

  // The service issues for the bridge it builds, and nowhere else; it revokes wherever a bridge goes.
  const svc = read('../lib/whatsapp/service.js');
  assert.equal(count(svc, 'phoneAuthority.issue()'), 1);
  assert.match(svc, /state\.bridge = bridgeFactory\(\{[^}]*authority: typeof phoneAuthority\?\.issue === 'function' \? phoneAuthority\.issue\(\) : null,/);
  assert.equal(count(svc, 'revokeAuthority();'), 3, 'build failed, bridge dropped, process going down');
  assert.equal(count(svc, 'state.bridge = null;'), 3, 'every place a bridge goes revokes');

  // The bridge: the parameter, and the two calls where a grant can happen. Not in its state or internals.
  const bridge = read('../lib/whatsapp/bridge.js');
  assert.equal(count(bridge, 'phoneAuthority'), 3);
  assert.match(bridge, /authority: phoneAuthority = null,/);
  assert.match(bridge, /rt\.answerControl\(card\.sessionId, card\.requestId, result\.response, \{ origin: 'whatsapp', authority: phoneAuthority \}\)/);
  assert.match(bridge, /rt\.submit\(sessionId, \{[^}]*origin: 'whatsapp', authority: phoneAuthority,/);

  // The runtime decides by the capability; the string "whatsapp" is audit text only.
  const rt = read('../lib/assistant-runtime.js');
  assert.doesNotMatch(rt, /origin [!=]== 'whatsapp' &&|if \(origin !== 'whatsapp'\)|trusted = origin/);
  assert.equal(count(rt, 'fromPhone(authority)') - count(rt, 'function fromPhone(authority)'), 4, 'the route\'s Mac part, the turn\'s yes (refusal and settle), the unasked turn');
});

test('unlink ends live computer control of the WhatsApp sessions first; only then is the bridge dropped', async (t) => {
  const h = harness(t, { stored: { enabled: true, mode: 'self', sessionId: 'assistant-wa-1', owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await h.service.start();
  h.manager.set({ state: 'open', registered: true, owner: { bound: true, masked: '••••1111' } });
  await h.ops.unlink();
  assert.deepEqual(h.bridgeFactory.made[0].computerOff, [['bridge dropped', 'before shutdown']], 'told once to end computer use, before its shutdown');
  assert.equal(h.bridgeFactory.made[0].down, true);
  // The process going down does the same, synchronously.
  const k = harness(t, { stored: { enabled: true, mode: 'self', owner: { masked: '••••1111', boundAt: 1, via: 'self_confirm' } } });
  await k.service.start();
  k.service.killNow();
  assert.deepEqual(k.bridgeFactory.made[0].computerOff, [['process exit', 'before shutdown']]);
});

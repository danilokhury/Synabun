// WhatsApp Link host core against the fake Baileys socket, with a manual clock:
// linking (QR, pairing code), the self-mode confirmation, the dedicated claim,
// the inbound pipeline, sendToOwner (owner only, pacing, caps), reactions,
// presence, read receipts, and every row of the disconnect table.
process.env.SYNABUN_TYPESAFE = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostCore, REACTION_RESERVE, SEND_CAPS, WELCOME_TEXT } from '../lib/whatsapp/host-core.js';
import { fake } from '../lib/whatsapp/fake-baileys.js';
import { openAuthStore } from '../lib/whatsapp/auth-store.js';
import { classifyDisconnect, createReconnectPolicy } from '../lib/whatsapp/baileys-adapter.js';
import { DisconnectReason } from '../lib/whatsapp/fake-baileys.js';
import { resolveWhatsAppPaths } from '../lib/whatsapp/paths.js';
import { CONN, ERR, EV, LIMITS, OP, validateEvent } from '../lib/whatsapp/protocol.js';
import { sameAccount } from '../lib/whatsapp/identity.js';

const ACCOUNT = { pn: '15550001111@s.whatsapp.net', lid: '99887766554433@lid' };
const OWNER = { pn: '15550003333@s.whatsapp.net', lid: '55443322110099@lid' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(60, 3)]);

const macrotask = () => new Promise((r) => setImmediate(r));
async function flush(n = 6) {
  for (let i = 0; i < n; i++) await macrotask();
}

function createClock(start = 1_800_000_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    pending: () => timers.size,
    timers: {
      setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + Math.max(0, ms), fn, every: 0 }); return id; },
      clearTimeout: (id) => { timers.delete(id); },
      setInterval: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn, every: ms }); return id; },
      clearInterval: (id) => { timers.delete(id); },
    },
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        let next = null;
        for (const [id, tm] of timers) if (tm.at <= target && (!next || tm.at < next[1].at)) next = [id, tm];
        if (!next) break;
        const [id, tm] = next;
        t = tm.at;
        if (tm.every) tm.at += tm.every;
        else timers.delete(id);
        tm.fn();
        await flush(3);
      }
      t = target;
      await flush(3);
    },
  };
}

async function waitFor(pred, label = 'condition', timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 3));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** In-process host core over the fake socket. */
async function harness(t, { reconnect, rng = () => 0.5, openStore } = {}) {
  fake.reset();
  const dataHome = mkdtempSync(join(tmpdir(), 'synabun-wa-core-'));
  const paths = resolveWhatsAppPaths({ dataHome, env: {}, platform: process.platform });
  const clock = createClock();
  const events = [];
  let seq = 0;
  const core = createHostCore({
    send: (ev) => events.push(structuredClone(ev)),
    paths,
    env: { SYNABUN_WHATSAPP_FAKE: '1' },
    now: clock.now,
    timers: clock.timers,
    rng,
    ...(reconnect ? { reconnect } : {}),
    ...(openStore ? { openStore } : {}),
  });
  const info = await core.init();
  let closed = false;
  const h = {
    core,
    clock,
    events,
    paths,
    info,
    req(op, fields = {}) {
      const reqId = ++seq;
      return core.handleMessage({ op, reqId, ...fields }).then(() => {
        const r = events.find((e) => e.t === EV.REPLY && e.reqId === reqId);
        return r.ok ? { ok: true, ...(r.data && typeof r.data === 'object' ? r.data : { data: r.data }) } : { ok: false, ...r.error };
      });
    },
    /** Settle an op that waits on the clock (pacing). */
    async drive(promise, { step = 250, max = 400 } = {}) {
      let done = false;
      let value;
      promise.then((v) => { done = true; value = v; });
      for (let i = 0; i < max && !done; i++) await clock.advance(step);
      assert.ok(done, 'operation settled');
      return value;
    },
    state: () => [...events].reverse().find((e) => e.t === EV.STATE)?.conn.state ?? info.conn.state,
    conn: () => [...events].reverse().find((e) => e.t === EV.STATE)?.conn ?? info.conn,
    of: (type) => events.filter((e) => e.t === type),
    inbound: () => events.filter((e) => e.t === EV.INBOUND).map((e) => e.message),
    async ignored() {
      await clock.advance(2500);
      return [...events].reverse().find((e) => e.t === EV.IGNORED)?.counts ?? {};
    },
    async close() {
      if (closed) return;
      closed = true;
      await core.shutdown();
    },
  };
  t.after(async () => {
    await h.close();
    fake.reset();
    rmSync(dataHome, { recursive: true, force: true });
  });
  return h;
}

async function linkSelf(h, { confirm = true } = {}) {
  const r = await h.req(OP.CONNECT, { purpose: 'link', mode: 'self', link: { method: 'qr' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  await waitFor(() => h.of(EV.QR).length > 0, 'qr');
  fake.scan();
  await waitFor(() => h.state() === CONN.AWAITING_CONFIRM, 'awaiting_confirm');
  if (confirm) {
    const c = await h.req(OP.CONFIRM_OWNER, { accept: true });
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.equal(h.state(), CONN.OPEN);
  }
}

async function linkDedicated(h) {
  const r = await h.req(OP.CONNECT, { purpose: 'link', mode: 'dedicated', link: { method: 'qr' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  await waitFor(() => h.of(EV.QR).length > 0, 'qr');
  fake.scan();
  await waitFor(() => h.state() === CONN.OPEN, 'open');
}

async function claimOwner(h, { addressing = 'lid' } = {}) {
  const claim = await h.req(OP.CLAIM_START, {});
  assert.equal(claim.ok, true, JSON.stringify(claim));
  fake.inbound({ from: 'owner', text: claim.code, addressing });
  await waitFor(() => h.of(EV.OWNER_BOUND).length > 0, 'owner_bound');
  await h.drive(new Promise((r) => { const check = () => (fake.state.sent.length ? r() : setTimeout(check, 1)); check(); }));
  return claim;
}

async function inboundFrom(h, opts) {
  const before = h.inbound().length;
  const res = fake.inbound(opts);
  await waitFor(() => h.inbound().length > before, 'inbound');
  return { res, message: h.inbound().at(-1) };
}

const JID_OR_NUMBER = /\d{7,}|@(?:s\.whatsapp\.net|c\.us|lid|g\.us|broadcast|newsletter|hosted)/;

/** Every string (keys and values) of every event, except the QR payload and the claim_start reply. */
function leakedStrings(events, claimReqIds = new Set()) {
  const leaks = [];
  const walk = (v, where) => {
    if (typeof v === 'string') { if (JID_OR_NUMBER.test(v)) leaks.push(`${where}: ${v}`); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${where}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (JID_OR_NUMBER.test(k)) leaks.push(`${where} key ${k}`);
        walk(x, `${where}.${k}`);
      }
    }
  };
  for (const ev of events) {
    if (ev.t === EV.REPLY && claimReqIds.has(ev.reqId)) continue;
    if (ev.t === EV.QR) { assert.ok(!/@(?:s\.whatsapp\.net|lid)/.test(ev.qr)); continue; }
    walk(ev, ev.t);
  }
  return leaks;
}

// ── Pure pieces ──

test('classifyDisconnect maps every DisconnectReason by name', () => {
  const run = (code, linking = false) => classifyDisconnect({ output: { statusCode: code } }, { linking, DisconnectReason });
  const pick = (r) => [r.action, r.state, r.wipe];
  assert.deepEqual(pick(run(515)), ['reconnect_now', CONN.CONNECTING, false]);
  assert.deepEqual(pick(run(401)), ['stop', CONN.LOGGED_OUT, true]);
  assert.deepEqual(pick(run(440)), ['stop', CONN.REPLACED, false]);
  assert.deepEqual(pick(run(403)), ['stop', CONN.FORBIDDEN, false]);
  assert.deepEqual(pick(run(500)), ['stop', CONN.ERROR, false]);
  assert.deepEqual(pick(run(411)), ['stop', CONN.ERROR, false]);
  for (const code of [428, 408, 503, 999]) assert.deepEqual(pick(run(code)), ['backoff', CONN.RECONNECTING, false], String(code));
  assert.deepEqual(pick(classifyDisconnect(new Error('no status'), { DisconnectReason })), ['backoff', CONN.RECONNECTING, false]);
  assert.deepEqual(pick(run(405)), ['refresh_version', CONN.RECONNECTING, false]);
  assert.equal(run(408).reason, 'timedOut');
  assert.equal(run(428).reason, 'connectionClosed');
  // Linking: a timeout or a closed stream means the QR / code ran out — no QR loop.
  for (const code of [408, 428, 503]) assert.deepEqual(pick(run(code, true)), ['stop', CONN.LINK_EXPIRED, true], `linking ${code}`);
  assert.deepEqual(pick(run(515, true)), ['reconnect_now', CONN.CONNECTING, false], 'the post-scan restart');
});

test('reconnect policy: 2/5/15/30/60/120/300 s ±20%, reset when stable, give up after 10 in 10 minutes', () => {
  let t = 0;
  const flat = createReconnectPolicy({ now: () => t, rng: () => 0.5 });
  const delays = [];
  for (let i = 0; i < 8; i++) { delays.push(flat.next().delayMs); t += 1; }
  assert.deepEqual(delays, [2000, 5000, 15000, 30000, 60000, 120000, 300000, 300000]);
  flat.noteStable();
  assert.equal(flat.next().delayMs, 2000);
  const low = createReconnectPolicy({ now: () => t, rng: () => 0 });
  const high = createReconnectPolicy({ now: () => t, rng: () => 0.999999 });
  assert.equal(low.next().delayMs, 1600);
  assert.ok(Math.abs(high.next().delayMs - 2400) <= 1);
  const burst = createReconnectPolicy({ now: () => t, rng: () => 0.5 });
  for (let i = 0; i < 10; i++) assert.ok('delayMs' in burst.next());
  assert.deepEqual(burst.next(), { giveUp: true });
  t += 10 * 60_000;
  assert.ok('delayMs' in burst.next(), 'the window slides');
});

// ── Linking ──

test('init without a link: unlinked, runtime fake, store opened', async (t) => {
  const h = await harness(t);
  assert.equal(h.info.conn.state, CONN.UNLINKED);
  assert.deepEqual(h.info.runtime, { loaded: true, version: 'fake', fake: true, error: null });
  const st = await h.req(OP.STATUS);
  assert.equal(st.conn.registered, false);
  const run = await h.req(OP.CONNECT, { purpose: 'run' });
  assert.deepEqual([run.ok, run.code], [false, ERR.NOT_LINKED]);
});

test('an auth store refused for its permissions (AUTH_PERMS) is fatal: error state, no socket, connect / link / logout fail closed', async (t) => {
  const refusal = 'SynaBun could not make the WhatsApp session files private (the folder /tmp/x/whatsapp/auth has mode 755 and chmod failed: EPERM); '
    + 'fix the folder permissions (yours only: 700 for the folder, 600 for its files), then reconnect';
  let opens = 0;
  const h = await harness(t, {
    openStore: () => {
      opens += 1;
      throw Object.assign(new Error(refusal), { code: 'AUTH_PERMS' });
    },
  });
  const fatal = h.of(EV.FATAL);
  assert.deepEqual(fatal.map((e) => e.code), ['AUTH_PERMS'], 'one fatal, with its own code');
  assert.equal(validateEvent(fatal[0]).ok, true);
  assert.match(fatal[0].message, /could not make the WhatsApp session files private .*then reconnect/);
  assert.equal(h.info.conn.state, CONN.ERROR);
  assert.match(h.info.conn.lastError, /could not be made private/);
  assert.equal((await h.req(OP.STATUS)).conn.state, CONN.ERROR);

  for (const [op, fields] of [
    [OP.CONNECT, { purpose: 'run' }],
    [OP.CONNECT, { purpose: 'link', mode: 'self', link: { method: 'qr' } }],
    [OP.CONNECT, { purpose: 'link', mode: 'dedicated', link: { method: 'code', phone: '15550001111' } }],
    [OP.LOGOUT, {}],
    [OP.OWNER_RESET, {}],
  ]) {
    const r = await h.req(op, fields);
    assert.deepEqual([r.ok, r.code], [false, 'AUTH_PERMS'], `${op} ${JSON.stringify(fields)}`);
    assert.match(r.message, /could not be made private/);
  }
  const off = await h.req(OP.DISCONNECT);
  assert.equal(off.state, CONN.ERROR, 'a disconnect does not pretend the store is fine');
  const again = await h.req(OP.CONNECT, { purpose: 'link', mode: 'self' });
  assert.deepEqual([again.ok, again.code], [false, 'AUTH_PERMS'], 'still closed after a disconnect');
  assert.equal(fake.sockets.length, 0, 'no WhatsApp socket was ever created');
  assert.equal(opens, 1);
  assert.equal(ERR.AUTH_PERMS, 'AUTH_PERMS', 'a host error code (anything else is relayed as INTERNAL)');
});

test('a real auth folder whose mode cannot be repaired reaches the host as AUTH_PERMS; nothing is created', { skip: process.platform === 'win32' && 'POSIX permissions only' }, async (t) => {
  let authDir = null;
  const h = await harness(t, {
    openStore: (opts) => {
      authDir = opts.authDir;
      mkdirSync(authDir, { recursive: true });
      chmodSync(authDir, 0o755);
      const chmodFails = (path) => { throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${path}'`), { code: 'EPERM' }); };
      return openAuthStore({ ...opts, fsImpl: { chmodSync: chmodFails } });
    },
  });
  assert.equal(h.info.conn.state, CONN.ERROR);
  const fatal = h.of(EV.FATAL).find((e) => e.code === 'AUTH_PERMS');
  assert.ok(fatal, JSON.stringify(h.events.filter((e) => e.t !== EV.LOG)));
  assert.match(fatal.message, /has mode 755 and chmod failed: EPERM/);
  assert.ok(h.of(EV.LOG).some((e) => e.level === 'error' && /could not make the WhatsApp session files private/.test(e.message)), 'the host log says why');
  assert.deepEqual(readdirSync(authDir), [], 'no credential database was created');
  const run = await h.req(OP.CONNECT, { purpose: 'run' });
  assert.deepEqual([run.ok, run.code], [false, 'AUTH_PERMS']);
});

test('self mode: QR link → awaiting_confirm drops everything and sends nothing → confirm → open', async (t) => {
  const h = await harness(t);
  await linkSelf(h, { confirm: false });
  const qr = h.of(EV.QR)[0];
  assert.match(qr.qr, /^https:\/\/wa\.me\/settings\/linked_devices#/);
  assert.equal(qr.expiresAt, h.clock.now() + 60_000, 'first QR lives 60 s');
  const linked = h.of(EV.LINKED)[0];
  assert.deepEqual(linked, { t: EV.LINKED, mode: 'self', me: { masked: '••••1111', name: 'Fake Account' } });
  assert.ok(h.conn().awaitingConfirmUntil > h.clock.now());

  fake.inbound({ from: 'self', text: 'run rm -rf ~' });
  fake.inbound({ from: 'self', text: 'another' });
  await flush();
  assert.equal(h.inbound().length, 0, 'nothing reaches the Assistant before the desktop confirms');
  assert.equal((await h.ignored()).awaiting_confirm, 2);
  const send = await h.req(OP.SEND, { text: 'hello?' });
  assert.deepEqual([send.ok, send.code], [false, ERR.NOT_CONNECTED]);
  assert.equal(fake.state.sent.length, 0);

  const ok = await h.req(OP.CONFIRM_OWNER, { accept: true });
  assert.equal(ok.ok, true);
  assert.equal(h.state(), CONN.OPEN);
  assert.deepEqual(h.of(EV.OWNER_BOUND).at(-1), { t: EV.OWNER_BOUND, masked: '••••1111', via: 'self_confirm' });
  const { message } = await inboundFrom(h, { from: 'self', text: 'now it works' });
  assert.equal(message.text, 'now it works');
  const again = await h.req(OP.CONFIRM_OWNER, { accept: true });
  assert.deepEqual([again.ok, again.code], [false, ERR.NOT_AWAITING]);
  const reset = await h.req(OP.OWNER_RESET);
  assert.deepEqual([reset.ok, reset.code], [false, ERR.BAD_REQUEST], 'self mode: the owner is the account itself');
  assert.equal(h.state(), CONN.OPEN);
});

test('self mode: declining, or 10 minutes without an answer, logs the device out and wipes it', async (t) => {
  const h = await harness(t);
  await linkSelf(h, { confirm: false });
  const no = await h.req(OP.CONFIRM_OWNER, { accept: false });
  assert.equal(no.ok, true);
  assert.equal(h.state(), CONN.UNLINKED);
  assert.equal(fake.state.logouts, 1);
  assert.equal(h.conn().registered, false);

  const h2 = await harness(t);
  await linkSelf(h2, { confirm: false });
  await h2.clock.advance(10 * 60_000 + 10);
  await waitFor(() => h2.state() === CONN.UNLINKED, 'unlinked after the confirm window');
  assert.equal(fake.state.logouts, 1);
  assert.ok(h2.of(EV.FATAL).some((e) => e.code === 'CONFIRM_TIMEOUT'));
  assert.equal(h2.conn().registered, false);
});

test('pairing code: requested once, after the first QR, digits only; the QR itself is never emitted', async (t) => {
  const h = await harness(t);
  const bad = await h.req(OP.CONNECT, { purpose: 'link', mode: 'self', link: { method: 'code', phone: 'call me' } });
  assert.deepEqual([bad.ok, bad.code], [false, ERR.BAD_PHONE]);
  const r = await h.req(OP.CONNECT, { purpose: 'link', mode: 'self', link: { method: 'code', phone: '+1 (555) 000-1111' } });
  assert.equal(r.ok, true);
  await waitFor(() => h.of(EV.PAIRING_CODE).length > 0, 'pairing_code');
  fake.nextQr();
  await flush();
  assert.deepEqual(fake.state.pairingRequests, ['15550001111']);
  assert.equal(h.of(EV.QR).length, 0);
  assert.equal(h.of(EV.PAIRING_CODE)[0].code, 'FAKE2345');
  assert.equal(h.state(), CONN.PAIRING);
  fake.scan();
  await waitFor(() => h.state() === CONN.AWAITING_CONFIRM, 'awaiting_confirm');
});

test('linking that times out ends in link_expired (no QR loop) and forgets the half-made creds', async (t) => {
  const h = await harness(t);
  await h.req(OP.CONNECT, { purpose: 'link', mode: 'self', link: { method: 'qr' } });
  await waitFor(() => h.of(EV.QR).length > 0, 'qr');
  const sockets = fake.sockets.length;
  fake.disconnect('timedOut');
  await waitFor(() => h.state() === CONN.LINK_EXPIRED, 'link_expired');
  await h.clock.advance(10 * 60_000);
  assert.equal(fake.sockets.length, sockets, 'no new socket, no new QR');
  assert.equal(h.conn().registered, false);
  const already = await h.req(OP.CONNECT, { purpose: 'link', mode: 'self' });
  assert.equal(already.ok, true, 'a new link can start right away');
});

// ── Dedicated claim ──

test('dedicated: a stranger gets no reply for a wrong code; the right code binds {pn, lid} and gets the welcome', async (t) => {
  const h = await harness(t);
  await linkDedicated(h);
  assert.equal(h.conn().owner.bound, false);
  const early = await h.req(OP.SEND, { text: 'anyone?' });
  assert.deepEqual([early.ok, early.code], [false, ERR.NO_OWNER]);
  const claim = await h.req(OP.CLAIM_START, {});
  assert.match(claim.code, /^SB-\d{6}$/);
  assert.equal(claim.link, `https://wa.me/15550001111?text=${encodeURIComponent(claim.code)}`);
  assert.equal(claim.expiresAt, h.clock.now() + 10 * 60_000);
  const wrong = claim.code === 'SB-111111' ? 'SB-222222' : 'SB-111111';
  fake.inbound({ from: 'stranger', text: wrong });
  fake.inbound({ from: 'stranger', text: 'hello, let me in' });
  fake.inbound({ from: 'stranger', text: `  ${wrong.toLowerCase()} ` });
  await flush();
  assert.equal(fake.state.sent.length, 0, 'wrong codes are never answered');
  assert.equal(h.inbound().length, 0);
  assert.equal(h.conn().claim.attemptsLeft, 3);
  assert.ok((await h.ignored()).claim_mismatch >= 2);

  fake.inbound({ from: 'owner', text: ` ${claim.code.toLowerCase()} `, addressing: 'lid' });
  await waitFor(() => h.of(EV.OWNER_BOUND).length > 0, 'owner_bound');
  assert.deepEqual(h.of(EV.OWNER_BOUND)[0], { t: EV.OWNER_BOUND, masked: '••••3333', via: 'claim' });
  await h.drive(new Promise((r) => { const c = () => (fake.state.sent.length ? r() : setTimeout(c, 1)); c(); }));
  assert.equal(fake.state.sent.length, 1);
  assert.equal(fake.state.sent[0].text, WELCOME_TEXT);
  assert.ok(sameAccount(fake.state.sent[0].jid, OWNER.lid), 'the welcome goes to the claimant, where they wrote');
  assert.equal(h.inbound().length, 0, 'the code itself never reaches the Assistant');

  fake.inbound({ from: 'stranger', text: 'SB-000000' });
  fake.inbound({ from: 'stranger', text: 'hi' });
  const { message } = await inboundFrom(h, { from: 'owner', text: 'what is on my calendar?' });
  assert.equal(message.chat, 'dm');
  assert.equal(message.text, 'what is on my calendar?');
  assert.equal(fake.state.sent.length, 1, 'strangers still get nothing');
  await h.close();
  const store = openAuthStore({ authDir: h.paths.authDir });
  try {
    const row = store.owner.get();
    assert.equal(row.pn, OWNER.pn);
    assert.equal(row.lid, OWNER.lid);
    assert.equal(row.via, 'claim');
  } finally {
    store.close();
  }
});

test('dedicated: five wrong codes end the claim; the right code afterwards binds nobody', async (t) => {
  const h = await harness(t);
  await linkDedicated(h);
  const claim = await h.req(OP.CLAIM_START, {});
  const wrong = claim.code === 'SB-111111' ? 'SB-222222' : 'SB-111111';
  for (let i = 0; i < 5; i++) fake.inbound({ from: 'stranger', text: wrong });
  await flush(10);
  await waitFor(() => h.conn().claim === null, 'claim exhausted');
  fake.inbound({ from: 'owner', text: claim.code });
  await flush(10);
  assert.equal(h.of(EV.OWNER_BOUND).length, 0);
  assert.equal(fake.state.sent.length, 0);
  const again = await h.req(OP.CLAIM_START, {});
  assert.equal(again.ok, true, 'a new claim can be started');
  const bound = await h.req(OP.CLAIM_START, {});
  assert.equal(bound.ok, true);
});

test('dedicated: the owner LID is learned through a matching PN and persisted', async (t) => {
  const h = await harness(t);
  await linkDedicated(h);
  // The mapping cannot resolve the owner's LID at claim time.
  fake.control('setPeople', { owner: { pn: '15550003333', lid: '' } });
  const claim = await h.req(OP.CLAIM_START, {});
  fake.inbound({ from: 'owner', text: claim.code, addressing: 'pn' });
  await waitFor(() => h.of(EV.OWNER_BOUND).length > 0, 'owner_bound');
  fake.control('setPeople', { owner: { pn: '15550003333', lid: '55443322110099' } });
  const { message } = await inboundFrom(h, { from: 'owner', text: 'via lid', addressing: 'lid' });
  assert.equal(message.text, 'via lid');
  await h.close();
  const store = openAuthStore({ authDir: h.paths.authDir });
  try {
    assert.deepEqual([store.owner.get().pn, store.owner.get().lid], [OWNER.pn, OWNER.lid]);
  } finally {
    store.close();
  }
});

// ── Inbound pipeline ──

test('offline delivery (append): the owner\'s held messages under 24 h arrive with backlog and their send time; other chats, devices and claims stay out', async (t) => {
  const h = await harness(t);
  await linkSelf(h);
  const sentAt = h.clock.now() - 2 * 3600_000;
  fake.inbound({ from: 'self_other', text: 'to a friend while SynaBun was off', type: 'append', at: sentAt });
  fake.inbound({ from: 'self', text: 'typed on the laptop while off', type: 'append', at: sentAt, device: 5 });
  const { message } = await inboundFrom(h, { from: 'self', text: 'sent while SynaBun was off', type: 'append', at: sentAt });
  assert.equal(message.text, 'sent while SynaBun was off');
  assert.equal(message.backlog, true);
  assert.equal(message.ts, Math.floor(sentAt / 1000) * 1000, 'when the phone sent it, not when it arrived');
  assert.equal(h.inbound().length, 1, 'the owner filter still applies');
  const live = await inboundFrom(h, { from: 'self', text: 'live' });
  assert.equal(live.message.backlog, undefined, 'live messages carry no flag');
  const counts = await h.ignored();
  assert.ok(counts.own_other_chat >= 1 && counts.companion_device >= 1, JSON.stringify(counts));
});

test('offline delivery never counts as a claim attempt (a claim is live)', async (t) => {
  const h = await harness(t);
  await linkDedicated(h);
  const started = await h.req(OP.CLAIM_START, {});
  assert.equal(started.ok, true, JSON.stringify(started));
  fake.inbound({ from: 'owner', text: started.code, type: 'append', at: h.clock.now() - 60_000 });
  await flush(10);
  const conn = h.conn();
  assert.equal(conn.owner?.bound ?? false, false, 'a held code does not bind the owner');
  assert.equal(conn.claim?.attemptsLeft, 5, 'nor burn an attempt');
  fake.inbound({ from: 'owner', text: started.code });
  await waitFor(() => h.conn().owner?.bound === true, 'bound by the live code');
});

test('inbound filters: notify or offline append only, no requestId, no stubs/reactions/protocol/edits/polls/calls/stickers, real stanza, no duplicates', async (t) => {
  const h = await harness(t);
  await linkSelf(h);
  fake.inbound({ from: 'self', text: 'another upsert type', type: 'history' });
  fake.inbound({ from: 'self', text: 'appended without an offline stanza', type: 'append', offline: false, at: h.clock.now() });
  fake.inbound({ from: 'self', text: 'held longer than a day', type: 'append', at: h.clock.now() - 25 * 3600_000 });
  fake.inbound({ from: 'self', text: 'spoofed', requestId: 'PDO1' });
  fake.inbound({ from: 'self', stub: true });
  fake.inbound({ from: 'self', content: { reactionMessage: { text: '👍', key: { id: 'X' } } } });
  fake.inbound({ from: 'self', content: { protocolMessage: { type: 0, key: { id: 'X' } } } });
  fake.inbound({ from: 'self', content: { editedMessage: { message: { protocolMessage: { type: 14 } } } } });
  fake.inbound({ from: 'self', content: { pollUpdateMessage: { vote: {} } } });
  fake.inbound({ from: 'self', content: { bcallMessage: { sessionId: 'x' } } });
  fake.inbound({ from: 'self', content: { callLogMesssage: { isVideo: false } } }); // Baileys' own spelling: no content type → 'empty'
  fake.inbound({ from: 'self', content: { stickerMessage: { url: 'x' } } });
  fake.inbound({ from: 'self', text: 'no stanza', noStanza: true });
  fake.inbound({ from: 'self', text: 'from the laptop', device: 5 });
  fake.inbound({ from: 'self_other', text: 'to a friend' });
  await flush(10);
  assert.equal(h.inbound().length, 0);
  const counts = await h.ignored();
  for (const reason of ['not_notify', 'append_not_offline', 'backlog_expired', 'placeholder_resend', 'stub', 'reaction', 'protocol', 'poll_update', 'call', 'empty', 'sticker', 'stanza_unknown', 'companion_device', 'own_other_chat']) {
    assert.ok(counts[reason] >= 1, `${reason} counted (${JSON.stringify(counts)})`);
  }
  const first = await inboundFrom(h, { from: 'self', text: 'once', id: 'DUPE1' });
  fake.inbound({ from: 'self', text: 'once', id: 'DUPE1' });
  await flush();
  assert.equal(h.inbound().filter((m) => m.id === 'DUPE1').length, 1);
  assert.equal((await h.ignored()).duplicate, 1);
  assert.equal(first.message.owner, true);
});

test('a stranger flood cannot evict the owner message it arrived with (both modes)', async (t) => {
  const s = await harness(t);
  await linkSelf(s);
  fake.inbound({ from: 'self', text: 'mine', id: 'OWNERSELF1' });
  for (let i = 0; i < 1500; i++) fake.inbound({ from: 'stranger', text: `spam ${i}` });
  await waitFor(() => s.inbound().some((m) => m.id === 'OWNERSELF1'), 'the owner message survives the flood');
  await s.close();

  const d = await harness(t);
  await linkDedicated(d);
  await claimOwner(d);
  fake.inbound({ from: 'owner', text: 'mine too', id: 'OWNERDED1' });
  for (let i = 0; i < 1500; i++) fake.inbound({ from: 'stranger', text: `spam ${i}` });
  await waitFor(() => d.inbound().some((m) => m.id === 'OWNERDED1'), 'the owner message survives the flood', 15000);
  assert.ok((await d.ignored()).not_owner >= 1500);
});

test('inbound extraction: images, unsupported types, forwarded, quoted, long text', async (t) => {
  const h = await harness(t);
  await linkSelf(h);
  const jpeg = (await inboundFrom(h, { from: 'self', text: 'look', image: { data: JPEG, mimetype: 'image/jpeg' } })).message;
  assert.deepEqual(jpeg.images, [{ base64: JPEG.toString('base64'), mediaType: 'image/jpeg', bytes: JPEG.length }]);
  assert.equal(jpeg.text, 'look');
  assert.equal(jpeg.unsupported, null);
  const png = (await inboundFrom(h, { from: 'self', image: { data: PNG, mimetype: 'image/png' } })).message;
  assert.equal(png.images[0].mediaType, 'image/png');
  const gif = (await inboundFrom(h, { from: 'self', image: { data: GIF, mimetype: 'image/gif' } })).message;
  assert.deepEqual([gif.images, gif.unsupported], [[], { type: 'image', reason: 'format' }]);
  const lying = (await inboundFrom(h, { from: 'self', image: { data: GIF, mimetype: 'image/jpeg' } })).message;
  assert.deepEqual(lying.unsupported, { type: 'image', reason: 'format' }, 'bytes are sniffed, not trusted');
  const big = (await inboundFrom(h, { from: 'self', image: { data: JPEG, mimetype: 'image/jpeg', fileLength: LIMITS.MAX_IMAGE_BYTES + 1 } })).message;
  assert.deepEqual(big.unsupported, { type: 'image', reason: 'too_large' });
  const failed = (await inboundFrom(h, { from: 'self', image: { data: JPEG, mimetype: 'image/jpeg', fail: true } })).message;
  assert.deepEqual(failed.unsupported, { type: 'image', reason: 'download_failed' });
  for (const [content, type] of [
    [{ audioMessage: { ptt: true } }, 'audio'],
    [{ videoMessage: { caption: 'clip' } }, 'video'],
    [{ documentMessage: { fileName: 'a.pdf' } }, 'document'],
    [{ locationMessage: { degreesLatitude: 1 } }, 'location'],
    [{ contactMessage: { displayName: 'x' } }, 'contact'],
    [{ pollCreationMessageV3: { name: 'q' } }, 'poll'],
    [{ eventMessage: { name: 'party' } }, 'other'],
  ]) {
    const m = (await inboundFrom(h, { from: 'self', content })).message;
    assert.deepEqual(m.unsupported, { type }, type);
  }
  const fwd = (await inboundFrom(h, { from: 'self', text: 'fwd', forwarded: true })).message;
  assert.equal(fwd.forwarded, true);
  const sent = await h.drive(h.req(OP.SEND, { text: 'a SynaBun reply' }));
  const quoted = (await inboundFrom(h, { from: 'self', text: 'about that', quoted: { id: sent.id, text: 'a SynaBun reply' } })).message;
  assert.deepEqual(quoted.quoted, { id: sent.id, text: 'a SynaBun reply', fromBot: true });
  const long = (await inboundFrom(h, { from: 'self', text: 'x'.repeat(LIMITS.MAX_INBOUND_TEXT + 500) })).message;
  assert.equal(long.text.length, LIMITS.MAX_INBOUND_TEXT);
});

test('self mode prefix trigger strips the prefix and ignores other notes', async (t) => {
  const h = await harness(t);
  await h.req(OP.CONFIGURE, { prefs: { selfTrigger: 'prefix', prefix: 'sb' } });
  await linkSelf(h);
  fake.inbound({ from: 'self', text: 'milk, eggs' });
  const { message } = await inboundFrom(h, { from: 'self', text: 'SB: summarize my day' });
  assert.equal(message.text, 'summarize my day');
  assert.equal((await h.ignored()).no_prefix, 1);
});

// ── Outbound ──

test('sendToOwner: only ever the owner JID (self mode), pacing ≥ 900 ms, TOO_LONG, empty text, react targets', async (t) => {
  const h = await harness(t);
  await linkSelf(h);
  const { message } = await inboundFrom(h, { from: 'self', text: 'hi', addressing: 'lid' });
  const times = [];
  const push = fake.state.sent.push;
  fake.state.sent.push = function stamp(...items) {
    times.push(h.clock.now());
    return push.apply(this, items);
  };
  const results = await h.drive(Promise.all([
    h.req(OP.SEND, { text: 'one', replyTo: message.id }),
    h.req(OP.SEND, { text: 'two' }),
    h.req(OP.SEND, { text: 'three' }),
  ]), { step: 50 });
  assert.deepEqual(results.map((r) => r.ok), [true, true, true]);
  assert.ok(times.length === 3 && times[1] - times[0] >= 900 && times[2] - times[1] >= 900, `paced: ${times.map((x) => x - times[0])}`);
  assert.equal(fake.state.sent[0].quotedId, message.id);
  assert.equal(fake.state.sent[0].linkPreview, null, 'no link previews (no URL fetching from the host)');
  assert.ok(sameAccount(fake.state.sent[0].jid, ACCOUNT.lid), 'replies go to the chat the owner used');

  const long = await h.req(OP.SEND, { text: 'x'.repeat(LIMITS.MAX_TEXT + 1) });
  assert.deepEqual([long.ok, long.code], [false, ERR.TOO_LONG]);
  const empty = await h.req(OP.SEND, { text: '   ' });
  assert.deepEqual([empty.ok, empty.code], [false, ERR.BAD_REQUEST]);

  const r1 = await h.drive(h.req(OP.REACT, { id: message.id, reaction: 'done' }));
  assert.equal(r1.ok, true);
  const react = fake.state.sent.at(-1);
  assert.deepEqual([react.kind, react.react.text, react.react.keyId], ['react', '✅', message.id]);
  const r2 = await h.drive(h.req(OP.REACT, { id: results[1].id, reaction: null }));
  assert.equal(r2.ok, true, 'can react to (or clear) its own reply');
  assert.equal(fake.state.sent.at(-1).react.text, '');
  const r3 = await h.req(OP.REACT, { id: 'SOMEONEELSE1', reaction: 'seen' });
  assert.deepEqual([r3.ok, r3.code], [false, ERR.BAD_TARGET]);

  const addr = await h.core.handleMessage({ op: OP.SEND, reqId: 999, text: 'x', jid: '15550002222@s.whatsapp.net' });
  assert.equal(addr, undefined);
  const refused = h.events.find((e) => e.t === EV.REPLY && e.reqId === 999);
  assert.equal(refused.error.code, ERR.ADDRESS_FORBIDDEN);
  for (const s of fake.state.sent) assert.ok(sameAccount(s.jid, ACCOUNT.pn) || sameAccount(s.jid, ACCOUNT.lid), `sent to ${s.jid}`);
});

test('caps: 10 per minute → THROTTLED with retryAfterMs and a throttled event', async (t) => {
  const h = await harness(t);
  await linkSelf(h);
  assert.deepEqual(SEND_CAPS.map((c) => c.max), [10, 120, 500]);
  const sends = [];
  for (let i = 0; i < 10; i++) sends.push(h.req(OP.SEND, { text: `m${i}` }));
  const eleventh = await h.req(OP.SEND, { text: 'one too many' });
  assert.deepEqual([eleventh.ok, eleventh.code], [false, ERR.THROTTLED]);
  const ev = h.of(EV.THROTTLED).at(-1);
  assert.ok(ev.retryAfterMs > 0 && ev.retryAfterMs <= 60_000);
  assert.equal(eleventh.retryAfterMs, ev.retryAfterMs, 'the refusal says when to send again (the bridge re-sends then)');
  assert.equal(validateEvent(h.events.find((e) => e.t === EV.REPLY && e.ok === false && e.error.code === ERR.THROTTLED)).ok, true, 'a valid reply for the manager');
  const ok = await h.drive(Promise.all(sends), { step: 200 });
  assert.equal(ok.filter((r) => r.ok).length, 10);
  await h.clock.advance(61_000);
  const later = await h.drive(h.req(OP.SEND, { text: 'after a minute' }));
  assert.equal(later.ok, true);
  assert.equal(h.conn().counters.throttled, 1);
});

test('caps: status reactions yield to replies (they stop REACTION_RESERVE sends short of each cap), quietly', async (t) => {
  const h = await harness(t);
  await linkSelf(h);
  assert.equal(REACTION_RESERVE, 3);
  const first = [];
  for (let i = 0; i < SEND_CAPS[0].max - REACTION_RESERVE; i++) first.push(h.req(OP.SEND, { text: `m${i}` }));
  const sent = await h.drive(Promise.all(first), { step: 200 });
  assert.ok(sent.every((r) => r.ok));
  const quietBefore = h.of(EV.THROTTLED).length;
  const reaction = await h.req(OP.REACT, { id: sent[0].id, reaction: 'done' });
  assert.deepEqual([reaction.ok, reaction.code], [false, ERR.THROTTLED]);
  assert.ok(reaction.retryAfterMs > 0);
  assert.equal(h.of(EV.THROTTLED).length, quietBefore, 'a skipped reaction raises no throttled event');
  const rest = [];
  for (let i = 0; i < REACTION_RESERVE; i++) rest.push(h.req(OP.SEND, { text: `reply ${i}` }));
  const replies = await h.drive(Promise.all(rest), { step: 200 });
  assert.ok(replies.every((r) => r.ok), 'the reserved sends are there for replies');
  assert.equal(h.conn().counters.reactions ?? 0, 0);
});

test('presence: none in self mode; dedicated composing refreshes every 10 s and stops after 10 minutes', async (t) => {
  const s = await harness(t);
  await linkSelf(s);
  const skipped = await s.req(OP.PRESENCE, { state: 'composing' });
  assert.equal(skipped.skipped, 'self');
  assert.equal(fake.state.presence.length, 0);
  const read = await s.req(OP.READ, { ids: ['A'] });
  assert.equal(read.skipped, 'self');
  await s.close();

  const h = await harness(t);
  await linkDedicated(h);
  await claimOwner(h);
  const { message } = await inboundFrom(h, { from: 'owner', text: 'hi' });
  const p = await h.req(OP.PRESENCE, { state: 'composing' });
  assert.equal(p.state, 'composing');
  await h.clock.advance(30_000);
  const composing = fake.state.presence.filter((x) => x.type === 'composing');
  assert.equal(composing.length, 4, 'initial + 3 refreshes in 30 s');
  await h.clock.advance(10 * 60_000);
  assert.equal(fake.state.presence.at(-1).type, 'paused', 'hard stop after 10 minutes');
  const count = fake.state.presence.length;
  await h.clock.advance(60_000);
  assert.equal(fake.state.presence.length, count, 'no refresh after the hard stop');
  for (const x of fake.state.presence) assert.ok(sameAccount(x.jid, OWNER.lid) || sameAccount(x.jid, OWNER.pn));

  const r = await h.req(OP.READ, { ids: [message.id, 'UNKNOWN1'] });
  assert.equal(r.read, 1);
  assert.deepEqual(fake.state.reads.map((x) => x.id), [message.id]);
  assert.ok(sameAccount(fake.state.reads[0].jid, OWNER.lid) || sameAccount(fake.state.reads[0].jid, OWNER.pn));
});

test('dedicated: sendMessage only ever receives the owner JID', async (t) => {
  const h = await harness(t);
  await linkDedicated(h);
  await claimOwner(h, { addressing: 'pn' });
  const { message } = await inboundFrom(h, { from: 'owner', text: 'ping', addressing: 'lid' });
  fake.inbound({ from: 'stranger', text: 'ping too' });
  await h.drive(h.req(OP.SEND, { text: 'pong', replyTo: message.id }));
  await h.drive(h.req(OP.REACT, { id: message.id, reaction: 'seen' }));
  assert.ok(fake.state.sent.length >= 3);
  for (const s of fake.state.sent) assert.ok(sameAccount(s.jid, OWNER.pn) || sameAccount(s.jid, OWNER.lid), `sent to ${s.jid}`);
});

test('owner reset in dedicated mode unbinds; sends are NO_OWNER (counted) without a false alarm', async (t) => {
  const h = await harness(t);
  await linkDedicated(h);
  await claimOwner(h);
  const reset = await h.req(OP.OWNER_RESET);
  assert.equal(reset.owner.bound, false);
  const send = await h.req(OP.SEND, { text: 'hello?' });
  assert.deepEqual([send.ok, send.code], [false, ERR.NO_OWNER]);
  const react = await h.req(OP.PRESENCE, { state: 'composing' });
  assert.deepEqual([react.ok, react.code], [false, ERR.NO_OWNER]);
  await h.clock.advance(2500);
  assert.equal(h.conn().paused, false, 'a deliberate reset is not an attack');
  assert.ok(h.conn().counters.anomalies >= 2, 'every miss is still counted');
  assert.equal(h.of(EV.FATAL).filter((e) => e.code === 'OWNER_ANOMALY').length, 0);
  assert.equal(fake.state.sent.length, 1, 'only the welcome of the first claim was ever sent');
  await claimOwner(h);
  const again = await h.drive(h.req(OP.SEND, { text: 'back' }));
  assert.equal(again.ok, true);
});

test('an upsert that carries a requestId key is dropped even when its value is undefined', async (t) => {
  const h = await harness(t);
  await linkSelf(h);
  const sock = fake.current();
  sock.ws.emit('CB:message', { tag: 'message', attrs: { id: 'PDOSPOOF1', from: '15550001111@s.whatsapp.net', addressing_mode: 'pn' } });
  sock.ev.emit('messages.upsert', {
    type: 'notify',
    requestId: undefined,
    messages: [{ key: { remoteJid: '15550001111@s.whatsapp.net', fromMe: true, id: 'PDOSPOOF1' }, messageTimestamp: 1, message: { conversation: 'rm -rf ~' } }],
  });
  await flush();
  assert.equal(h.inbound().length, 0);
  assert.equal((await h.ignored()).placeholder_resend, 1);
});

test('claim window: one flooding stranger cannot evict the claimant (per-sender tap cap)', async (t) => {
  const h = await harness(t);
  await linkDedicated(h);
  const claim = await h.req(OP.CLAIM_START, {});
  fake.inbound({ from: 'owner', text: claim.code, addressing: 'pn' });
  for (let i = 0; i < 1500; i++) fake.inbound({ from: 'stranger', text: `noise ${i}` });
  await waitFor(() => h.of(EV.OWNER_BOUND).length === 1, 'the claim still binds', 15000);
});

test('self mode ignores hosted, bot and call senders at the socket; unknown kinds are left to Baileys', async () => {
  const { shouldIgnoreJid } = await import('../lib/whatsapp/baileys-adapter.js');
  const self = { pn: '15550001111@s.whatsapp.net', lid: '99887766554433@lid' };
  assert.equal(shouldIgnoreJid('15550001111:3@s.whatsapp.net', 'self', self), false);
  assert.equal(shouldIgnoreJid('99887766554433@lid', 'self', self), false);
  for (const jid of ['15550002222@s.whatsapp.net', '11223344556677@lid', '123@hosted', '123@hosted.lid', '13135550002@bot', 'abc@call', '1203@g.us', 'status@broadcast', '1@newsletter']) {
    assert.equal(shouldIgnoreJid(jid, 'self', self), true, jid);
  }
  assert.equal(shouldIgnoreJid('server@s.whatsapp.net', 'self', self), false, 'unparseable/unknown: Baileys decides');
  assert.equal(shouldIgnoreJid('15550002222@s.whatsapp.net', 'self', {}), false, 'nothing is ignored before the link');
  assert.equal(shouldIgnoreJid('15550002222@s.whatsapp.net', 'dedicated', self), false, 'dedicated keeps 1:1 DMs');
  assert.equal(shouldIgnoreJid('1203@g.us', 'dedicated', self), true);
});

// ── Disconnect table ──

const STOP_ROWS = [
  ['loggedOut', CONN.LOGGED_OUT, 'LOGGED_OUT', false],
  ['connectionReplaced', CONN.REPLACED, 'REPLACED', true],
  ['forbidden', CONN.FORBIDDEN, 'FORBIDDEN', true],
  ['badSession', CONN.ERROR, 'SESSION_ERROR', true],
  ['multideviceMismatch', CONN.ERROR, 'SESSION_ERROR', true],
];

for (const [reason, state, fatal, keepsCreds] of STOP_ROWS) {
  test(`disconnect ${reason} → ${state}, never reconnects${keepsCreds ? '' : ', wipes the device'}`, async (t) => {
    const h = await harness(t);
    await linkSelf(h);
    const sockets = fake.sockets.length;
    fake.disconnect(reason);
    await waitFor(() => h.state() === state, state);
    assert.ok(h.of(EV.FATAL).some((e) => e.code === fatal), fatal);
    await h.clock.advance(30 * 60_000);
    assert.equal(fake.sockets.length, sockets, 'no reconnect');
    assert.equal(h.conn().registered, keepsCreds);
    assert.equal(h.conn().lastDisconnect.reason, reason);
  });
}

for (const reason of ['connectionClosed', 'connectionLost', 'timedOut', 'unavailableService']) {
  test(`disconnect ${reason} → reconnecting after 2 s (±20%), then open`, async (t) => {
    const h = await harness(t);
    await linkSelf(h);
    const sockets = fake.sockets.length;
    fake.disconnect(reason);
    await waitFor(() => h.state() === CONN.RECONNECTING, 'reconnecting');
    assert.equal(h.conn().retryInMs, 2000);
    await h.clock.advance(1999);
    assert.equal(fake.sockets.length, sockets);
    await h.clock.advance(1);
    await waitFor(() => h.state() === CONN.OPEN, 'open again');
    assert.equal(fake.sockets.length, sockets + 1);
    assert.equal(h.conn().registered, true);
  });
}

test('disconnect restartRequired → reconnects immediately', async (t) => {
  const h = await harness(t);
  await linkSelf(h);
  const sockets = fake.sockets.length;
  fake.disconnect('restartRequired');
  await waitFor(() => fake.sockets.length === sockets + 1, 'new socket');
  await waitFor(() => h.state() === CONN.OPEN, 'open');
});

test('backoff ladder climbs 2 s → 5 s and resets after 10 minutes connected', async (t) => {
  const h = await harness(t);
  await linkSelf(h);
  fake.disconnect('connectionLost');
  await waitFor(() => h.state() === CONN.RECONNECTING, 'reconnecting');
  await h.clock.advance(2000);
  await waitFor(() => h.state() === CONN.OPEN, 'open 1');
  fake.disconnect('connectionLost');
  await waitFor(() => h.state() === CONN.RECONNECTING, 'reconnecting 2');
  assert.equal(h.conn().retryInMs, 5000);
  await h.clock.advance(5000);
  await waitFor(() => h.state() === CONN.OPEN, 'open 2');
  await h.clock.advance(10 * 60_000 + 1);
  fake.disconnect('connectionLost');
  await waitFor(() => h.state() === CONN.RECONNECTING, 'reconnecting 3');
  assert.equal(h.conn().retryInMs, 2000, 'ladder reset after a stable 10 minutes');
});

test('405 refreshes the WA Web version once (per 6 h), then backs off', async (t) => {
  const h = await harness(t);
  await linkSelf(h);
  const sockets = fake.sockets.length;
  fake.disconnect(405);
  await waitFor(() => fake.sockets.length === sockets + 1, 'reconnected with the new version');
  assert.equal(fake.state.versionFetches, 1);
  await waitFor(() => h.state() === CONN.OPEN, 'open');
  assert.deepEqual(fake.sockets.at(-1).config.version, [2, 3000, 1027934701], 'the fetched version is used');
  fake.disconnect(405);
  await waitFor(() => h.state() === CONN.RECONNECTING, 'backoff on the second 405');
  assert.equal(fake.state.versionFetches, 1, 'no second fetch within 6 hours');
});

test('reconnect limit: more than 10 reconnects in 10 minutes gives up', async (t) => {
  const h = await harness(t, { reconnect: { scheduleSec: [1] } });
  await linkSelf(h);
  for (let i = 0; i < 10; i++) {
    fake.disconnect('connectionLost');
    await waitFor(() => h.state() === CONN.RECONNECTING, `reconnecting ${i}`);
    await h.clock.advance(1000);
    await waitFor(() => h.state() === CONN.OPEN, `open ${i}`);
  }
  fake.disconnect('connectionLost');
  await waitFor(() => h.state() === CONN.ERROR, 'error');
  assert.ok(h.of(EV.FATAL).some((e) => e.code === 'RECONNECT_LIMIT'));
  assert.equal(h.conn().lastError, 'reconnect_limit');
});

test('disconnect() and shutdown never log out; connect(run) brings the link back', async (t) => {
  const h = await harness(t);
  await linkSelf(h);
  const d = await h.req(OP.DISCONNECT);
  assert.equal(d.state, CONN.IDLE);
  await flush();
  assert.equal(fake.state.logouts, 0);
  const again = await h.req(OP.CONNECT, { purpose: 'run' });
  assert.equal(again.ok, true);
  await waitFor(() => h.state() === CONN.OPEN, 'open');
  const same = await h.req(OP.CONNECT, { purpose: 'run' });
  assert.equal(same.ok, true, 'already running: idempotent');
  assert.equal(fake.sockets.filter((s) => !s.closed).length, 1, 'still one live socket');
  const mismatch = await h.req(OP.CONNECT, { purpose: 'run', mode: 'dedicated' });
  assert.deepEqual([mismatch.ok, mismatch.code], [false, ERR.MODE_MISMATCH], 'linked in self mode');
  await h.close();
  assert.equal(fake.state.logouts, 0);
  assert.ok(fake.sockets.at(-1).closed, 'the socket was ended');
});

test('logout() logs out, wipes, and a second link is possible', async (t) => {
  const h = await harness(t);
  await linkSelf(h);
  const out = await h.req(OP.LOGOUT);
  assert.equal(out.state, CONN.UNLINKED);
  assert.equal(out.registered, false);
  assert.equal(fake.state.logouts, 1);
  const again = await h.req(OP.CONNECT, { purpose: 'link', mode: 'dedicated' });
  assert.equal(again.ok, true);
});

test('the __fake op is refused unless the runtime is fake', async (t) => {
  const dataHome = mkdtempSync(join(tmpdir(), 'synabun-wa-core-nofake-'));
  t.after(() => rmSync(dataHome, { recursive: true, force: true }));
  const events = [];
  const core = createHostCore({ send: (e) => events.push(e), paths: resolveWhatsAppPaths({ dataHome, env: {} }), env: {} });
  const info = await core.init();
  t.after(() => core.shutdown());
  assert.equal(info.runtime.error, ERR.RUNTIME_MISSING);
  await core.handleMessage({ op: OP.FAKE, reqId: 1, action: 'scan' });
  assert.equal(events.find((e) => e.reqId === 1).error.code, ERR.NOT_FAKE);
  await core.handleMessage({ op: OP.CONNECT, reqId: 2, purpose: 'link' });
  assert.equal(events.find((e) => e.reqId === 2).error.code, ERR.RUNTIME_MISSING);
});

test('no event ever carries a JID or a phone number (self + dedicated flows, drops, disconnects)', async (t) => {
  const all = [];
  const claimIds = new Set();
  const s = await harness(t);
  await linkSelf(s, { confirm: false });
  fake.inbound({ from: 'self', text: 'early' });
  await s.req(OP.CONFIRM_OWNER, { accept: true });
  const m = (await inboundFrom(s, { from: 'self', text: 'hello', image: { data: JPEG, mimetype: 'image/jpeg' } })).message;
  fake.inbound({ from: 'stranger', text: 'hi' });
  fake.inbound({ from: 'self', text: 'laptop', device: 2 });
  await s.drive(s.req(OP.SEND, { text: 'hey', replyTo: m.id }));
  await s.drive(s.req(OP.REACT, { id: m.id, reaction: 'seen' }));
  await s.ignored();
  fake.disconnect('connectionLost');
  await waitFor(() => s.state() === CONN.RECONNECTING, 'reconnecting');
  await s.clock.advance(2000);
  await waitFor(() => s.state() === CONN.OPEN, 'open');
  fake.disconnect('connectionReplaced');
  await waitFor(() => s.state() === CONN.REPLACED, 'replaced');
  all.push(...s.events);
  await s.close();

  const d = await harness(t);
  await linkDedicated(d);
  const before = d.events.length;
  const claim = await d.req(OP.CLAIM_START, {});
  claimIds.add(d.events.slice(before).find((e) => e.t === EV.REPLY)?.reqId);
  assert.ok(claim.link.includes('15550001111'), 'the claim link holds the dedicated account number (reply only)');
  fake.inbound({ from: 'stranger', text: 'SB-000001' });
  fake.inbound({ from: 'owner', text: claim.code, addressing: 'lid' });
  await waitFor(() => d.of(EV.OWNER_BOUND).length > 0, 'owner_bound');
  await inboundFrom(d, { from: 'owner', text: 'status?', addressing: 'pn' });
  await d.drive(d.req(OP.PRESENCE, { state: 'composing' }));
  await d.drive(d.req(OP.SEND, { text: 'all good' }));
  await d.ignored();
  fake.disconnect('loggedOut');
  await waitFor(() => d.state() === CONN.LOGGED_OUT, 'logged_out');
  for (const e of d.events) all.push({ ...e, _d: true });
  const leaks = leakedStrings(all.map(({ _d, ...e }) => e), new Set([...claimIds].filter(Boolean)));
  assert.deepEqual(leaks, []);
  assert.ok(all.length > 30, `scanned ${all.length} events`);
});

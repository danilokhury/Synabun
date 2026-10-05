// WhatsApp Link protocol: op/event validation (closed schemas, no address on
// send/react/presence/read) and the path layout shared by every package.
process.env.SYNABUN_TYPESAFE = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  ADDRESS_KEYS, CONN, ERR, EV, LIMITS, OP, PROTOCOL_VERSION, REACTIONS, pickPrefs, validateEvent, validateOp,
} from '../lib/whatsapp/protocol.js';
import { isInside, resolveWhatsAppPaths } from '../lib/whatsapp/paths.js';

const CONN_OK = {
  state: 'open', mode: 'self', registered: true, me: { masked: '••••1111', name: 'Ana' }, owner: { bound: true, masked: '••••1111' },
  lastDisconnect: null, retryInMs: null, counters: { inbound: 1 }, paused: false, awaitingConfirmUntil: null, claim: null, lastError: null,
};
const INBOUND_OK = {
  id: 'ABCDEF123', ts: 1, chat: 'self', text: 'hi', images: [], unsupported: null, forwarded: false, quoted: null, owner: true,
};

test('constants match the contract', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.deepEqual({ ...LIMITS }, { MAX_TEXT: 3500, MAX_INBOUND_TEXT: 8192, MAX_IMAGE_BYTES: 5242880, MAX_IMAGES: 4, MAX_READ_IDS: 20 });
  assert.deepEqual([...ADDRESS_KEYS], ['jid', 'to', 'remoteJid', 'chat', 'number', 'participant', 'recipient']);
  assert.deepEqual(Object.values(CONN).sort(), [
    'awaiting_confirm', 'connecting', 'error', 'forbidden', 'held', 'idle', 'link_expired', 'locked', 'logged_out', 'open', 'pairing', 'qr',
    'reconnecting', 'replaced', 'unlinked',
  ]);
  assert.deepEqual(Object.keys(REACTIONS), ['seen', 'queued', 'done', 'failed', 'stopped']);
  for (const name of ['state', 'qr', 'pairing_code', 'linked', 'owner_bound', 'inbound', 'ignored', 'throttled', 'fatal']) {
    assert.ok(Object.values(EV).includes(name), name);
  }
});

test('validateOp accepts every well-formed op', () => {
  const ok = [
    { op: OP.CONFIGURE, reqId: 1, prefs: { mode: 'dedicated', selfTrigger: 'prefix', prefix: 'sb' } },
    { op: OP.CONNECT, reqId: 2, purpose: 'run' },
    { op: OP.CONNECT, reqId: 3, purpose: 'link', mode: 'self', link: { method: 'code', phone: '5511999999999' } },
    { op: OP.DISCONNECT, reqId: 4 },
    { op: OP.LOGOUT },
    { op: OP.CONFIRM_OWNER, reqId: 5, accept: true },
    { op: OP.CLAIM_START, reqId: 6, ttlMs: 60000 },
    { op: OP.CLAIM_START, reqId: 7 },
    { op: OP.CLAIM_CANCEL, reqId: 8 },
    { op: OP.OWNER_RESET, reqId: 9 },
    { op: OP.SEND, reqId: 10, text: 'hello' },
    { op: OP.SEND, reqId: 11, text: 'hello', replyTo: '3EB0ABCDEF' },
    { op: OP.SEND, reqId: 12, text: 'hello', replyTo: null },
    { op: OP.REACT, reqId: 13, id: '3EB0ABCDEF', reaction: 'done' },
    { op: OP.REACT, reqId: 14, id: '3EB0ABCDEF', reaction: null },
    { op: OP.PRESENCE, reqId: 15, state: 'composing' },
    { op: OP.READ, reqId: 16, ids: ['A1', 'B2'] },
    { op: OP.STATUS, reqId: 17 },
    { op: OP.SHUTDOWN },
    { op: OP.FAKE, reqId: 18, action: 'scan', args: {} },
  ];
  for (const msg of ok) assert.deepEqual(validateOp(msg), { ok: true }, JSON.stringify(msg));
});

test('validateOp rejects unknown ops, unknown fields and bad values', () => {
  const cases = [
    [{ op: 'explode' }, ERR.UNKNOWN_OP],
    [null, ERR.BAD_REQUEST],
    [{ op: OP.SEND, text: 'x', extra: 1 }, ERR.BAD_REQUEST],
    [{ op: OP.SEND }, ERR.BAD_REQUEST],
    [{ op: OP.SEND, text: 42 }, ERR.BAD_REQUEST],
    [{ op: OP.SEND, text: 'x', replyTo: 'has space' }, ERR.BAD_REQUEST],
    [{ op: OP.REACT, id: 'X', reaction: 'love' }, ERR.BAD_REQUEST],
    [{ op: OP.PRESENCE, state: 'recording' }, ERR.BAD_REQUEST],
    [{ op: OP.READ, ids: Array.from({ length: 21 }, (_, i) => `ID${i}`) }, ERR.BAD_REQUEST],
    [{ op: OP.CONNECT, purpose: 'hack' }, ERR.BAD_REQUEST],
    [{ op: OP.CONNECT, purpose: 'link', link: { method: 'qr', jid: 'x@s.whatsapp.net' } }, ERR.BAD_REQUEST],
    [{ op: OP.CONFIGURE, prefs: { mode: 'self', token: 'abc' } }, ERR.BAD_REQUEST],
    [{ op: OP.CONFIGURE, prefs: { prefix: 'has space' } }, ERR.BAD_REQUEST],
    [{ op: OP.CONFIRM_OWNER, accept: 'yes' }, ERR.BAD_REQUEST],
    [{ op: OP.STATUS, reqId: -1 }, ERR.BAD_REQUEST],
    [{ op: OP.STATUS, reqId: 1.5 }, ERR.BAD_REQUEST],
  ];
  for (const [msg, code] of cases) {
    const v = validateOp(msg);
    assert.equal(v.ok, false, JSON.stringify(msg));
    assert.equal(v.code, code, JSON.stringify(msg));
  }
});

test('send/react/presence/read never take an address — every address key is refused', () => {
  const bases = [
    { op: OP.SEND, text: 'hi' },
    { op: OP.REACT, id: 'ABC', reaction: 'seen' },
    { op: OP.PRESENCE, state: 'composing' },
    { op: OP.READ, ids: ['ABC'] },
  ];
  for (const base of bases) {
    for (const key of ADDRESS_KEYS) {
      for (const value of ['15551234567@s.whatsapp.net', '15551234567', null, undefined, { a: 1 }]) {
        const v = validateOp({ ...base, [key]: value });
        assert.equal(v.ok, false, `${base.op} + ${key}`);
        assert.equal(v.code, ERR.ADDRESS_FORBIDDEN, `${base.op} + ${key}`);
      }
    }
  }
});

test('validateEvent: closed schemas, inbound can never carry a JID field', () => {
  assert.deepEqual(validateEvent({ t: EV.STATE, conn: CONN_OK }), { ok: true });
  assert.deepEqual(validateEvent({ t: EV.INBOUND, message: INBOUND_OK }), { ok: true });
  assert.deepEqual(validateEvent({ t: EV.INBOUND, message: { ...INBOUND_OK, images: [{ base64: 'AAAA', mediaType: 'image/png', bytes: 3 }], quoted: { id: 'Q1', text: 'q', fromBot: true }, unsupported: { type: 'audio' } } }), { ok: true });
  assert.deepEqual(validateEvent({ t: EV.QR, qr: 'https://wa.me/settings/linked_devices#2@abc', expiresAt: 5 }), { ok: true });
  assert.deepEqual(validateEvent({ t: EV.IGNORED, counts: { not_owner: 2, group: 1 } }), { ok: true });
  assert.deepEqual(validateEvent({ t: EV.REPLY, reqId: 3, ok: true, data: { anything: 1 } }), { ok: true });
  assert.deepEqual(validateEvent({ t: EV.READY, protocol: 1, pid: 3, runtime: { loaded: true, version: '7', fake: false, error: null }, conn: CONN_OK }), { ok: true });

  const bad = [
    { t: 'surprise' },
    { t: EV.INBOUND, message: { ...INBOUND_OK, remoteJid: '1@s.whatsapp.net' } },
    { t: EV.INBOUND, message: { ...INBOUND_OK, jid: '1@s.whatsapp.net' } },
    { t: EV.INBOUND, message: { ...INBOUND_OK, owner: false } },
    { t: EV.INBOUND, message: { ...INBOUND_OK, chat: '15551234567@s.whatsapp.net' } },
    { t: EV.INBOUND, message: { ...INBOUND_OK, images: [{ base64: 'A', mediaType: 'image/gif', bytes: 1 }] } },
    { t: EV.INBOUND, message: { ...INBOUND_OK, images: Array.from({ length: 5 }, () => ({ base64: 'A', mediaType: 'image/png', bytes: 1 })) } },
    { t: EV.INBOUND, message: { ...INBOUND_OK, text: 'x'.repeat(LIMITS.MAX_INBOUND_TEXT + 1) } },
    { t: EV.STATE, conn: { ...CONN_OK, owner: { bound: true, masked: 'x', jid: '1@lid' } } },
    { t: EV.STATE, conn: { ...CONN_OK, me: { masked: 'x', name: 'y', id: '1@s.whatsapp.net' } } },
    { t: EV.STATE, conn: { ...CONN_OK, state: 'weird' } },
    { t: EV.OWNER_BOUND, masked: 'x', via: 'claim', pn: '1@s.whatsapp.net' },
    { t: EV.IGNORED, counts: { 'Not-A-Reason': 1 } },
    { t: EV.LINKED, mode: 'self', me: null, jid: 'x' },
  ];
  for (const ev of bad) assert.equal(validateEvent(ev).ok, false, JSON.stringify(ev).slice(0, 120));
});

test('pickPrefs keeps only the keys the host understands', () => {
  assert.deepEqual(pickPrefs({ mode: 'dedicated', selfTrigger: 'prefix', prefix: 'sb', enabled: true, level: 'ask', token: 'x' }), { mode: 'dedicated', selfTrigger: 'prefix', prefix: 'sb' });
  assert.deepEqual(pickPrefs(null), {});
});

test('paths: layout per platform; credentials never under DATA_HOME/data', () => {
  const posix = resolveWhatsAppPaths({ dataHome: '/home/ana/.synabun', env: {}, platform: 'linux' });
  assert.equal(posix.waHome, '/home/ana/.synabun/whatsapp');
  assert.equal(posix.authDir, '/home/ana/.synabun/whatsapp/auth');
  assert.equal(posix.runtimeDir, '/home/ana/.synabun/runtime/whatsapp');
  assert.equal(posix.stagingDir, '/home/ana/.synabun/runtime/whatsapp.staging');
  assert.equal(posix.logsDir, '/home/ana/.synabun/data/logs');
  assert.equal(posix.installLogPath, '/home/ana/.synabun/data/whatsapp/install.log');
  assert.equal(posix.npmCacheDir, '/home/ana/.synabun/cache/npm');
  assert.ok(!isInside(posix.authDir, '/home/ana/.synabun/data', 'linux'));

  const win = resolveWhatsAppPaths({
    dataHome: 'C:\\Users\\Ana\\AppData\\Roaming\\synabun',
    env: { LOCALAPPDATA: 'C:\\Users\\Ana\\AppData\\Local' },
    platform: 'win32',
  });
  assert.equal(win.waHome, 'C:\\Users\\Ana\\AppData\\Local\\synabun\\whatsapp');
  assert.equal(win.authDir, 'C:\\Users\\Ana\\AppData\\Local\\synabun\\whatsapp\\auth');
  assert.equal(win.runtimeDir, 'C:\\Users\\Ana\\AppData\\Roaming\\synabun\\runtime\\whatsapp');
  assert.equal(win.logsDir, 'C:\\Users\\Ana\\AppData\\Roaming\\synabun\\data\\logs');

  const winNoLocal = resolveWhatsAppPaths({ dataHome: 'C:\\x\\synabun', env: { USERPROFILE: 'C:\\Users\\Bo' }, platform: 'win32' });
  assert.equal(winNoLocal.waHome, 'C:\\Users\\Bo\\AppData\\Local\\synabun\\whatsapp');

  const override = resolveWhatsAppPaths({ dataHome: '/d', env: { SYNABUN_WHATSAPP_HOME: '/secure/wa' }, platform: 'darwin' });
  assert.equal(override.waHome, '/secure/wa');
  assert.deepEqual(override.warnings, []);

  const inside = resolveWhatsAppPaths({ dataHome: '/d', env: { SYNABUN_WHATSAPP_HOME: '/d/data/wa' }, platform: 'darwin' });
  assert.equal(inside.waHome, '/d/whatsapp', 'an override inside the backed-up data folder is refused');
  assert.equal(inside.warnings.length, 1);

  assert.throws(() => resolveWhatsAppPaths({ env: {} }), /dataHome/);
  assert.equal(path.isAbsolute(posix.waHome), true);
});

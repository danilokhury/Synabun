// WhatsApp Link credential store: one transaction per write, open-ended key
// types, the single-instance lock, permissions, wipe and pruning.
process.env.SYNABUN_TYPESAFE = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FALLBACK_CODEC, STATE_DB, openAuthStore } from '../lib/whatsapp/auth-store.js';
import { loadRuntime } from '../lib/whatsapp/baileys-adapter.js';

const POSIX = process.platform !== 'win32';

function tempAuth(t) {
  const dir = mkdtempSync(join(tmpdir(), 'synabun-wa-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'whatsapp', 'auth');
}

function open(t, authDir, opts = {}) {
  const store = openAuthStore({ authDir, ...opts });
  t.after(() => store.close());
  return store;
}

test('creds round-trip with Buffers; saveCreds is one transaction', (t) => {
  const authDir = tempAuth(t);
  const store = open(t, authDir);
  assert.equal(store.loadCreds(), null);
  const creds = { me: { id: '15550001111:12@s.whatsapp.net' }, noiseKey: { private: Buffer.alloc(32, 7), public: new Uint8Array([1, 2, 3]) }, registered: false };
  store.saveCreds(creds);
  const back = store.loadCreds();
  assert.deepEqual(back.noiseKey.private, Buffer.alloc(32, 7));
  assert.deepEqual(back.noiseKey.public, Buffer.from([1, 2, 3]));
  assert.equal(back.me.id, creds.me.id);
  assert.throws(() => store.saveCreds({ bad: 10n }), /BigInt/);
  assert.equal(store.loadCreds().me.id, creds.me.id, 'a failed save leaves the previous creds intact');
});

test('every key type, including one Baileys has not invented yet; null deletes', async (t) => {
  const authDir = tempAuth(t);
  const fake = await loadRuntime({ env: { SYNABUN_WHATSAPP_FAKE: '1' } });
  const store = open(t, authDir, { codec: fake.codec, reviveKey: fake.reviveKey });
  const data = {
    'pre-key': { 1: { public: Buffer.from([1]), private: Buffer.from([2]) }, 2: { public: Buffer.from([3]), private: Buffer.from([4]) } },
    session: { '15550001111.0': Buffer.from('session-bytes') },
    'sender-key': { 'g1::15550001111::0': Buffer.from('sk') },
    'sender-key-memory': { g1: { '15550001111:0@s.whatsapp.net': true } },
    'app-state-sync-key': { AAAAAQ: { keyData: Buffer.from('k'), fingerprint: { rawId: 1 }, timestamp: 5 } },
    'app-state-sync-version': { regular: { version: 3, hash: Buffer.alloc(128, 1), indexValueMap: {} } },
    'lid-mapping': { '15550001111': '99887766554433', '99887766554433_reverse': '15550001111' },
    'device-list': { '15550001111': ['0', '12'] },
    tctoken: { '15550003333@s.whatsapp.net': { token: Buffer.from('tc'), timestamp: '1700000000' } },
    'identity-key': { '15550003333.0': Buffer.from('id') },
    'hologram-key-2031': { future: { anything: [1, 2, { deep: Buffer.from('x') }] } },
  };
  store.keys.set(data);
  const counts = store.keyCounts();
  for (const type of Object.keys(data)) assert.ok(counts[type] >= 1, `${type} stored`);
  assert.deepEqual(store.keys.get('pre-key', ['1', '2', '3']), data['pre-key'], 'missing ids are simply absent');
  assert.deepEqual(store.keys.get('session', ['15550001111.0'])['15550001111.0'], Buffer.from('session-bytes'));
  assert.deepEqual(store.keys.get('device-list', ['15550001111']), { 15550001111: ['0', '12'] });
  assert.deepEqual(store.keys.get('hologram-key-2031', ['future']).future.anything[2].deep, Buffer.from('x'));
  const revived = store.keys.get('app-state-sync-key', ['AAAAAQ']).AAAAAQ;
  assert.equal(revived.revivedByProto, true, 'app-state-sync-key goes through proto.Message.AppStateSyncKeyData.fromObject');
  assert.deepEqual(revived.keyData, Buffer.from('k'));

  store.keys.set({ 'pre-key': { 1: null }, 'hologram-key-2031': { future: undefined } });
  assert.deepEqual(Object.keys(store.keys.get('pre-key', ['1', '2'])), ['2']);
  assert.deepEqual(store.keys.get('hologram-key-2031', ['future']), {});
});

test('a failing keys.set rolls back every write of that call', (t) => {
  const store = open(t, tempAuth(t));
  store.keys.set({ session: { a: Buffer.from('old') } });
  assert.throws(() => store.keys.set({
    session: { a: Buffer.from('new'), b: Buffer.from('b') },
    'pre-key': { 9: { bad: 10n } },
  }), /BigInt/);
  assert.deepEqual(store.keys.get('session', ['a', 'b']), { a: Buffer.from('old') }, 'nothing from the failed call persisted');
  store.keys.set({ session: { b: Buffer.from('b') } });
  assert.deepEqual(Object.keys(store.keys.get('session', ['a', 'b'])).sort(), ['a', 'b'], 'the store still works after a rollback');
});

test('a second open of the same auth folder fails with LOCKED until the first closes', (t) => {
  const authDir = tempAuth(t);
  const first = openAuthStore({ authDir });
  first.saveCreds({ me: { id: 'x' } });
  assert.throws(() => openAuthStore({ authDir }), (err) => err.code === 'LOCKED');
  first.close();
  const second = openAuthStore({ authDir });
  assert.equal(second.loadCreds().me.id, 'x');
  second.close();
});

test('permissions: folder 0700, files 0600, loose modes repaired and logged', { skip: !POSIX && 'POSIX permissions only' }, (t) => {
  const authDir = tempAuth(t);
  const logs = [];
  const store = openAuthStore({ authDir, log: (m) => logs.push(m) });
  store.saveCreds({ me: { id: 'x' } });
  assert.equal(statSync(authDir).mode & 0o777, 0o700);
  for (const name of readdirSync(authDir)) assert.equal(statSync(join(authDir, name)).mode & 0o777, 0o600, name);
  store.close();
  chmodSync(authDir, 0o755);
  chmodSync(join(authDir, STATE_DB), 0o644);
  const again = openAuthStore({ authDir, log: (m) => logs.push(m) });
  t.after(() => again.close());
  assert.equal(statSync(authDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(authDir, STATE_DB)).mode & 0o777, 0o600);
  assert.ok(logs.some((m) => /repaired permissions on the auth folder/.test(m)));
  assert.ok(logs.some((m) => /repaired permissions on the auth file state\.db/.test(m)));
});

// ── Permissions that cannot be verified or repaired: AUTH_PERMS, fail closed ──

function fsError(code, syscall, path) {
  const err = new Error(`${code}: operation not permitted, ${syscall} '${path}'`);
  err.code = code;
  err.syscall = syscall;
  err.path = path;
  return err;
}

/** A copy of a real Stats that reports other permission bits (or another owner). */
function lying(st, { perm, uid } = {}) {
  const out = Object.assign(Object.create(Object.getPrototypeOf(st)), st);
  if (perm !== undefined) out.mode = (st.mode & ~0o777) | perm;
  if (uid !== undefined) out.uid = uid;
  return out;
}

function authPerms(detail) {
  return (err) => {
    assert.equal(err.code, 'AUTH_PERMS', `expected AUTH_PERMS, got ${err.code}: ${err.message}`);
    assert.match(err.message, /^SynaBun could not make the WhatsApp session files private \(/);
    assert.match(err.message, /fix the folder permissions .*then reconnect$/);
    if (detail) assert.match(err.message, detail);
    return true;
  };
}

test('permissions: a folder whose mode cannot be repaired is refused (AUTH_PERMS); no database is created', { skip: !POSIX && 'POSIX permissions only' }, (t) => {
  const authDir = tempAuth(t);
  mkdirSync(authDir, { recursive: true });
  chmodSync(authDir, 0o755);
  const chmods = [];
  const fsImpl = { chmodSync: (path, mode) => { chmods.push([path, mode]); throw fsError('EPERM', 'chmod', path); } };
  assert.throws(() => openAuthStore({ authDir, fsImpl }), authPerms(/\(the folder \S+ has mode 755 and chmod failed: EPERM\)/));
  assert.throws(() => openAuthStore({ authDir, fsImpl }), (err) => err.message.includes(authDir), 'the message names the folder to fix');
  assert.deepEqual(chmods[0], [authDir, 0o700]);
  assert.deepEqual(readdirSync(authDir), [], 'no credential database was created, let alone opened');
  const store = open(t, authDir);
  assert.equal(statSync(authDir).mode & 0o777, 0o700, 'the real chmod repairs it; nothing was left locked');
  assert.equal(store.closed, false);
});

test('permissions: a state.db whose mode cannot be repaired is never opened (AUTH_PERMS, bytes untouched)', { skip: !POSIX && 'POSIX permissions only' }, (t) => {
  const authDir = tempAuth(t);
  const first = openAuthStore({ authDir });
  first.saveCreds({ me: { id: 'x' } });
  first.close();
  const dbPath = join(authDir, STATE_DB);
  chmodSync(dbPath, 0o644);
  const before = readFileSync(dbPath);
  const fsImpl = { chmodSync: (path) => { throw fsError('EPERM', 'chmod', path); } };
  // `now` differs from the first open: an open would rewrite meta.opened_at.
  assert.throws(() => openAuthStore({ authDir, fsImpl, now: () => 1 }), authPerms(/\(the file \S+state\.db has mode 644 and chmod failed: EPERM\)/));
  assert.deepEqual(readFileSync(dbPath), before, 'SQLite never opened it');
  assert.equal(existsSync(`${dbPath}-wal`), false);
  assert.equal(statSync(dbPath).mode & 0o777, 0o644, 'nothing pretended to fix it');
  const again = open(t, authDir);
  assert.equal(statSync(dbPath).mode & 0o777, 0o600);
  assert.equal(again.loadCreds().me.id, 'x');
});

test('permissions: a chmod that does not take (a re-stat still shows 644) is refused (AUTH_PERMS)', { skip: !POSIX && 'POSIX permissions only' }, (t) => {
  const authDir = tempAuth(t);
  const dbPath = join(authDir, STATE_DB);
  const chmods = [];
  const fsImpl = {
    // A filesystem that ignores chmod: the file keeps reporting 0644.
    statSync: (path, ...rest) => (path === dbPath ? lying(statSync(path, ...rest), { perm: 0o644 }) : statSync(path, ...rest)),
    chmodSync: (path, mode) => { chmods.push([path, mode]); chmodSync(path, mode); },
  };
  assert.throws(() => openAuthStore({ authDir, fsImpl }), authPerms(/\(the file \S+state\.db still has mode 644 after chmod\)/));
  assert.deepEqual(chmods.filter(([p]) => p === dbPath), [[dbPath, 0o600]], 'the repair was tried once');
  assert.equal(statSync(dbPath).size, 0, 'SQLite never wrote to it');
  assert.equal(existsSync(`${dbPath}-wal`), false);
});

test('permissions: a -wal that is loose after opening and cannot be repaired closes the store (AUTH_PERMS)', { skip: !POSIX && 'POSIX permissions only' }, (t) => {
  const authDir = tempAuth(t);
  const walPath = join(authDir, `${STATE_DB}-wal`);
  const fsImpl = {
    statSync: (path, ...rest) => (path === walPath ? lying(statSync(path, ...rest), { perm: 0o644 }) : statSync(path, ...rest)),
    chmodSync: (path, mode) => {
      if (path === walPath) throw fsError('EPERM', 'chmod', path);
      chmodSync(path, mode);
    },
  };
  assert.throws(() => openAuthStore({ authDir, fsImpl }), authPerms(/\(the file \S+state\.db-wal has mode 644 and chmod failed: EPERM\)/));
  assert.equal(existsSync(walPath), false, 'the handle was closed (SQLite drops the -wal on close)');
  const again = open(t, authDir);
  assert.equal(again.closed, false, 'not LOCKED: the exclusive lock went with the closed handle');
});

test('permissions: a leftover -wal with a loose mode that cannot be repaired is refused before SQLite opens anything', { skip: !POSIX && 'POSIX permissions only' }, (t) => {
  const authDir = tempAuth(t);
  const first = openAuthStore({ authDir });
  first.saveCreds({ me: { id: 'x' } });
  first.close();
  const dbPath = join(authDir, STATE_DB);
  const walPath = `${dbPath}-wal`;
  writeFileSync(walPath, '');
  chmodSync(walPath, 0o644);
  const before = readFileSync(dbPath);
  const fsImpl = {
    chmodSync: (path, mode) => {
      if (path === walPath) throw fsError('EPERM', 'chmod', path);
      chmodSync(path, mode);
    },
  };
  assert.throws(() => openAuthStore({ authDir, fsImpl, now: () => 1 }), authPerms(/\(the file \S+state\.db-wal has mode 644 and chmod failed: EPERM\)/));
  assert.deepEqual(readFileSync(dbPath), before, 'SQLite never opened state.db');
  assert.equal(statSync(walPath).mode & 0o777, 0o644);
});

test('permissions: leftover -shm files with a loose mode are repaired like the rest (happy path)', { skip: !POSIX && 'POSIX permissions only' }, (t) => {
  const authDir = tempAuth(t);
  const first = openAuthStore({ authDir });
  first.close();
  const shmPath = join(authDir, `${STATE_DB}-shm`);
  writeFileSync(shmPath, '');
  chmodSync(shmPath, 0o644);
  const logs = [];
  const store = open(t, authDir, { log: (m) => logs.push(m) });
  store.saveCreds({ me: { id: 'y' } });
  assert.equal(statSync(shmPath).mode & 0o777, 0o600);
  assert.ok(logs.some((m) => /repaired permissions on the auth file state\.db-shm/.test(m)), logs.join('\n'));
});

test('permissions: a folder or a file owned by another user is refused (AUTH_PERMS); no uid, no owner check', { skip: !POSIX && 'POSIX permissions only' }, (t) => {
  const authDir = tempAuth(t);
  const me = process.getuid();
  assert.throws(() => openAuthStore({ authDir, getuid: () => me + 1 }), authPerms(/\(the folder \S+ belongs to another user\)/));
  assert.deepEqual(readdirSync(authDir), [], 'no credential database was created');

  const dbPath = join(authDir, STATE_DB);
  const fsImpl = { statSync: (path, ...rest) => (path === dbPath ? lying(statSync(path, ...rest), { uid: me + 1 }) : statSync(path, ...rest)) };
  assert.throws(() => openAuthStore({ authDir, fsImpl }), authPerms(/\(the file \S+state\.db belongs to another user\)/));
  assert.equal(statSync(dbPath).size, 0, 'SQLite never opened it');

  const store = open(t, authDir, { getuid: null });
  assert.equal(store.closed, false, 'where no uid is available the mode rules alone apply');
});

test('permissions: Windows has no POSIX modes, so nothing is checked there', (t) => {
  const authDir = tempAuth(t);
  const fsImpl = {
    chmodSync: () => { throw new Error('chmod is never called on Windows'); },
    statSync: () => { throw new Error('modes are never read on Windows'); },
  };
  const store = open(t, authDir, { platform: 'win32', fsImpl, getuid: () => -1 });
  store.saveCreds({ me: { id: 'w' } });
  assert.equal(store.loadCreds().me.id, 'w');
});

test('wipe empties the store in place: no secret bytes left on disk, the lock never released', (t) => {
  const authDir = tempAuth(t);
  const store = open(t, authDir);
  store.saveCreds({ me: { id: 'x' }, noiseKey: { private: Buffer.from('CREDSMARKER-1234567890') } });
  store.keys.set({ session: { a: Buffer.from('KEYSMARKER-0987654321') } });
  store.keys.set({ session: { a: null } });
  store.owner.set({ pn: '15550003333@s.whatsapp.net', lid: null, via: 'claim', boundAt: 3 });
  store.meta.set('mode', 'dedicated');
  store.seen.add('M1', 'chat');
  store.sent.add('S1', 'chat', 'payload');
  store.keys.set({ session: { b: Buffer.from('s') } });
  store.wipe();
  for (const name of readdirSync(authDir)) {
    const bytes = readFileSync(join(authDir, name));
    for (const marker of ['CREDSMARKER', 'KEYSMARKER', 'Q1JFRFNNQVJLRVI', 'S0VZU01BUktFUi']) {
      assert.equal(bytes.includes(Buffer.from(marker)), false, `${name} still holds ${marker}`);
    }
  }
  assert.equal(store.loadCreds(), null);
  assert.deepEqual(store.keyCounts(), {});
  assert.equal(store.owner.get(), null);
  assert.equal(store.meta.get('mode'), null);
  assert.equal(store.seen.has('M1'), false);
  assert.equal(store.sent.has('S1'), false);
  assert.throws(() => openAuthStore({ authDir }), (err) => err.code === 'LOCKED', 'the lock survives a wipe');
  store.saveCreds({ me: { id: 'y' } });
  assert.equal(store.loadCreds().me.id, 'y');
});

test('owner, meta, seen and sent; prune keeps 7 days / 5000 seen and 24 hours / 500 sent', (t) => {
  let now = 10_000_000_000;
  const store = open(t, tempAuth(t), { now: () => now });
  assert.equal(store.owner.get(), null);
  store.owner.set({ pn: '15550003333@s.whatsapp.net', lid: '55443322110099@lid', via: 'claim', boundAt: 77 });
  assert.deepEqual(store.owner.get(), { pn: '15550003333@s.whatsapp.net', lid: '55443322110099@lid', boundAt: 77, via: 'claim' });
  store.owner.clear();
  assert.equal(store.owner.get(), null);
  store.meta.set('wa_version', { version: [2, 3000, 1], fetchedAt: 5 });
  assert.deepEqual(store.meta.get('wa_version'), { version: [2, 3000, 1], fetchedAt: 5 });
  store.meta.delete('wa_version');
  assert.equal(store.meta.get('wa_version'), null);

  store.seen.add('OLD', 'c');
  store.sent.add('OLDSENT', 'c', null);
  now += 8 * 24 * 3600_000;
  for (let i = 0; i < 5010; i++) store.seen.add(`S${i}`, 'c');
  for (let i = 0; i < 510; i++) {
    now += 1;
    store.sent.add(`T${i}`, 'c', `m${i}`);
  }
  store.prune();
  assert.equal(store.seen.has('OLD'), false, 'older than 7 days');
  assert.equal(store.sent.has('OLDSENT'), false, 'older than 24 hours');
  assert.equal(store.sent.has('T0'), false, 'beyond 500 sent rows');
  assert.equal(store.sent.has('T509'), true);
  assert.equal(store.sent.get('T509'), 'm509');
  assert.equal(store.sent.recentIds(3).length, 3);
  let seenRows = 0;
  for (let i = 0; i < 5010; i++) if (store.seen.has(`S${i}`)) seenRows += 1;
  assert.equal(seenRows, 5000, 'seen capped at 5000 rows');
});

test('FALLBACK_CODEC is Baileys BufferJSON wire format', () => {
  const text = JSON.stringify({ a: Buffer.from('hi') }, FALLBACK_CODEC.replacer);
  assert.equal(text, '{"a":{"type":"Buffer","data":"aGk="}}');
  assert.deepEqual(JSON.parse(text, FALLBACK_CODEC.reviver).a, Buffer.from('hi'));
  assert.deepEqual(JSON.parse('{"a":{"0":1,"1":2}}', FALLBACK_CODEC.reviver).a, Buffer.from([1, 2]));
});

test('the auth folder is created where asked and nowhere else', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synabun-wa-auth-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'other'));
  const store = openAuthStore({ authDir: join(root, 'wa', 'auth') });
  store.close();
  assert.deepEqual(readdirSync(root).sort(), ['other', 'wa']);
  assert.ok(existsSync(join(root, 'wa', 'auth', STATE_DB)));
});

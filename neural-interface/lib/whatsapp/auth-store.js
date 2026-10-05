// WhatsApp credential store — child process (host) only.
//
// One SQLite file (authDir/state.db) holds everything the linked device needs:
// creds, every Signal key type Baileys hands us (open-ended: a type it adds
// tomorrow is stored the same way, nothing is whitelisted), the bound owner,
// and the seen/sent message ids that stop echo loops and double processing.
// Baileys' useMultiFileAuthState is not used: it is "not for production" and
// persists a key update as many independent file writes.
//
// Guarantees:
//   - every keys.set(data) and every saveCreds() is one BEGIN…COMMIT (a null
//     value deletes); an error rolls the whole write back and rethrows
//   - locking_mode=EXCLUSIVE + busy_timeout=0: the file lock taken at open is
//     held until close, so a second open (a second SynaBun on the same data)
//     fails at once with code LOCKED — this is the single-instance lock
//   - POSIX: the folder is 0700 and state.db (+ any -wal / -shm / -journal)
//     0600, owned by this user. A looser mode is repaired (and logged) on
//     every open, before SQLite opens the file and again once it is open (the
//     -wal appears then). Whatever cannot be verified or repaired — a failed
//     stat or chmod, a mode that does not take, another owner — refuses the
//     store with code AUTH_PERMS (the handle is closed if it was open): the
//     linked-device keys never open readable by anyone else. Windows has no
//     POSIX modes and is not checked.

import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const STATE_DB = 'state.db';
const DB_SUFFIXES = ['', '-wal', '-shm', '-journal'];
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
/** The node:fs calls this module makes; `fsImpl` overrides any of them (tests). */
const NODE_FS = Object.freeze({ chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync, statSync });
/** Files are created with the effective uid, so that is who must own them. */
const processUid = typeof process.geteuid === 'function' ? () => process.geteuid()
  : typeof process.getuid === 'function' ? () => process.getuid() : null;

const SEEN_MAX_AGE_MS = 7 * 24 * 3600_000;
const SEEN_MAX_ROWS = 5000;
const SENT_MAX_AGE_MS = 24 * 3600_000;
const SENT_MAX_ROWS = 500;

/** Same wire format as Baileys' BufferJSON; the adapter passes the runtime's own. */
export const FALLBACK_CODEC = Object.freeze({
  replacer(_key, value) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
      return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') };
    }
    return value;
  },
  reviver(_key, value) {
    if (typeof value === 'object' && value !== null && value.type === 'Buffer' && typeof value.data === 'string') {
      return Buffer.from(value.data, 'base64');
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length > 0 && keys.every((k) => !Number.isNaN(parseInt(k, 10)))) {
        const values = Object.values(value);
        if (values.every((v) => typeof v === 'number')) return Buffer.from(values);
      }
    }
    return value;
  },
});

function storeError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

function isLockError(err) {
  const n = err?.errcode;
  return n === 5 || n === 6 || /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(String(err?.message || ''));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS creds (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS keys (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (type, id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), pn TEXT, lid TEXT, bound_at INTEGER NOT NULL, via TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seen (msg_id TEXT PRIMARY KEY, chat TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS seen_at ON seen (at);
CREATE TABLE IF NOT EXISTS sent (msg_id TEXT PRIMARY KEY, chat TEXT NOT NULL, message TEXT, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sent_at ON sent (at);
`;

/**
 * @param {{authDir:string, codec?:{replacer:Function, reviver:Function},
 *   reviveKey?:(type:string, value:any)=>any, platform?:string, now?:()=>number,
 *   log?:(msg:string, level?:string)=>void, fsImpl?:object, getuid?:(()=>number)|null}} opts
 *   fsImpl overrides any of the node:fs calls made here (tests); getuid is the
 *   uid that must own the folder and files (default: this process's effective
 *   uid; null skips the owner check).
 * @throws code LOCKED (another process holds the store) or AUTH_PERMS (POSIX:
 *   the folder / files cannot be verified or made private)
 */
export function openAuthStore({
  authDir, codec = FALLBACK_CODEC, reviveKey = null, platform = process.platform, now = Date.now, log = () => {},
  fsImpl = null, getuid = processUid,
} = {}) {
  if (typeof authDir !== 'string' || !authDir) throw new TypeError('openAuthStore: authDir is required');
  const posix = platform !== 'win32';
  const dbPath = join(authDir, STATE_DB);
  const fs = fsImpl ? { ...NODE_FS, ...fsImpl } : NODE_FS;
  const say = (msg, level = 'warn') => { try { log(msg, level); } catch {} };

  /** A path, a mode, an errno code: nothing secret goes into this message. */
  function permsError(what, problem, cause) {
    return storeError(
      'AUTH_PERMS',
      `SynaBun could not make the WhatsApp session files private (the ${what} ${problem}); `
        + 'fix the folder permissions (yours only: 700 for the folder, 600 for its files), then reconnect',
      cause,
    );
  }

  /**
   * POSIX: `path` must belong to this user and have exactly `want`; a looser
   * mode is chmod-ed and logged. AUTH_PERMS when that cannot be verified or
   * repaired: the stat fails (a missing optional file is fine), another user
   * owns it, chmod throws, or a re-stat still shows group / other bits (a
   * filesystem that ignores chmod).
   */
  function securePath(path, want, label, { optional = false } = {}) {
    if (!posix) return;
    const what = `${want === PRIVATE_DIR ? 'folder' : 'file'} ${path}`;
    const vanished = (err) => optional && err?.code === 'ENOENT';
    let before;
    try { before = fs.statSync(path); } catch (err) {
      if (vanished(err)) return;
      throw permsError(what, `cannot be checked: ${err?.code || 'error'}`, err);
    }
    const uid = typeof getuid === 'function' ? getuid() : null;
    if (Number.isInteger(uid) && Number.isInteger(before.uid) && before.uid !== uid) throw permsError(what, 'belongs to another user');
    const mode = before.mode & 0o777;
    if (mode === want) return;
    try { fs.chmodSync(path, want); } catch (err) {
      if (vanished(err)) return;
      throw permsError(what, `has mode ${mode.toString(8)} and chmod failed: ${err?.code || 'error'}`, err);
    }
    let after;
    try { after = fs.statSync(path); } catch (err) {
      if (vanished(err)) return;
      throw permsError(what, `cannot be checked after chmod: ${err?.code || 'error'}`, err);
    }
    const fixed = after.mode & 0o777;
    if (fixed & 0o077) throw permsError(what, `still has mode ${fixed.toString(8)} after chmod`);
    say(`[whatsapp] repaired permissions on the ${label} (${mode.toString(8)} → ${fixed.toString(8)})`);
  }

  function secureFolder() {
    securePath(authDir, PRIVATE_DIR, 'auth folder');
  }

  /** state.db (must exist) and whichever of -wal / -shm / -journal exist. */
  function secureFiles() {
    for (const suffix of DB_SUFFIXES) {
      securePath(dbPath + suffix, PRIVATE_FILE, `auth file ${STATE_DB}${suffix}`, { optional: suffix !== '' });
    }
  }

  let db = null;
  let st = null; // prepared statements

  function openDb() {
    fs.mkdirSync(authDir, { recursive: true, mode: PRIVATE_DIR });
    secureFolder();
    if (!fs.existsSync(dbPath)) {
      // Create it 0600 before SQLite does, so the file is never world-readable.
      try { fs.closeSync(fs.openSync(dbPath, 'a', PRIVATE_FILE)); } catch (err) {
        if (posix) throw permsError(`file ${dbPath}`, `cannot be created: ${err?.code || 'error'}`, err);
      }
    }
    secureFiles();
    let handle;
    try {
      handle = new DatabaseSync(dbPath);
    } catch (err) {
      throw isLockError(err) ? storeError('LOCKED', 'the WhatsApp session is in use by another SynaBun process', err) : err;
    }
    try {
      handle.exec('PRAGMA busy_timeout=0');
      // EXCLUSIVE before WAL: the WAL index then lives in heap memory (no -shm)
      // and the lock taken by the first write below is never released.
      handle.exec('PRAGMA locking_mode=EXCLUSIVE');
      handle.exec('PRAGMA journal_mode=WAL');
      handle.exec('PRAGMA synchronous=FULL');
      handle.exec('PRAGMA secure_delete=ON'); // deleted keys are zeroed on disk, not left in free pages
      handle.exec(SCHEMA);
      handle.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('opened_at', JSON.stringify(now()));
    } catch (err) {
      try { handle.close(); } catch {}
      throw isLockError(err) ? storeError('LOCKED', 'the WhatsApp session is in use by another SynaBun process', err) : err;
    }
    // Again with the database open: the -wal exists now (EXCLUSIVE keeps -shm out of it).
    try {
      secureFolder();
      secureFiles();
    } catch (err) {
      try { handle.close(); } catch {}
      throw err;
    }
    db = handle;
    st = {
      metaGet: db.prepare('SELECT value FROM meta WHERE key = ?'),
      metaSet: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
      metaDel: db.prepare('DELETE FROM meta WHERE key = ?'),
      credsGet: db.prepare('SELECT json FROM creds WHERE id = 1'),
      credsSet: db.prepare('INSERT OR REPLACE INTO creds (id, json, updated_at) VALUES (1, ?, ?)'),
      keyGet: db.prepare('SELECT value FROM keys WHERE type = ? AND id = ?'),
      keySet: db.prepare('INSERT OR REPLACE INTO keys (type, id, value, updated_at) VALUES (?, ?, ?, ?)'),
      keyDel: db.prepare('DELETE FROM keys WHERE type = ? AND id = ?'),
      keyClear: db.prepare('DELETE FROM keys'),
      keyCount: db.prepare('SELECT type, COUNT(*) AS n FROM keys GROUP BY type'),
      ownerGet: db.prepare('SELECT pn, lid, bound_at, via FROM owner WHERE id = 1'),
      ownerSet: db.prepare('INSERT OR REPLACE INTO owner (id, pn, lid, bound_at, via) VALUES (1, ?, ?, ?, ?)'),
      ownerDel: db.prepare('DELETE FROM owner'),
      seenHas: db.prepare('SELECT 1 FROM seen WHERE msg_id = ?'),
      seenAdd: db.prepare('INSERT OR IGNORE INTO seen (msg_id, chat, at) VALUES (?, ?, ?)'),
      seenPruneAge: db.prepare('DELETE FROM seen WHERE at < ?'),
      seenPruneRows: db.prepare(`DELETE FROM seen WHERE msg_id NOT IN (SELECT msg_id FROM seen ORDER BY at DESC LIMIT ${SEEN_MAX_ROWS})`),
      sentHas: db.prepare('SELECT 1 FROM sent WHERE msg_id = ?'),
      sentGet: db.prepare('SELECT message FROM sent WHERE msg_id = ?'),
      sentAdd: db.prepare('INSERT OR REPLACE INTO sent (msg_id, chat, message, at) VALUES (?, ?, ?, ?)'),
      sentIds: db.prepare('SELECT msg_id FROM sent ORDER BY at DESC LIMIT ?'),
      sentPruneAge: db.prepare('DELETE FROM sent WHERE at < ?'),
      sentPruneRows: db.prepare(`DELETE FROM sent WHERE msg_id NOT IN (SELECT msg_id FROM sent ORDER BY at DESC LIMIT ${SENT_MAX_ROWS})`),
    };
  }

  function live() {
    if (!db) throw storeError('CLOSED', 'the WhatsApp auth store is closed');
    return st;
  }

  /** Run fn inside one BEGIN…COMMIT; ROLLBACK and rethrow on any error. */
  function tx(fn) {
    live();
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  const encode = (value) => JSON.stringify(value, codec.replacer);
  const decode = (text) => JSON.parse(text, codec.reviver);

  openDb();

  const keys = {
    get(type, ids) {
      const s = live();
      const out = {};
      for (const id of ids || []) {
        const row = s.keyGet.get(String(type), String(id));
        if (!row) continue;
        let value = decode(row.value);
        if (reviveKey) value = reviveKey(type, value);
        out[id] = value;
      }
      return out;
    },
    set(data) {
      const s = live();
      const at = now();
      tx(() => {
        for (const type of Object.keys(data || {})) {
          const entries = data[type] || {};
          for (const id of Object.keys(entries)) {
            const value = entries[id];
            if (value === null || value === undefined) s.keyDel.run(String(type), String(id));
            else s.keySet.run(String(type), String(id), encode(value), at);
          }
        }
      });
    },
    clear() {
      const s = live();
      tx(() => s.keyClear.run());
    },
  };

  return {
    path: dbPath,
    keys,
    loadCreds() {
      const row = live().credsGet.get();
      return row ? decode(row.json) : null;
    },
    saveCreds(creds) {
      const s = live();
      const json = encode(creds);
      tx(() => s.credsSet.run(json, now()));
    },
    keyCounts() {
      const out = {};
      for (const row of live().keyCount.all()) out[row.type] = Number(row.n);
      return out;
    },
    meta: {
      get(key) {
        const row = live().metaGet.get(String(key));
        if (!row) return null;
        try { return JSON.parse(row.value); } catch { return null; }
      },
      set(key, value) {
        const s = live();
        tx(() => s.metaSet.run(String(key), JSON.stringify(value)));
      },
      delete(key) {
        const s = live();
        tx(() => s.metaDel.run(String(key)));
      },
    },
    owner: {
      get() {
        const row = live().ownerGet.get();
        return row ? { pn: row.pn ?? null, lid: row.lid ?? null, boundAt: Number(row.bound_at), via: row.via } : null;
      },
      set({ pn = null, lid = null, via = 'claim', boundAt = now() } = {}) {
        const s = live();
        tx(() => s.ownerSet.run(pn, lid, boundAt, via));
      },
      clear() {
        const s = live();
        tx(() => s.ownerDel.run());
      },
    },
    seen: {
      has(id) { return !!live().seenHas.get(String(id)); },
      add(id, chat) { live().seenAdd.run(String(id), String(chat || ''), now()); },
    },
    sent: {
      has(id) { return !!live().sentHas.get(String(id)); },
      get(id) { return live().sentGet.get(String(id))?.message ?? null; },
      add(id, chat, message = null) { live().sentAdd.run(String(id), String(chat || ''), message, now()); },
      recentIds(limit = SENT_MAX_ROWS) { return live().sentIds.all(limit).map((r) => r.msg_id); },
    },
    /** seen: 7 days / 5000 rows; sent: 24 hours / 500 rows. */
    prune() {
      const s = live();
      const at = now();
      tx(() => {
        s.seenPruneAge.run(at - SEEN_MAX_AGE_MS);
        s.seenPruneRows.run();
        s.sentPruneAge.run(at - SENT_MAX_AGE_MS);
        s.sentPruneRows.run();
      });
    },
    /**
     * Forget the linked device in place: every row deleted (zeroed on disk by
     * secure_delete), the file compacted and the WAL truncated — without ever
     * releasing the exclusive lock, so no other process can slip in.
     */
    wipe() {
      if (!db) {
        for (const suffix of DB_SUFFIXES) {
          try { fs.rmSync(dbPath + suffix, { force: true }); } catch {}
        }
        openDb();
        return;
      }
      tx(() => db.exec('DELETE FROM creds; DELETE FROM keys; DELETE FROM owner; DELETE FROM seen; DELETE FROM sent; DELETE FROM meta;'));
      try { db.exec('VACUUM'); } catch (err) { say(`[whatsapp] vacuum after wipe failed: ${err?.message}`); }
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    },
    get closed() { return !db; },
    close() {
      if (!db) return;
      try { db.close(); } catch {}
      db = null;
      st = null;
    },
  };
}

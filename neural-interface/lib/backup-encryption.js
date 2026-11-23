// ═══════════════════════════════════════════
// BACKUP ENCRYPTION — the owner's key and the password routes
// ═══════════════════════════════════════════
//
// Settings → Memory & backups → Backups → Password protection (docs/backup-encryption.md). Off until the owner sets
// a password. While it is on, every backup SynaBun makes (on request, on schedule, before an update) is written
// encrypted, or not at all: backup-service.js asks backupRecipientFor(dataHome) itself, so no caller can forget to.
//
// What is kept: DATA_HOME/data/backup-encryption.json, mode 0600, { version, recipient, createdAt, changedAt }. The
// recipient is a public key, the private key wrapped by the password, and the authentication key that proves a backup
// was made here (backup-crypto.js); the password and the unwrapped private key are never written anywhere. A scheduled
// backup needs the public and authentication keys only. The file is in no backup and no restore writes it
// (backup-groups.js isBackupEncryptionFile): a restored backup must not bring back an older password.
//
//   backupRecipientFor(dataHome)                 null when encryption is off; the recipient when it is on; a
//                                                BackupEncryptionError when the file is there and cannot be used
//                                                (the backup then fails: it never falls back to plaintext)
//   createPasswordAttemptLimiter()               wrong passwords cost time, more each time
//   createBackupEncryptionService({ dataHome })  status, enable, change (the same keys under a new password),
//                                                disable, adopt
//   backupEncryptionHandlers(service)            the four routes server.js registers
//
// No function here logs, returns or throws a password, and no error message is built from one.

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { authKeyOf, BackupEncryptionError, createRecipient, normalizePassword, readRecipient, rewrapRecipient, unlockRecipient, MIN_PASSWORD_LENGTH } from './backup-crypto.js';
import { BACKUP_ENCRYPTION_FILE } from './backup-groups.js';

export const BACKUP_ENCRYPTION_VERSION = 1;
/**
 * What this server's backup encryption can do, said in every status answer and in the answer that keeps an encrypted
 * upload. The page works with a server only while `auth-key` is listed: `public/` is read from disk at any time and
 * `lib/` only at a start, so a page can meet a server from before the authentication key, whose backups anybody
 * holding one could forge and whose key file this code cannot use. Such a server answers without the list.
 */
export const BACKUP_ENCRYPTION_CAPABILITIES = Object.freeze(['auth-key']);

export function backupEncryptionPath(dataHome) {
  return resolve(dataHome, 'data', BACKUP_ENCRYPTION_FILE);
}

/**
 * The key file of `dataHome`: null when there is none (encryption is off), else { recipient, keyId, createdAt,
 * changedAt }. A file that is there and cannot be read as one is an error, never "off": BACKUP_ENC_KEY_UNREADABLE.
 */
export function readBackupEncryption(dataHome) {
  const path = backupEncryptionPath(dataHome);
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new BackupEncryptionError('BACKUP_ENC_KEY_UNREADABLE', `Backup encryption is on, but its key file cannot be read (${error?.code || 'error'}): ${path}`, { status: 500 });
  }
  try {
    const stored = JSON.parse(text);
    if (!stored || typeof stored !== 'object' || stored.version !== BACKUP_ENCRYPTION_VERSION) throw new Error('unknown version');
    const read = readRecipient(stored.recipient);
    authKeyOf(stored.recipient).fill(0);
    // A file another program made readable to others is made private again; a failure to do so changes nothing here.
    try { if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600); } catch { /* read-only volume */ }
    return {
      recipient: stored.recipient,
      keyId: read.keyId,
      createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : null,
      changedAt: typeof stored.changedAt === 'string' ? stored.changedAt : null,
    };
  } catch {
    throw new BackupEncryptionError('BACKUP_ENC_KEY_UNREADABLE', `Backup encryption is on, but its key file is damaged: ${path}. No backup is made until it is repaired or encryption is set up again.`, { status: 500 });
  }
}

/** Who a new backup of `dataHome` is encrypted for: null (encryption is off) or the recipient. Throws as readBackupEncryption. */
export function backupRecipientFor(dataHome) {
  return readBackupEncryption(dataHome)?.recipient ?? null;
}

function writeKeyFile(dataHome, value) {
  const path = backupEncryptionPath(dataHome);
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true });
  // What a crash left of an earlier write: it holds the wrapped keys and must neither stay nor block this one.
  const prefix = `${basename(path)}.`;
  for (const name of readdirSync(folder)) {
    if (name.startsWith(prefix) && name.endsWith('.tmp')) rmSync(resolve(folder, name), { force: true });
  }
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try {
      const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      let at = 0;
      while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (process.platform !== 'win32') chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Wrong passwords cost time. The first `free` in a row are answered at once; each one after that locks every
 * password route for `baseMs`, doubling, up to `maxMs`. A right password clears it. One limiter for the whole
 * server: the settings routes and the restore's unlock share it, so there is one budget of guesses, not one per route.
 *
 * `attempt(operation)` is how a password is tried: one at a time (each costs up to scrypt's memory, and guesses sent
 * together must not all pass the check before the first has failed), at most `maxQueued` waiting. `clears: false` is
 * for a password that opened a file this installation has no reason to trust: anybody can make a file with a password
 * they know, and opening it must not wipe the count of wrong guesses at the owner's own key.
 */
export function createPasswordAttemptLimiter({ free = 5, baseMs = 30_000, maxMs = 15 * 60_000, maxQueued = 8, now = () => Date.now() } = {}) {
  let failures = 0;
  let lockedUntil = 0;
  let queued = 0;
  let tail = Promise.resolve();
  const refuse = (seconds) => Object.assign(new BackupEncryptionError('TOO_MANY_ATTEMPTS', `Too many wrong passwords. Try again in ${seconds >= 120 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`}.`, { status: 429 }), { retryAfterSeconds: seconds });
  /** Throws TOO_MANY_ATTEMPTS (429, `retryAfterSeconds`) while locked. */
  const check = () => {
    const wait = lockedUntil - now();
    if (wait > 0) throw refuse(Math.ceil(wait / 1000));
  };
  const fail = () => {
    failures += 1;
    if (failures >= free) lockedUntil = now() + Math.min(maxMs, baseMs * 2 ** Math.min(20, failures - free));
  };
  const succeed = () => { failures = 0; lockedUntil = 0; };
  return {
    check,
    fail,
    succeed,
    state: () => ({ failures, lockedUntil }),
    attempt(operation, { clears = true } = {}) {
      if (queued >= maxQueued) return Promise.reject(refuse(5));
      queued += 1;
      const run = tail.then(async () => {
        check();
        try {
          const result = await operation();
          if (clears) succeed();
          return result;
        } catch (error) {
          if (error?.code === 'WRONG_PASSWORD') fail();
          throw error;
        }
      }).finally(() => { queued -= 1; });
      tail = run.then(() => {}, () => {});
      return run;
    },
  };
}

/**
 * The owner's backup encryption for one data home.
 *
 * @param {object} o
 * @param {string} o.dataHome
 * @param {ReturnType<typeof createPasswordAttemptLimiter>} [o.limiter]
 * @param {{ N: number, r: number, p: number }} [o.kdf]   scrypt for a new key (tests lower it)
 * @param {() => Date} [o.now]
 * @param {(line: string) => void} [o.log]   what happened, never what was typed
 */
export function createBackupEncryptionService({ dataHome, limiter = createPasswordAttemptLimiter(), kdf = undefined, now = () => new Date(), log = () => {} } = {}) {
  if (!dataHome) throw new Error('dataHome is required');
  // One password operation at a time: each derives a key with scrypt (128 MiB while it runs).
  let tail = Promise.resolve();
  const oneAtATime = (operation) => {
    const run = tail.then(operation, operation);
    tail = run.catch(() => {});
    return run;
  };

  // What is wrong with a key file that cannot be used, and which file it is, belongs in the log: Settings says it
  // in the owner's language from `code` and shows neither the sentence nor the path. Written once per sentence, not
  // at every look of an open Settings; `error` stays in the answer for a page from before and for a command line.
  let stoppedLogged = null;
  function status() {
    let stored;
    const base = { ok: true, capabilities: [...BACKUP_ENCRYPTION_CAPABILITIES], minPasswordLength: MIN_PASSWORD_LENGTH };
    try { stored = readBackupEncryption(dataHome); }
    catch (error) {
      if (stoppedLogged !== error.message) {
        stoppedLogged = error.message;
        try { log(`[backup] Backups are stopped (${error.code || 'error'}): ${error.message}`); } catch { /* a log that fails changes no answer */ }
      }
      return { ...base, enabled: true, usable: false, error: error.message, code: error.code };
    }
    stoppedLogged = null;
    if (!stored) return { ...base, enabled: false, usable: true };
    return { ...base, enabled: true, usable: true, keyId: stored.keyId, createdAt: stored.createdAt, changedAt: stored.changedAt };
  }

  /** Resolves when `password` opens the stored key; else the limiter's or the password's refusal. Keeps no key. */
  async function checkStoredPassword(password) {
    limiter.check();
    const stored = readBackupEncryption(dataHome);
    if (!stored) throw new BackupEncryptionError('NOT_ENABLED', 'Backup encryption is not on.', { status: 409 });
    normalizePassword(password).fill(0);
    try {
      const { privateKey, authKey } = await limiter.attempt(() => unlockRecipient(stored.recipient, password));
      privateKey.fill(0);
      authKey.fill(0);
    } catch (error) {
      if (error?.code === 'WRONG_PASSWORD') throw new BackupEncryptionError('WRONG_PASSWORD', 'That is not the current backup password.', { status: 401 });
      throw error;
    }
  }

  async function store(password, createdAt = null) {
    const recipient = await createRecipient(password, kdf ? { kdf } : {});
    const stamp = now().toISOString();
    writeKeyFile(dataHome, { version: BACKUP_ENCRYPTION_VERSION, recipient, createdAt: createdAt || stamp, changedAt: stamp });
    return recipient;
  }

  return {
    status,
    limiter,
    /**
     * Turn encryption on with a new key pair. ALREADY_ENABLED (409) when it is on: changing the password is `change`.
     * A key file that cannot be used is replaced: it stops every backup and no password can open it, and nothing is
     * lost with it, because each backup's header carries its own wrapped keys. The result is encrypted either way.
     */
    enable: (password) => oneAtATime(async () => {
      if (existsSync(backupEncryptionPath(dataHome))) {
        let usable = true;
        try { readBackupEncryption(dataHome); } catch { usable = false; }
        if (usable) throw new BackupEncryptionError('ALREADY_ENABLED', 'Backup encryption is already on. Change the password instead.', { status: 409 });
      }
      const recipient = await store(password);
      log(`[backup] Backup encryption turned on (key ${recipient.keyId})`);
      return status();
    }),
    /**
     * A new password: the same key pair and the same authentication key, wrapped again (backup-crypto.js
     * rewrapRecipient). The keys do not change, so nothing made before is cut off: older backups keep opening with
     * the password of their day, and the record beside an encrypted upgrade snapshot still compares. Whoever knows
     * an old password and holds a backup made under it holds these keys too; new keys are made by turning
     * encryption off and on again.
     */
    change: (currentPassword, newPassword) => oneAtATime(async () => {
      normalizePassword(newPassword, { forNew: true }).fill(0);
      limiter.check();
      const before = readBackupEncryption(dataHome);
      if (!before) throw new BackupEncryptionError('NOT_ENABLED', 'Backup encryption is not on.', { status: 409 });
      normalizePassword(currentPassword).fill(0);
      let recipient;
      try { recipient = await limiter.attempt(() => rewrapRecipient(before.recipient, currentPassword, newPassword, kdf ? { kdf } : {})); }
      catch (error) {
        if (error?.code === 'WRONG_PASSWORD') throw new BackupEncryptionError('WRONG_PASSWORD', 'That is not the current backup password.', { status: 401 });
        throw error;
      }
      const stamp = now().toISOString();
      writeKeyFile(dataHome, { version: BACKUP_ENCRYPTION_VERSION, recipient, createdAt: before.createdAt || stamp, changedAt: stamp });
      log(`[backup] Backup password changed (key ${before.keyId}, kept)`);
      return status();
    }),
    /** Turn encryption off: later backups are plain. Earlier ones stay encrypted. */
    disable: (currentPassword) => oneAtATime(async () => {
      await checkStoredPassword(currentPassword);
      rmSync(backupEncryptionPath(dataHome), { force: true });
      log('[backup] Backup encryption turned off');
      return status();
    }),
    /**
     * After a restore of an encrypted backup on an installation that has no key: keep that backup's recipient, so
     * the backups this installation goes on to make are encrypted as the restored ones were (same password). An
     * installation that has a key keeps its own. `recipient` comes from a backup the password opened, with its
     * authentication key (source.recipientForAdoption()). Returns true when the recipient was taken.
     */
    adopt(recipient) {
      if (existsSync(backupEncryptionPath(dataHome))) return false;
      const read = readRecipient(recipient);
      authKeyOf(recipient).fill(0);
      const stamp = now().toISOString();
      writeKeyFile(dataHome, { version: BACKUP_ENCRYPTION_VERSION, recipient, createdAt: stamp, changedAt: stamp });
      log(`[backup] Backup encryption kept from the restored backup (key ${read.keyId})`);
      return true;
    },
  };
}

/**
 * The route handlers. GET status; POST enable { password, acknowledged: true }; POST change { currentPassword,
 * newPassword }; POST disable { currentPassword }. A password travels in a JSON body only, is used, and is gone:
 * no answer and no log line holds one.
 * @param {ReturnType<typeof createBackupEncryptionService>} service
 */
export function backupEncryptionHandlers(service) {
  const refuse = (res, error) => {
    const known = error instanceof BackupEncryptionError;
    const status = known ? error.status : 500;
    if (error?.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
    // An unexpected failure is answered by its code alone: its message could quote a path or an argument.
    return res.status(status).json({ ok: false, code: known ? error.code : 'ENCRYPTION_FAILED', error: known ? error.message : 'Backup encryption could not be changed.', ...(error?.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) });
  };
  const text = (value) => (typeof value === 'string' ? value : '');
  return {
    status(req, res) {
      try { res.json(service.status()); } catch (error) { refuse(res, error); }
    },
    async enable(req, res) {
      try {
        if (req.body?.acknowledged !== true) throw new BackupEncryptionError('ACKNOWLEDGE_REQUIRED', 'Confirm that a lost password cannot be recovered.');
        res.json(await service.enable(text(req.body?.password)));
      } catch (error) { refuse(res, error); }
    },
    async change(req, res) {
      try { res.json(await service.change(text(req.body?.currentPassword), text(req.body?.newPassword))); } catch (error) { refuse(res, error); }
    },
    async disable(req, res) {
      try { res.json(await service.disable(text(req.body?.currentPassword))); } catch (error) { refuse(res, error); }
    },
  };
}

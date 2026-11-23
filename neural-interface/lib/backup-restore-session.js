// ═══════════════════════════════════════════
// RESTORE — an encrypted backup, in three steps
// ═══════════════════════════════════════════
//
// A plain backup is uploaded with the request that restores it. An encrypted one cannot be: its password must not
// ride in a URL or a header, and typing it wrong must not cost another 10 GB upload. So the page uploads the file
// once (POST /api/system/restore/preview, which keeps it here instead of deleting it), then sends the password in a
// JSON body (unlock), reads what the backup holds, and asks for the restore (apply) or lets go (discard).
//
//   createRestoreSessions({ stagingDir, limiter })    the one staged upload and, once unlocked, its file key
//   encryptedRestoreHandlers({ sessions, preview, apply })   the three routes' handlers
//
// What is kept: the uploaded file, still encrypted, in the restore staging folder; after a right password, copies of
// that file's keys in memory. Never the password, never a plaintext copy of the archive: the ZIP inside is read
// through the decrypting reader (backup-crypto-io.js). One upload at a time; it is dropped when another arrives, when
// it is applied or discarded, after `ttlMs`, and at the next start of the server (the staging folder is emptied).
// A wrong password changes nothing and counts against the shared limiter (backup-encryption.js).

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { BackupEncryptionError, readBackupHeaderFile } from './backup-crypto.js';
import { BACKUP_ENCRYPTION_CAPABILITIES } from './backup-encryption.js';
import { openEncryptedBackupSource } from './backup-crypto-io.js';
import { openZipArchive } from './backup-zip-reader.js';

const gone = () => new BackupEncryptionError('RESTORE_UPLOAD_GONE', 'That backup is no longer waiting here. Choose the file again.', { status: 410 });

/**
 * @param {object} [o]
 * @param {{ check: () => void, fail: () => void, succeed: () => void }} o.limiter   the password routes' shared limiter
 * @param {number} [o.ttlMs]   how long an upload waits for its password or its restore (30 minutes)
 * @param {() => string|null} [o.currentKeyId]   this installation's key id. A right password clears the count of wrong
 *        ones only for that key (or where there is none): anybody can craft a file with a password they know.
 */
export function createRestoreSessions({ limiter, ttlMs = 30 * 60_000, currentKeyId = () => null, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!limiter) throw new Error('limiter is required');
  let current = null;

  function drop() {
    const session = current;
    current = null;
    if (!session) return;
    clearTimer(session.timer);
    wipeKeys(session);
    try { rmSync(session.path, { force: true }); } catch { /* the start-up sweep removes it */ }
  }

  function wipeKeys(session) {
    session.keys?.fileKey.fill(0);
    session.keys?.authKey.fill(0);
    session.keys = null;
  }

  function arm(session) {
    clearTimer(session.timer);
    session.expiresAt = now() + ttlMs;
    session.timer = setTimer(() => { if (current === session) drop(); }, ttlMs);
    session.timer?.unref?.();
  }

  const find = (id) => {
    if (!current || typeof id !== 'string' || id !== current.id) throw gone();
    return current;
  };

  return {
    /** Keep an uploaded encrypted backup (system-restore.js saveRestoreUpload's { path, sizeBytes }). Returns what the page is told. */
    async keep(upload) {
      // What the header says without a key: which key pair. A file that is not a readable encrypted backup is
      // refused here, and removed by the caller. The header's date is not told yet: until the password opened the
      // file nothing has checked it (the unlock's answer carries it, authenticated).
      const header = await readBackupHeaderFile(upload.path);
      drop();
      const session = { id: randomUUID(), path: upload.path, sizeBytes: upload.sizeBytes, keyId: header.recipient.keyId, keys: null, busy: false, timer: null, expiresAt: 0 };
      current = session;
      arm(session);
      return {
        uploadId: session.id,
        sizeBytes: upload.sizeBytes,
        keyId: header.recipient.keyId,
        capabilities: [...BACKUP_ENCRYPTION_CAPABILITIES],
        expiresInSeconds: Math.round(ttlMs / 1000),
      };
    },
    /**
     * Open the staged backup with `password`. Resolves the archive (backup-zip-reader.js), to be closed by the
     * caller. WRONG_PASSWORD (401) leaves the upload waiting for another try; TOO_MANY_ATTEMPTS (429) while locked.
     */
    async unlock(id, password) {
      const session = find(id);
      if (session.busy) throw new BackupEncryptionError('RESTORE_RUNNING', 'This backup is already being restored.', { status: 409 });
      limiter.check();
      const own = currentKeyId();
      const source = await limiter.attempt(() => openEncryptedBackupSource(session.path, { password }), { clears: !own || own === session.keyId });
      if (current !== session || session.busy) {
        await source.close();
        if (current !== session) throw gone();
        throw new BackupEncryptionError('RESTORE_RUNNING', 'This backup is already being restored.', { status: 409 });
      }
      wipeKeys(session);
      session.keys = source.copyKeys();
      arm(session);
      return openZipArchive(session.path, { source });
    },
    /** The unlocked backup, for the restore itself. RESTORE_LOCKED (401) before a right password. One restore at a time. */
    async open(id) {
      const session = find(id);
      if (!session.keys) throw new BackupEncryptionError('RESTORE_LOCKED', 'Enter the backup password first.', { status: 401 });
      if (session.busy) throw new BackupEncryptionError('RESTORE_RUNNING', 'This backup is already being restored.', { status: 409 });
      session.busy = true;
      clearTimer(session.timer);
      try { return await openZipArchive(session.path, { source: await openEncryptedBackupSource(session.path, { fileKey: session.keys.fileKey, authKey: session.keys.authKey }) }); }
      catch (error) { session.busy = false; arm(session); throw error; }
    },
    /** Forget the staged backup: its file is removed and its key zeroed. True when there was one of that id. */
    discard(id) {
      if (!current || id !== current.id) return false;
      drop();
      return true;
    },
    /** For shutdown and tests. */
    clear: drop,
    waiting: () => (current ? { uploadId: current.id, unlocked: !!current.keys, expiresAt: current.expiresAt } : null),
  };
}

/**
 * The handlers of POST /api/system/restore/unlock { uploadId, password }, /apply-staged { uploadId, mode } and
 * /discard { uploadId }. `preview(zip)` builds what the page shows before it asks (the same answer a plain backup's
 * preview gives); `apply(zip, mode, res)` is the restore itself and answers the request. A failure is answered by
 * its code and a sentence of this module's own; the password is read from the body and never repeated.
 */
export function encryptedRestoreHandlers({ sessions, preview, apply }) {
  const refuse = (res, error) => {
    const known = error instanceof BackupEncryptionError;
    if (error?.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
    return res.status(known ? error.status : 400).json({
      ok: false,
      code: known ? error.code : 'INVALID_BACKUP',
      error: known ? error.message : String(error?.message || error),
      ...(error?.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      // The restore had begun writing (applyRestoreArchive): the page must not say that nothing was changed.
      ...(res.locals?.restoreWriting ? { partial: true } : {}),
    });
  };
  const text = (value) => (typeof value === 'string' ? value : '');
  return {
    async unlock(req, res) {
      let zip = null;
      try {
        zip = await sessions.unlock(text(req.body?.uploadId), text(req.body?.password));
        // `created`: when this file was written, from its header. The header's MAC held under the password's keys
        // before anything was read, so this is the date the installation that made the backup wrote. It is what
        // tells an older backup of the owner's from the latest one: both are genuine and both open.
        res.json({ ...(await preview(zip)), encrypted: true, created: zip.source?.created || null, uploadId: text(req.body?.uploadId) });
      } catch (error) { if (!res.headersSent) refuse(res, error); }
      finally { await zip?.close().catch(() => {}); }
    },
    async apply(req, res) {
      const id = text(req.body?.uploadId);
      let zip = null;
      try {
        zip = await sessions.open(id);
        await apply(zip, text(req.body?.mode) || 'full', res);
      } catch (error) { if (!res.headersSent) refuse(res, error); }
      finally {
        await zip?.close().catch(() => {});
        // Applied or failed part-way: the upload does not wait for a second try (the page uploads again).
        if (zip) sessions.discard(id);
      }
    },
    discard(req, res) {
      res.json({ ok: true, discarded: sessions.discard(text(req.body?.uploadId)) });
    },
  };
}

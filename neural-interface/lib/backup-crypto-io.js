// ═══════════════════════════════════════════
// BACKUP ENCRYPTION — writing and reading the files
// ═══════════════════════════════════════════
//
// backup-crypto.js is the format; this is the I/O around it. Both directions stream: nothing here holds more than a
// few chunks, whatever the backup's size, and the AES work runs on a thread of its own (backup-crypto-worker.js), so
// a 10 GB backup never holds the server's thread.
//
//   createEncryptedBackupWriter(path, recipient)   the file being written: write(bytes), finish(), abort(), stream()
//   openEncryptedBackupSource(path, { fileKey + authKey | password })
//                                                  the plaintext of a finished file by position: read(position,
//                                                  length), stream(start, end), authenticateRest(); what
//                                                  backup-zip-reader.js reads a ZIP through
//   openPlainBackupSource(path)                    the same interface over a file that is not encrypted
//
// Backpressure: the writer lets a few blocks be on their way to the thread and makes its caller wait for the rest;
// the reader hands out a chunk only when it is asked for one. Cancel: abort() / close() stop the thread at once.

import { open, stat } from 'node:fs/promises';
import { closeSync, createReadStream, openSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import {
  BackupEncryptionError, chunkLayout, createBackupHeader, openBackupSession, readBackupHeaderFile, unlockBackupHeader,
} from './backup-crypto.js';
import { createChunkFile } from './backup-crypto-worker.js';

const WORKER_URL = new URL('./backup-crypto-worker.js', import.meta.url);
const BLOCK_BYTES = 1024 * 1024;
const BLOCKS_IN_FLIGHT = 4;
const CHUNKS_KEPT = 4;

const rawSession = (session) => ({
  payloadKey: new Uint8Array(session.payloadKey), noncePrefix: new Uint8Array(session.noncePrefix), chunkSize: session.chunkSize, aad: new Uint8Array(session.aad),
});

const stopped = () => Object.assign(new Error('The backup was cancelled.'), { code: 'BACKUP_CANCELLED' });

/**
 * A new encrypted backup at `path` (it must not exist; created with mode 0600) for `recipient` (the public half of
 * the owner's key: no password). Returns at once:
 *
 *   fileKey, authKey   this file's keys, for the check that reads it back
 *   wipe()      zeroes them and the payload key (the caller, once the file is verified or given up)
 *   keyId       which key pair it is for
 *   write(b)    resolves when the bytes are taken (waits while the thread is behind)
 *   finish()    the last chunk, fsync, close; resolves { bytes }
 *   abort()     stops the thread; the partial file is the caller's to remove
 *   stream()    the same as a Writable (archiver pipes into it); destroying it aborts
 */
export function createEncryptedBackupWriter(path, recipient, { chunkSize, now, spawnWorker = (data) => new Worker(WORKER_URL, { workerData: data }) } = {}) {
  const made = createBackupHeader(recipient, { ...(chunkSize ? { chunkSize } : {}), ...(now ? { now } : {}) });
  const worker = spawnWorker({ backupCrypto: 'write', path, start: new Uint8Array(made.bytes), session: rawSession(made.session) });
  let failure = null;
  let inFlight = 0;
  let waiting = [];
  let finishing = null;
  let over = false;
  let block = Buffer.allocUnsafeSlow(BLOCK_BYTES);
  let filled = 0;

  const release = () => { const list = waiting; waiting = []; for (const item of list) item.resolve(); };
  const fail = (error) => {
    if (failure || over) return;
    failure = error;
    const list = waiting; waiting = [];
    for (const item of list) item.reject(error);
    finishing?.reject(error);
  };
  worker.on('message', (message) => {
    if (message.ack) { inFlight -= 1; if (inFlight < BLOCKS_IN_FLIGHT) release(); }
    else if (message.done) { over = true; finishing?.resolve({ bytes: message.bytes }); }
    else if (message.error) fail(Object.assign(new Error(`The encrypted backup could not be written: ${message.error}`), { code: message.code || 'BACKUP_ENC_WRITE' }));
  });
  worker.once('error', (error) => fail(Object.assign(new Error(`The encrypted backup could not be written: ${error?.message || error}`), { code: 'BACKUP_ENC_WRITE' })));
  worker.once('exit', () => { if (!over) fail(failure || Object.assign(new Error('The thread that encrypts the backup stopped before it finished.'), { code: 'BACKUP_ENC_WRITE' })); });

  const send = async () => {
    const out = block;
    const length = filled;
    block = Buffer.allocUnsafeSlow(BLOCK_BYTES);
    filled = 0;
    inFlight += 1;
    worker.postMessage({ block: out.buffer, length }, [out.buffer]);
    if (inFlight >= BLOCKS_IN_FLIGHT) await new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };

  const writer = {
    fileKey: made.fileKey,
    authKey: made.authKey,
    wipe() { made.fileKey.fill(0); made.authKey.fill(0); made.session.payloadKey.fill(0); },
    keyId: made.header.recipient.keyId,
    header: made.header,
    async write(bytes) {
      if (failure) throw failure;
      if (finishing) throw new Error('the backup was already finished');
      let at = 0;
      while (at < bytes.length) {
        const count = Math.min(BLOCK_BYTES - filled, bytes.length - at);
        bytes.copy(block, filled, at, at + count);
        filled += count;
        at += count;
        if (filled === BLOCK_BYTES) await send();
        if (failure) throw failure;
      }
    },
    async finish() {
      if (failure) throw failure;
      if (finishing) return finishing.promise;
      if (filled) await send();
      if (failure) throw failure;
      finishing = {};
      finishing.promise = new Promise((resolve, reject) => { finishing.resolve = resolve; finishing.reject = reject; });
      worker.postMessage({ finish: true });
      try { return await finishing.promise; }
      finally { await worker.terminate().catch(() => {}); }
    },
    async abort() {
      if (!over) fail(stopped());
      over = true;
      await worker.terminate().catch(() => {});
    },
    stream() {
      let ended = false;
      return new Writable({
        highWaterMark: BLOCK_BYTES,
        write(chunk, _encoding, callback) { writer.write(chunk).then(() => callback(), callback); },
        final(callback) { writer.finish().then(() => { ended = true; callback(); }, callback); },
        destroy(error, callback) { (ended ? Promise.resolve() : writer.abort()).then(() => callback(error), () => callback(error)); },
      });
    },
  };
  return writer;
}

/**
 * A file as backup-zip-reader.js reads one: { size, read(position, length), stream(start, endInclusive), close() }.
 * This one is the file itself.
 */
export async function openPlainBackupSource(path) {
  const handle = await open(path, 'r');
  const { size } = await handle.stat();
  return {
    path,
    size,
    encrypted: false,
    async read(position, length) {
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
        if (bytesRead === 0) throw new Error('Invalid ZIP: unexpected end of file');
        offset += bytesRead;
      }
      return buffer;
    },
    stream: (start, end) => createReadStream(path, { start, end, highWaterMark: 1024 * 1024 }),
    close: () => handle.close(),
  };
}

/**
 * The plaintext of the encrypted backup at `path`, by position. Opened with its `fileKey` and `authKey` (the backup
 * that was just written) or with the owner's `password` (WRONG_PASSWORD when it does not open; nothing is read past
 * the header then). Every chunk passes its check as it is read, and the first and last chunk are read here, so a file that was
 * cut short, added to or given another header is refused before the caller sees a byte.
 *
 *   size                      the plaintext's length
 *   keyId, created            from the header
 *   read(position, length)    exactly those bytes
 *   stream(start, end)        a Readable of that range (end inclusive)
 *   authenticateRest({ onBytes, signal })   opens every chunk not read so far: after it, every byte of the file has
 *                             passed its check (the verification of a new backup, and of one about to be restored)
 *   close()                   stops the thread; safe to call twice
 *
 * `inline`: decrypt on the calling thread (the command-line restore, which has no server thread to keep free).
 */
export async function openEncryptedBackupSource(path, {
  fileKey = null, authKey = null, password = null, inline = false,
  spawnWorker = (data) => new Worker(WORKER_URL, { workerData: data }),
} = {}) {
  const parsed = await readBackupHeaderFile(path);
  const fileSize = (await stat(path)).size;
  const payloadBytes = fileSize - parsed.dataOffset;
  // The shape of the file is checked before the password is: a cut file is damaged whatever is typed.
  const layout = chunkLayout(payloadBytes, parsed.chunkSize);
  let key = fileKey;
  let auth = authKey;
  let ownsKeys = false;
  let session;
  if (key) session = openBackupSession(parsed, key, auth);
  else if (password != null) { ({ fileKey: key, authKey: auth, session } = await unlockBackupHeader(parsed, password)); ownsKeys = true; }
  else throw new BackupEncryptionError('BACKUP_PASSWORD_REQUIRED', 'This backup is encrypted: its password is needed to read it.', { status: 401 });

  let closed = false;
  let closing = null;
  let fetchChunk;
  let authenticateRest;
  let shut;

  if (inline) {
    const fd = openSync(path, 'r');
    const file = createChunkFile(fd, session, parsed.dataOffset, payloadBytes);
    fetchChunk = async (index) => file.read(index);
    authenticateRest = async ({ onBytes = null, signal = null } = {}) => {
      if (signal?.aborted) throw stopped();
      file.rest(onBytes);
    };
    shut = async () => { try { closeSync(fd); } catch { /* already closed */ } };
  } else {
    const worker = spawnWorker({ backupCrypto: 'read', path, dataOffset: parsed.dataOffset, payloadBytes, session: rawSession(session) });
    const pending = new Map();
    let nextId = 1;
    let failure = null;
    let progress = null;
    const failAll = (error) => {
      failure = failure || error;
      for (const item of pending.values()) item.reject(failure);
      pending.clear();
    };
    worker.on('message', (message) => {
      if (message.progress) { try { progress?.(message.progress); } catch { /* reporting never stops a check */ } return; }
      const item = message.id != null ? pending.get(message.id) : null;
      if (message.error) {
        const error = new BackupEncryptionError(message.code || 'BACKUP_ENC_DAMAGED', message.error);
        if (item) { pending.delete(message.id); item.reject(error); } else failAll(error);
        return;
      }
      if (!item) return;
      pending.delete(message.id);
      item.resolve(message.data ? Buffer.from(message.data) : true);
    });
    worker.once('error', (error) => failAll(new BackupEncryptionError('BACKUP_ENC_READ', `The encrypted backup could not be read: ${error?.message || error}`, { status: 500 })));
    worker.once('exit', () => failAll(closed ? stopped() : new BackupEncryptionError('BACKUP_ENC_READ', 'The thread that reads the encrypted backup stopped.', { status: 500 })));
    const ask = (message) => new Promise((resolve, reject) => {
      if (failure || closed) { reject(failure || stopped()); return; }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, ...message });
    });
    fetchChunk = (index) => ask({ index });
    authenticateRest = async ({ onBytes = null, signal = null } = {}) => {
      if (signal?.aborted) throw stopped();
      progress = onBytes;
      // The thread opens the chunks in one go: a cancel stops the thread itself.
      const stop = () => { closed = true; worker.terminate().catch(() => {}); };
      signal?.addEventListener('abort', stop, { once: true });
      try { await ask({ rest: true }); }
      catch (error) { throw signal?.aborted ? stopped() : error; }
      finally { signal?.removeEventListener('abort', stop); progress = null; }
    };
    shut = async () => { await worker.terminate().catch(() => {}); };
  }

  // The last few chunks, by index: a ZIP's directory and its entries are read in runs.
  const kept = new Map();
  const chunk = (index) => {
    let got = kept.get(index);
    if (!got) {
      got = fetchChunk(index);
      got.catch(() => kept.delete(index));
      kept.set(index, got);
      if (kept.size > CHUNKS_KEPT) kept.delete(kept.keys().next().value);
    }
    return got;
  };

  const source = {
    path,
    size: layout.plaintextSize,
    encrypted: true,
    keyId: parsed.recipient.keyId,
    created: typeof parsed.header.created === 'string' ? parsed.header.created : null,
    /** The recipient as this backup's header carries it (public key and password-wrapped keys; no authentication key). */
    recipient: parsed.header.recipient,
    /** The recipient as a key file stores it, for an installation that keeps this backup's key after a restore. */
    recipientForAdoption: () => ({ ...parsed.header.recipient, authKey: auth.toString('base64') }),
    async read(position, length) {
      if (position < 0 || position + length > layout.plaintextSize) throw new Error('Invalid ZIP: unexpected end of file');
      const out = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const at = position + done;
        const index = Math.floor(at / parsed.chunkSize);
        const plain = await chunk(index);
        const from = at - index * parsed.chunkSize;
        const count = Math.min(plain.length - from, length - done);
        if (count <= 0) throw new Error('Invalid ZIP: unexpected end of file');
        plain.copy(out, done, from, from + count);
        done += count;
      }
      return out;
    },
    stream(start, end) {
      const first = Math.floor(start / parsed.chunkSize);
      const last = Math.floor(end / parsed.chunkSize);
      return Readable.from((async function* ranged() {
        for (let index = first; index <= last; index += 1) {
          const plain = await chunk(index);
          const from = index === first ? start - index * parsed.chunkSize : 0;
          const to = index === last ? end - index * parsed.chunkSize + 1 : plain.length;
          if (to > plain.length) throw new Error('Invalid ZIP: unexpected end of file');
          yield plain.subarray(from, to);
        }
      })(), { objectMode: false });
    },
    authenticateRest: (options) => authenticateRest(options),
    /** Copies of this file's keys, for a caller that reads the file again later without asking for the password twice (it zeroes them). */
    copyKeys: () => ({ fileKey: Buffer.from(key), authKey: Buffer.from(auth) }),
    close() {
      closing ||= (async () => {
        closed = true;
        kept.clear();
        if (ownsKeys) { key.fill(0); auth.fill(0); }
        session.payloadKey.fill(0);
        await shut();
      })();
      return closing;
    },
  };
  try {
    // The ends of the file, now: a truncated or extended file fails here, whatever is read later.
    await chunk(layout.chunks - 1);
    if (layout.chunks > 1) await chunk(0);
  } catch (error) {
    await source.close().catch(() => {});
    throw error;
  }
  return source;
}

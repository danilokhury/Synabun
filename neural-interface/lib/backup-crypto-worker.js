// The thread that encrypts and decrypts backups (backup-crypto-io.js starts it). AES-256-GCM over gigabytes is work
// for a thread of its own: the server's thread only hands blocks over and waits for the answer.
//
//   write   workerData { mode: 'write', path, start, session }: creates `path` (it must not exist, mode 0600), writes
//           the header, then seals what arrives. Messages in: { block: ArrayBuffer } (answered { ack: true }) and
//           { finish: true } (the last chunk, fsync, close; answered { done: true, bytes }).
//   read    workerData { mode: 'read', path, dataOffset, payloadBytes, session }: messages in { id, index } (answered
//           { id, data: ArrayBuffer }), { id, rest: true } (opens every chunk not opened yet; { progress: bytes }
//           while it goes, then { id, done: true }) and { close: true }.
//
// A failure is answered { id?, error: message, code }; no message ever holds key material.

import { closeSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { chunkLayout, createChunkSealer, openChunk, TAG_BYTES } from './backup-crypto.js';

const sessionOf = (raw) => ({
  payloadKey: Buffer.from(raw.payloadKey), noncePrefix: Buffer.from(raw.noncePrefix), chunkSize: raw.chunkSize, aad: Buffer.from(raw.aad),
});

/**
 * The chunks of the encrypted file open on `fd`, read one at a time. `read(index)` is the plaintext of a chunk;
 * `rest(onBytes)` opens every chunk `read` has not opened yet, so that every byte of the file has passed its check.
 * Synchronous (the worker's thread, or a command-line restore's own).
 */
export function createChunkFile(fd, session, dataOffset, payloadBytes) {
  const layout = chunkLayout(payloadBytes, session.chunkSize);
  const seen = new Uint8Array(layout.chunks);
  const read = (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= layout.chunks) throw new RangeError('chunk index out of range');
    const last = index === layout.chunks - 1;
    const length = last ? layout.lastSealedSize : layout.sealedSize;
    const sealed = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const count = readSync(fd, sealed, got, length - got, dataOffset + index * layout.sealedSize + got);
      if (count === 0) break;
      got += count;
    }
    const plain = openChunk(session, index, last, sealed.subarray(0, got));
    seen[index] = 1;
    return plain;
  };
  return {
    layout,
    read,
    rest(onBytes = null) {
      for (let index = 0; index < layout.chunks; index += 1) {
        if (seen[index]) continue;
        const plain = read(index);
        if (onBytes) onBytes(plain.length + TAG_BYTES);
      }
    },
  };
}

function report(error, id) {
  parentPort.postMessage({ ...(id == null ? {} : { id }), error: String(error?.message || error), code: error?.code || null });
}

function runWriter({ path, start, session }) {
  let fd = null;
  let bytes = 0;
  const put = (buffer) => {
    let at = 0;
    while (at < buffer.length) at += writeSync(fd, buffer, at, buffer.length - at);
    bytes += buffer.length;
  };
  let sealer;
  try {
    fd = openSync(path, 'wx', 0o600);
    put(Buffer.from(start));
    sealer = createChunkSealer(sessionOf(session));
  } catch (error) { report(error); return; }
  parentPort.on('message', (message) => {
    try {
      if (message.block) {
        for (const sealed of sealer.push(Buffer.from(message.block, 0, message.length))) put(sealed);
        parentPort.postMessage({ ack: true });
      } else if (message.finish) {
        for (const sealed of sealer.finish()) put(sealed);
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        parentPort.postMessage({ done: true, bytes });
      }
    } catch (error) {
      try { if (fd !== null) closeSync(fd); } catch { /* already closed */ }
      fd = null;
      report(error);
    }
  });
}

function runReader({ path, dataOffset, payloadBytes, session }) {
  let fd = null;
  let file;
  try {
    fd = openSync(path, 'r');
    file = createChunkFile(fd, sessionOf(session), dataOffset, payloadBytes);
  } catch (error) { report(error); return; }
  parentPort.on('message', (message) => {
    if (message.close) {
      try { if (fd !== null) closeSync(fd); } catch { /* already closed */ }
      fd = null;
      parentPort.close();
      return;
    }
    try {
      if (message.rest) {
        let since = 0;
        file.rest((count) => {
          since += count;
          if (since >= 32 * 1024 * 1024) { parentPort.postMessage({ progress: since }); since = 0; }
        });
        if (since) parentPort.postMessage({ progress: since });
        parentPort.postMessage({ id: message.id, done: true });
        return;
      }
      const plain = file.read(message.index);
      // A copy with a buffer of its own: what leaves this thread is transferred, not shared.
      const out = new Uint8Array(plain.length);
      out.set(plain);
      parentPort.postMessage({ id: message.id, data: out.buffer }, [out.buffer]);
    } catch (error) { report(error, message.id); }
  });
}

if (parentPort && workerData?.backupCrypto === 'write') runWriter(workerData);
else if (parentPort && workerData?.backupCrypto === 'read') runReader(workerData);

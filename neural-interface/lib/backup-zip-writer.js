import { createHash } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A ZIP writer for snapshots that have to be quick at any size: the pre-update
 * snapshot is written while SynaBun restarts into a new version, and its
 * database can be several gigabytes.
 *
 * Every entry is written in one pass. Its CRC-32 (zlib's native crc32) and its
 * SHA-256 come from the same bytes as they go to disk, so nothing is read again
 * to checksum it. An entry marked `store` (a SQLite database, a file that is
 * already compressed) goes in as it is; anything else is deflated in memory,
 * which is only ever asked of small files. ZIP64 records are written whenever
 * a size, an offset or the entry count needs them, in exactly the shape
 * backup-zip-reader.js reads (and Info-ZIP's unzip -t accepts).
 *
 * The CRC of a streamed entry is unknown until its last byte, so its local
 * header is written with a zero CRC and patched in place afterwards: no data
 * descriptors, and the sizes in every header are the real ones.
 */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const UTF8_NAMES = 0x0800;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const CHUNK = 4 * 1024 * 1024;
// Files above this are never deflated in memory (the writer is for snapshots, where those are databases).
export const MAX_DEFLATE_BYTES = 64 * 1024 * 1024;

/** MS-DOS date and time (local time, two-second steps), as ZIP headers carry them. */
function dosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function zip64Extra(fields) {
  if (!fields.length) return Buffer.alloc(0);
  const extra = Buffer.alloc(4 + fields.length * 8);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(fields.length * 8, 2);
  fields.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + index * 8));
  return extra;
}

/**
 * Write `entries` into a new file at `path` (it must not exist).
 *   entries   [{ name, diskPath, store }] or [{ name, data: Buffer|string, store }]; `data` may be a
 *             function, called when its turn comes with what was written so far ([{ name, size, crc32,
 *             sha256 }]): a manifest that lists the checksums of the entries before it
 *   onProgress({ bytes, totalBytes }) as data goes in, at most every 64 MB and at the end
 *   forceZip64  write ZIP64 records even when nothing needs them (tests)
 * Resolves { bytes, entries: [{ name, size, crc32, sha256 }] } (sha256 in hex).
 */
export async function writeZipArchive(path, entries, { onProgress = null, now = () => new Date(), forceZip64 = false } = {}) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  const stamp = dosDateTime(now());
  // Sizes first, so the progress has a total and a stored entry's headers carry its real size.
  const planned = [];
  for (const entry of entries) {
    const name = String(entry?.name || '');
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) throw new Error(`Invalid archive entry name: ${name}`);
    if (typeof entry.data === 'function') {
      planned.push({ name, make: entry.data, size: 0, store: entry.store === true });
    } else if (entry.data !== undefined) {
      const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
      planned.push({ name, data, size: data.length, store: entry.store === true });
    } else {
      const size = (await stat(entry.diskPath)).size;
      const store = entry.store === true || size > MAX_DEFLATE_BYTES;
      planned.push({ name, diskPath: entry.diskPath, size, store });
    }
  }
  let totalBytes = planned.reduce((sum, item) => sum + item.size, 0);
  let doneBytes = 0;
  let reportedAt = 0;
  const progress = (force = false) => {
    if (force || doneBytes - reportedAt >= 64 * 1024 * 1024) {
      reportedAt = doneBytes;
      try { report({ bytes: doneBytes, totalBytes }); } catch { /* reporting never stops a snapshot */ }
    }
  };

  const handle = await open(path, 'wx');
  const written = [];
  let offset = 0;
  try {
    const write = async (buffer) => {
      let at = 0;
      while (at < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, at, buffer.length - at, offset + at);
        at += bytesWritten;
      }
      offset += buffer.length;
    };

    for (const item of planned) {
      if (item.make) {
        const made = item.make(written.map(entry => ({ name: entry.name, size: entry.size, crc32: entry.crc, sha256: entry.sha256 })));
        item.data = Buffer.isBuffer(made) ? made : Buffer.from(String(made), 'utf8');
        item.size = item.data.length;
        totalBytes += item.size;
      }
      const nameBytes = Buffer.from(item.name, 'utf8');
      const localOffset = offset;
      let crc = 0;
      const digest = createHash('sha256');
      let payload = null;
      if (item.data !== undefined) {
        crc = crc32(item.data, 0);
        digest.update(item.data);
        payload = item.store ? item.data : deflateRawSync(item.data, { level: 6 });
      } else if (!item.store) {
        const data = await readFile(item.diskPath);
        if (data.length !== item.size) throw new Error(`${item.name} changed while it was archived`);
        crc = crc32(data, 0);
        digest.update(data);
        payload = deflateRawSync(data, { level: 6 });
      }
      const method = item.store ? 0 : 8;
      const compressedSize = payload ? payload.length : item.size;
      const zip64 = forceZip64 || item.size >= MAX32 || compressedSize >= MAX32 || localOffset >= MAX32;
      const localExtra = zip64 ? zip64Extra([item.size, compressedSize]) : Buffer.alloc(0);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(SIG_LOCAL, 0);
      header.writeUInt16LE(zip64 ? 45 : method === 8 ? 20 : 10, 4);
      header.writeUInt16LE(UTF8_NAMES, 6);
      header.writeUInt16LE(method, 8);
      header.writeUInt16LE(stamp.time, 10);
      header.writeUInt16LE(stamp.date, 12);
      header.writeUInt32LE(crc >>> 0, 14);
      header.writeUInt32LE(zip64 ? MAX32 : compressedSize, 18);
      header.writeUInt32LE(zip64 ? MAX32 : item.size, 22);
      header.writeUInt16LE(nameBytes.length, 26);
      header.writeUInt16LE(localExtra.length, 28);
      await write(Buffer.concat([header, nameBytes, localExtra]));

      if (payload) {
        await write(payload);
        doneBytes += item.size;
        progress();
      } else {
        // Streamed: CRC and SHA-256 of the very bytes that go to disk, exactly `size` of them.
        // Two buffers: the next chunk is being read while this one is hashed and written.
        const source = await open(item.diskPath, 'r');
        try {
          const size = Math.min(CHUNK, Math.max(1, item.size));
          const buffers = [Buffer.allocUnsafe(size), Buffer.allocUnsafe(size)];
          let left = item.size;
          let position = 0;
          let turn = 0;
          let reading = left > 0 ? source.read(buffers[0], 0, Math.min(size, left), 0) : null;
          while (left > 0) {
            const { bytesRead } = await reading;
            if (bytesRead === 0) throw new Error(`${item.name} ended before its ${item.size} bytes (it changed while it was archived)`);
            const chunk = buffers[turn].subarray(0, bytesRead);
            left -= bytesRead;
            position += bytesRead;
            reading = left > 0 ? source.read(buffers[1 - turn], 0, Math.min(size, left), position) : null;
            crc = crc32(chunk, crc);
            digest.update(chunk);
            await write(chunk);
            turn = 1 - turn;
            doneBytes += bytesRead;
            progress();
          }
        } finally {
          await source.close();
        }
        const crcBuffer = Buffer.alloc(4);
        crcBuffer.writeUInt32LE(crc >>> 0, 0);
        await handle.write(crcBuffer, 0, 4, localOffset + 14);
      }
      written.push({ name: item.name, nameBytes, method, crc: crc >>> 0, size: item.size, compressedSize, localOffset, zip64, sha256: digest.digest('hex') });
    }

    // The central directory: one record per entry, then the end records.
    const directoryOffset = offset;
    const records = [];
    for (const entry of written) {
      const overflow = [];
      if (forceZip64 || entry.size >= MAX32) overflow.push(entry.size);
      if (forceZip64 || entry.compressedSize >= MAX32) overflow.push(entry.compressedSize);
      if (forceZip64 || entry.localOffset >= MAX32) overflow.push(entry.localOffset);
      const extra = zip64Extra(overflow);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(SIG_CENTRAL, 0);
      record.writeUInt16LE((3 << 8) | 45, 4);
      record.writeUInt16LE(entry.zip64 ? 45 : entry.method === 8 ? 20 : 10, 6);
      record.writeUInt16LE(UTF8_NAMES, 8);
      record.writeUInt16LE(entry.method, 10);
      record.writeUInt16LE(stamp.time, 12);
      record.writeUInt16LE(stamp.date, 14);
      record.writeUInt32LE(entry.crc, 16);
      record.writeUInt32LE(forceZip64 || entry.compressedSize >= MAX32 ? MAX32 : entry.compressedSize, 20);
      record.writeUInt32LE(forceZip64 || entry.size >= MAX32 ? MAX32 : entry.size, 24);
      record.writeUInt16LE(entry.nameBytes.length, 28);
      record.writeUInt16LE(extra.length, 30);
      record.writeUInt16LE(0, 32);
      record.writeUInt16LE(0, 34);
      record.writeUInt16LE(0, 36);
      // A regular file, rw-r--r-- (unzip and ditto give it these permissions).
      record.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      record.writeUInt32LE(forceZip64 || entry.localOffset >= MAX32 ? MAX32 : entry.localOffset, 42);
      records.push(record, entry.nameBytes, extra);
    }
    const directory = Buffer.concat(records);
    await write(directory);
    const directorySize = directory.length;
    const needs64 = forceZip64 || written.length >= MAX16 || directorySize >= MAX32 || directoryOffset >= MAX32;
    if (needs64) {
      const zip64At = offset;
      const record = Buffer.alloc(56);
      record.writeUInt32LE(SIG_ZIP64_EOCD, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE((3 << 8) | 45, 12);
      record.writeUInt16LE(45, 14);
      record.writeUInt32LE(0, 16);
      record.writeUInt32LE(0, 20);
      record.writeBigUInt64LE(BigInt(written.length), 24);
      record.writeBigUInt64LE(BigInt(written.length), 32);
      record.writeBigUInt64LE(BigInt(directorySize), 40);
      record.writeBigUInt64LE(BigInt(directoryOffset), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(zip64At), 8);
      locator.writeUInt32LE(1, 16);
      await write(Buffer.concat([record, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_EOCD, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(needs64 ? MAX16 : written.length, 8);
    end.writeUInt16LE(needs64 ? MAX16 : written.length, 10);
    end.writeUInt32LE(needs64 ? MAX32 : directorySize, 12);
    end.writeUInt32LE(needs64 ? MAX32 : directoryOffset, 16);
    end.writeUInt16LE(0, 20);
    await write(end);
    await handle.sync();
    progress(true);
  } finally {
    await handle.close();
  }
  return {
    bytes: offset,
    entries: written.map(entry => ({ name: entry.name, size: entry.size, crc32: entry.crc, sha256: entry.sha256 })),
  };
}

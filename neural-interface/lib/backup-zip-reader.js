import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw, crc32 } from 'node:zlib';
import { dirname } from 'node:path';

/**
 * Streaming ZIP reader for backup archives.
 *
 * AdmZip reads the whole archive into one Buffer, and Node refuses any file
 * over 2 GiB (ERR_FS_FILE_TOO_LARGE), so every large backup failed its own
 * verification and was deleted. This reader only buffers the central
 * directory; entry data streams from disk through inflate. It trusts the
 * central directory for sizes, so data descriptors (archiver writes them)
 * need no special handling, and it reads ZIP64 records for archives, entries
 * and offsets past 4 GiB.
 */

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const EOCD_MAX_SCAN = EOCD_MIN + 0xffff;
const MAX_CENTRAL_DIRECTORY_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error('Invalid ZIP: unexpected end of file');
    offset += bytesRead;
  }
  return buffer;
}

function readUInt64(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid ZIP: 64-bit field out of range');
  return Number(value);
}

async function locateCentralDirectory(handle, fileSize) {
  if (fileSize < EOCD_MIN) throw new Error('Invalid ZIP: file is too small');
  const scanLength = Math.min(fileSize, EOCD_MAX_SCAN);
  const tailStart = fileSize - scanLength;
  const tail = await readAt(handle, tailStart, scanLength);
  let eocd = -1;
  for (let index = tail.length - EOCD_MIN; index >= 0; index--) {
    if (tail.readUInt32LE(index) === SIG_EOCD) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error('Invalid ZIP: end of central directory not found');

  let entryCount = tail.readUInt16LE(eocd + 10);
  let size = tail.readUInt32LE(eocd + 12);
  let offset = tail.readUInt32LE(eocd + 16);

  // A ZIP64 locator sits immediately before the classic record whenever any
  // of its fields overflowed; the classic fields then hold 0xFFFF sentinels.
  const locatorAt = tailStart + eocd - 20;
  if (locatorAt >= 0) {
    const locator = await readAt(handle, locatorAt, 20);
    if (locator.readUInt32LE(0) === SIG_ZIP64_LOCATOR) {
      const zip64At = readUInt64(locator, 8);
      const record = await readAt(handle, zip64At, 56);
      if (record.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new Error('Invalid ZIP: ZIP64 end of central directory is corrupt');
      entryCount = readUInt64(record, 32);
      size = readUInt64(record, 40);
      offset = readUInt64(record, 48);
    }
  }
  if (size > MAX_CENTRAL_DIRECTORY_BYTES) throw new Error('Invalid ZIP: central directory is implausibly large');
  if (offset + size > fileSize) throw new Error('Invalid ZIP: central directory is outside the file');
  return { entryCount, size, offset };
}

function parseZip64Extra(extra, entry) {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const length = extra.readUInt16LE(cursor + 2);
    const start = cursor + 4;
    if (id === 0x0001) {
      // Only the fields whose classic value overflowed are present, in order.
      let field = start;
      const take = () => {
        if (field + 8 > start + length) throw new Error(`Invalid ZIP: truncated ZIP64 field for ${entry.name}`);
        const value = readUInt64(extra, field);
        field += 8;
        return value;
      };
      if (entry.uncompressedSize === 0xffffffff) entry.uncompressedSize = take();
      if (entry.compressedSize === 0xffffffff) entry.compressedSize = take();
      if (entry.localHeaderOffset === 0xffffffff) entry.localHeaderOffset = take();
      return;
    }
    cursor = start + length;
  }
}

function parseCentralDirectory(buffer, expectedCount) {
  const entries = [];
  let cursor = 0;
  while (cursor + 46 <= buffer.length) {
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL) break;
    const flags = buffer.readUInt16LE(cursor + 8);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const nameStart = cursor + 46;
    // Backups are written with ASCII/UTF-8 names; CP437 is not worth a table.
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength);
    const entry = {
      name,
      flags,
      method: buffer.readUInt16LE(cursor + 10),
      crc32: buffer.readUInt32LE(cursor + 16),
      compressedSize: buffer.readUInt32LE(cursor + 20),
      uncompressedSize: buffer.readUInt32LE(cursor + 24),
      localHeaderOffset: buffer.readUInt32LE(cursor + 42),
      isDirectory: name.endsWith('/'),
    };
    parseZip64Extra(buffer.subarray(nameStart + nameLength, nameStart + nameLength + extraLength), entry);
    entries.push(entry);
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  // The 16-bit count wraps for >65535 entries without ZIP64; trust the walk
  // unless it came up short of a count that cannot have wrapped.
  if (entries.length < expectedCount) throw new Error('Invalid ZIP: central directory is truncated');
  return entries;
}

/** Verify the entry's CRC-32 and size as bytes stream past. */
function integrityCheck(entry) {
  let crc = 0;
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > entry.uncompressedSize) {
        callback(new Error(`Invalid ZIP: ${entry.name} is larger than declared`));
        return;
      }
      crc = crc32(chunk, crc);
      callback(null, chunk);
    },
    flush(callback) {
      if (bytes !== entry.uncompressedSize) callback(new Error(`Invalid ZIP: ${entry.name} is truncated`));
      else if ((crc >>> 0) !== entry.crc32) callback(new Error(`Invalid ZIP: CRC mismatch for ${entry.name}`));
      else callback();
    },
  });
}

export async function openZipArchive(path) {
  const handle = await open(path, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const directory = await locateCentralDirectory(handle, fileSize);
    const buffer = await readAt(handle, directory.offset, directory.size);
    const entries = parseCentralDirectory(buffer, directory.entryCount);
    const byName = new Map();
    for (const entry of entries) if (!byName.has(entry.name)) byName.set(entry.name, entry);

    async function dataRange(entry) {
      const local = await readAt(handle, entry.localHeaderOffset, 30);
      if (local.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`Invalid ZIP: local header for ${entry.name} is corrupt`);
      const start = entry.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (start + entry.compressedSize > fileSize) throw new Error(`Invalid ZIP: ${entry.name} extends past the end of the file`);
      return { start, length: entry.compressedSize };
    }

    return {
      path,
      size: fileSize,
      entries,
      getEntry: name => byName.get(name) || null,
      /** Stream one entry's uncompressed bytes into `sink`, checking CRC and size. */
      async pipeEntry(entry, sink) {
        if (entry.flags & 0x1) throw new Error(`Unsupported ZIP: ${entry.name} is encrypted`);
        if (entry.method !== 0 && entry.method !== 8) throw new Error(`Unsupported ZIP: ${entry.name} uses compression method ${entry.method}`);
        const { start, length } = await dataRange(entry);
        const stages = [length > 0
          ? createReadStream(path, { start, end: start + length - 1, highWaterMark: 1024 * 1024 })
          : Readable.from([])];
        if (entry.method === 8) stages.push(createInflateRaw());
        stages.push(integrityCheck(entry), sink);
        await pipeline(stages);
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function hashZipEntry(zip, entry) {
  const digest = createHash('sha256');
  await zip.pipeEntry(entry, new Writable({
    write(chunk, _encoding, callback) { digest.update(chunk); callback(); },
  }));
  return digest.digest('hex');
}

export async function readZipEntry(zip, entry, { maxBytes = MAX_MANIFEST_BYTES } = {}) {
  if (entry.uncompressedSize > maxBytes) throw new Error(`${entry.name} is too large to read into memory`);
  const chunks = [];
  await zip.pipeEntry(entry, new Writable({
    write(chunk, _encoding, callback) { chunks.push(chunk); callback(); },
  }));
  return Buffer.concat(chunks);
}

/** Extract to a sibling temp file first so a failed CRC never leaves a partial target. */
export async function extractZipEntry(zip, entry, targetPath) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const temp = `${targetPath}.${process.pid}.restore-tmp`;
  try {
    await zip.pipeEntry(entry, createWriteStream(temp));
    renameSync(temp, targetPath);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Locate `<prefix>/manifest.json` and parse it. Only a top-level manifest
 * counts: backed-up files can be named manifest.json too (a synced skill's
 * global-skills/…/manifest.json), and they are written before the real one.
 * Returns null when the archive has no manifest so callers can phrase their
 * own error.
 */
export async function readBackupManifest(zip) {
  const entry = zip.entries.find(item => !item.isDirectory && /^(?:[^/]+\/)?manifest\.json$/.test(item.name));
  if (!entry) return null;
  const prefix = entry.name.slice(0, -'manifest.json'.length).replace(/\/$/, '');
  const manifest = JSON.parse((await readZipEntry(zip, entry)).toString('utf-8'));
  return { entry, prefix, manifest };
}

export function backupEntryName(prefix, archivePath) {
  return prefix ? `${prefix}/${archivePath}` : archivePath;
}

/** Stream every manifest-listed entry through sha256 and compare. */
export async function verifyBackupChecksums(zip, { prefix, manifest, label = 'Backup verification failed' }) {
  for (const [archivePath, expected] of Object.entries(manifest.checksums || {})) {
    const entry = zip.getEntry(backupEntryName(prefix, archivePath));
    if (!entry) throw new Error(`${label}: ${archivePath} is missing`);
    let actual;
    try { actual = `sha256:${await hashZipEntry(zip, entry)}`; }
    catch (error) { throw new Error(`${label}: ${archivePath} is unreadable (${error.message})`); }
    if (actual !== expected) throw new Error(`${label}: checksum mismatch for ${archivePath}`);
  }
}

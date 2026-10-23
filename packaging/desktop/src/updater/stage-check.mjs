/**
 * Is an unpacked update still exactly the archive it came from? mac.mjs asks
 * before it runs anything in a copy unpacked earlier and before it installs one:
 * a code signature cannot say it (an ad hoc signature can be made again by
 * anyone who changed the files), the archive can, because its SHA-512 is the
 * feed's.
 *
 *   compareFolderWithZip  the folder against the archive's own listing (its
 *                         central directory), entry by entry: the same names
 *                         and nothing more, the same kind (folder, file, link),
 *                         a link to the same target, a file with the same size,
 *                         the same executable bits and the very same bytes (the
 *                         archive's data inflated and compared with the file's)
 *   treeSignature         what a folder's files are now, as the file system
 *                         says without reading them (kind, mode, size, inode,
 *                         modification and change times, link target): taken
 *                         right after a check, it tells later whether anything
 *                         in the folder was touched since (a change, a chmod or
 *                         a replaced file moves the change time, which no
 *                         program can set back)
 *
 * The archive is the one ditto made (packaging/lib/desktop.mjs): stored and
 * deflated entries, Unix modes, ZIP64 when needed. Every file is read through
 * real-fs.mjs (Electron's `original-fs`): the bundle holds app.asar, which
 * Electron's `fs` would open as a folder. Plain Node, no Electron
 * (packaging/tests/desktop-updater.test.mjs).
 */

import { join } from 'node:path';
import { promisify } from 'node:util';
import { inflateRaw as inflateRawCallback } from 'node:zlib';
import { createInflateRaw } from 'node:zlib';
import { realFs } from './real-fs.mjs';

// The files on disk as they are: inside Electron, `fs` would walk into app.asar as if it were a folder.
const { lstat, open, readdir, readFile, readlink } = realFs.promises;
const inflateRaw = promisify(inflateRawCallback);

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
/** Entries up to this size are compared whole; bigger ones as a stream (a few at a time: the main process stays small). */
const WHOLE_BYTES = 4 * 1024 * 1024;
/** The executable bits are what a check of the mode compares: ditto keeps them, and a lost one breaks a binary. */
const EXEC_BITS = 0o111;

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error('the archive ends early');
    offset += bytesRead;
  }
  return buffer;
}

function uint64(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('the archive has a 64-bit field out of range');
  return Number(value);
}

/** The archive's listing: [{ name, method, flags, size, compressedSize, localHeaderOffset, type, mode }]. */
export async function readZipListing(handle) {
  const { size: fileSize } = await handle.stat();
  if (fileSize < 22) throw new Error('the archive is too small');
  const scan = Math.min(fileSize, 22 + 0xffff);
  const tailStart = fileSize - scan;
  const tail = await readAt(handle, tailStart, scan);
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index--) if (tail.readUInt32LE(index) === SIG_EOCD) { eocd = index; break; }
  if (eocd < 0) throw new Error('the archive has no end of central directory');
  let count = tail.readUInt16LE(eocd + 10);
  let size = tail.readUInt32LE(eocd + 12);
  let offset = tail.readUInt32LE(eocd + 16);
  if (tailStart + eocd >= 20) {
    const locator = await readAt(handle, tailStart + eocd - 20, 20);
    if (locator.readUInt32LE(0) === SIG_ZIP64_LOCATOR) {
      const record = await readAt(handle, uint64(locator, 8), 56);
      if (record.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new Error('the archive\'s ZIP64 record is corrupt');
      count = uint64(record, 32);
      size = uint64(record, 40);
      offset = uint64(record, 48);
    }
  }
  if (offset + size > fileSize || size > 256 * 1024 * 1024) throw new Error('the archive\'s central directory is out of place');
  const directory = await readAt(handle, offset, size);
  const entries = [];
  let cursor = 0;
  while (cursor + 46 <= directory.length && directory.readUInt32LE(cursor) === SIG_CENTRAL) {
    const madeBy = directory.readUInt16LE(cursor + 4) >> 8;
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const nameAt = cursor + 46;
    const rawName = directory.toString('utf8', nameAt, nameAt + nameLength);
    const external = directory.readUInt32LE(cursor + 38);
    const entry = {
      name: rawName,
      flags: directory.readUInt16LE(cursor + 8),
      method: directory.readUInt16LE(cursor + 10),
      compressedSize: directory.readUInt32LE(cursor + 20),
      size: directory.readUInt32LE(cursor + 24),
      localHeaderOffset: directory.readUInt32LE(cursor + 42),
      mode: madeBy === 3 ? (external >>> 16) & 0xffff : 0,
    };
    const extra = directory.subarray(nameAt + nameLength, nameAt + nameLength + extraLength);
    for (let at = 0; at + 4 <= extra.length;) {
      const id = extra.readUInt16LE(at);
      const length = extra.readUInt16LE(at + 2);
      if (id === 0x0001) {
        let field = at + 4;
        const take = () => { const value = uint64(extra, field); field += 8; return value; };
        if (entry.size === 0xffffffff) entry.size = take();
        if (entry.compressedSize === 0xffffffff) entry.compressedSize = take();
        if (entry.localHeaderOffset === 0xffffffff) entry.localHeaderOffset = take();
        break;
      }
      at += 4 + length;
    }
    const kind = entry.mode & S_IFMT;
    entry.type = rawName.endsWith('/') || kind === S_IFDIR ? 'dir' : kind === S_IFLNK ? 'link' : 'file';
    entry.name = rawName.replace(/\/+$/, '');
    entries.push(entry);
    cursor = nameAt + nameLength + extraLength + commentLength;
  }
  if (entries.length < count) throw new Error('the archive\'s central directory is truncated');
  return entries;
}

/** Where an entry's data starts in the archive, and its length. */
async function dataRange(handle, entry, fileSize) {
  const local = await readAt(handle, entry.localHeaderOffset, 30);
  if (local.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`the archive's local header for ${entry.name} is corrupt`);
  const start = entry.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  if (start + entry.compressedSize > fileSize) throw new Error(`${entry.name} runs past the end of the archive`);
  return { start, length: entry.compressedSize };
}

/** An entry's whole content (small entries and links). */
async function entryBytes(handle, entry, fileSize) {
  const { start, length } = await dataRange(handle, entry, fileSize);
  const raw = length ? await readAt(handle, start, length) : Buffer.alloc(0);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw);
  throw new Error(`${entry.name} uses compression method ${entry.method}`);
}

/** True when the file at `path` holds the entry's very bytes, compared as they come (big entries: a stream of their own). */
async function sameAsStream(handle, zipPath, entry, fileSize, path) {
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name} uses compression method ${entry.method}`);
  const { start, length } = await dataRange(handle, entry, fileSize);
  if (!length) return entry.size === 0 && (await readFile(path)).length === 0;
  const file = await open(path, 'r');
  try {
    let position = 0;
    const source = realFs.createReadStream(zipPath, { start, end: start + length - 1, highWaterMark: 1024 * 1024 });
    const stream = entry.method === 8 ? source.pipe(createInflateRaw()) : source;
    for await (const chunk of stream) {
      const mine = await readAt(file, position, chunk.length).catch(() => null);
      if (!mine || !mine.equals(chunk)) { source.destroy(); return false; }
      position += chunk.length;
    }
    return position === entry.size;
  } finally {
    await file.close();
  }
}

/**
 * Every path under `root` (relative, `/`-separated), with what lstat says of it. Links are never followed. The
 * entries of a folder are asked for together (a bundle holds some 16,000 files: one at a time costs a third of a
 * second on the restart's path).
 */
async function walk(root, relative = '', into = new Map()) {
  const here = relative ? join(root, ...relative.split('/')) : root;
  const stat = await lstat(here, { bigint: true });
  into.set(relative, stat);
  if (stat.isDirectory()) {
    const names = (await readdir(here)).sort();
    await Promise.all(names.map(name => walk(root, relative ? `${relative}/${name}` : name, into)));
  }
  return into;
}

/**
 * The folder `folder` against the archive at `zipPath`: resolves { same: true } or { same: false, reason } (the
 * first difference found). Only what the archive holds is compared, under its own top-level names (beside them the
 * folder may hold what SynaBun put there, such as staged.json). `__MACOSX/` entries (resource forks, extended
 * attributes) are not files of the bundle and are left out.
 */
export async function compareFolderWithZip({ zipPath, folder, concurrency = 6 }) {
  const handle = await open(zipPath, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const listing = (await readZipListing(handle)).filter(entry => entry.name && !entry.name.startsWith('__MACOSX/') && entry.name !== '__MACOSX');
    for (const entry of listing) {
      if (entry.flags & 0x1) return { same: false, reason: `${entry.name} is encrypted in the archive` };
      if (entry.name.split('/').some(part => part === '..' || part === '.' || part === '') || entry.name.startsWith('/')) {
        return { same: false, reason: `the archive names ${entry.name}` };
      }
    }
    const expected = new Map(listing.map(entry => [entry.name, entry]));
    // Folders the archive implies by the entries inside them.
    for (const entry of listing) {
      const parts = entry.name.split('/');
      for (let depth = 1; depth < parts.length; depth++) {
        const parent = parts.slice(0, depth).join('/');
        if (!expected.has(parent)) expected.set(parent, { name: parent, type: 'dir', implied: true, mode: 0 });
      }
    }
    const tops = new Set([...expected.keys()].map(name => name.split('/')[0]));
    const found = new Map();
    for (const top of tops) {
      try { await walk(folder, top, found); }
      catch (error) { if (error?.code === 'ENOENT') return { same: false, reason: `${top} is missing` }; throw error; }
    }
    for (const name of found.keys()) if (!expected.has(name)) return { same: false, reason: `${name} is not in the archive` };
    for (const [name, entry] of expected) {
      const stat = found.get(name);
      if (!stat) return { same: false, reason: `${name} is missing` };
      const kind = stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : 'other';
      if (kind !== entry.type) return { same: false, reason: `${name} is a ${kind}, the archive has a ${entry.type}` };
    }
    // Links and files: what they point to, their size and executable bits, then their bytes.
    const files = [];
    for (const [name, entry] of expected) {
      if (entry.type === 'dir') continue;
      const stat = found.get(name);
      const path = join(folder, ...name.split('/'));
      if (entry.type === 'link') {
        const target = (await entryBytes(handle, entry, fileSize)).toString('utf8');
        if ((await readlink(path)) !== target) return { same: false, reason: `${name} points elsewhere` };
        continue;
      }
      if (Number(stat.size) !== entry.size) return { same: false, reason: `${name} has ${stat.size} bytes, the archive ${entry.size}` };
      if (entry.mode && (Number(stat.mode) & EXEC_BITS) !== (entry.mode & EXEC_BITS)) return { same: false, reason: `${name} has other permissions` };
      files.push({ name, entry, path });
    }
    // Biggest first, a few at a time: the inflating runs on Node's thread pool.
    files.sort((a, b) => b.entry.size - a.entry.size);
    let next = 0;
    let difference = null;
    const worker = async () => {
      while (!difference && next < files.length) {
        const { name, entry, path } = files[next++];
        let same;
        if (entry.size <= WHOLE_BYTES) {
          const [archived, mine] = await Promise.all([entryBytes(handle, entry, fileSize), readFile(path)]);
          same = archived.equals(mine);
        } else {
          same = await sameAsStream(handle, zipPath, entry, fileSize, path);
        }
        if (!same && !difference) difference = `${name} differs from the archive`;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
    return difference ? { same: false, reason: difference } : { same: true, reason: null };
  } finally {
    await handle.close();
  }
}

/**
 * What the files under `root` are now, as the file system says without reading them: a Map of relative path to
 * "kind mode size inode mtime ctime [target]". Two signatures that are equal mean nothing in the folder was written,
 * replaced, added, removed or had its mode changed in between.
 */
export async function treeSignature(root) {
  const signature = new Map();
  for (const [name, stat] of await walk(root)) {
    const kind = stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : stat.isFile() ? 'f' : 'o';
    const target = kind === 'l' ? await readlink(join(root, ...name.split('/'))) : '';
    signature.set(name, `${kind} ${stat.mode} ${stat.size} ${stat.ino} ${stat.mtimeNs} ${stat.ctimeNs} ${target}`);
  }
  return signature;
}

/** The first path where two signatures differ, or null when they are the same. */
export function signatureDifference(before, now) {
  if (!before || !now) return 'no record to compare with';
  for (const [name, value] of now) if (before.get(name) !== value) return before.has(name) ? `${name || 'the folder'} changed` : `${name} is new`;
  for (const name of before.keys()) if (!now.has(name)) return `${name} is gone`;
  return null;
}

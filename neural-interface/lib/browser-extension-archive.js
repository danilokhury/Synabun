// The extension package: which files an extension folder may hold, and the one zip form SynaBun writes and reads.
//
// One allowlist for everything (extensionFileAllowed): the manifest, scripts, pages, styles at the top and the PNGs
// in `icons/`. The folder the owner loads, a folder read as a source (Dev's build, tests) and a downloaded package
// are all held to it.
//
// The package is a zip SynaBun builds itself (scripts/extension/build-browser-extension.mjs, Dev only) in one fixed
// form, so two builds of the same files are the same bytes on any machine and any Node: entries sorted by name, every
// one STORED (no deflate, whose output depends on the zlib at hand), one fixed time, one fixed mode, no folder
// entries, no extra fields, no comments. readExtensionZip accepts only that form, which is also what makes a hostile
// file harmless: nothing is inflated (no zip bomb), a name outside the allowlist, a link, a second entry of a name, a
// gap or bytes after the directory are each a refusal, and every entry's CRC is checked. It returns bytes in memory and
// writes nothing; the caller has verified the file's size and SHA-256 before it calls (lib/browser-extension-package.js).
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(js|json|html|css|png)$/;
const ICON = /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/;
/** The most entries a package may hold, and the most bytes one of them may be. */
export const EXTENSION_MAX_FILES = 64;
export const EXTENSION_MAX_FILE_BYTES = 4 * 1024 * 1024;

const fail = (message) => { throw Object.assign(new Error(message), { code: 'EXTENSION_ARCHIVE_INVALID' }); };

/** Whether `rel` (forward slashes, relative to the extension folder) is a file an extension folder may hold. */
export function extensionFileAllowed(rel) {
  if (typeof rel !== 'string') return false;
  const parts = rel.split('/');
  if (parts.length === 1) return FILE.test(parts[0]);
  return parts.length === 2 && parts[0] === 'icons' && ICON.test(parts[1]);
}

/**
 * A folder's extension files, by path relative to it: regular files of the allowlist (a link is never followed), the
 * top level and `icons/`, sorted by name. Returns [{ rel, bytes }].
 */
export function readExtensionSource(source) {
  const files = [];
  for (const [dir, prefix] of [[source, ''], [join(source, 'icons'), 'icons/']]) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const rel = prefix + name;
      if (!extensionFileAllowed(rel)) continue;
      const path = join(dir, name);
      try { if (!lstatSync(path).isFile()) continue; } catch { continue; }
      files.push({ rel, bytes: readFileSync(path) });
    }
  }
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

// 1980-01-01 00:00:00, the first moment a zip can name; rw-r--r-- on a regular file, written by "Unix".
const DOS_TIME = 0, DOS_DATE = 0x0021, MADE_BY = 0x031e, NEEDED = 10, MODE = 0o100644;
const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50;

function checkFiles(files) {
  if (!Array.isArray(files) || !files.length) fail('The extension has no files.');
  if (files.length > EXTENSION_MAX_FILES) fail('The extension has too many files.');
  const seen = new Set();
  for (const file of files) {
    if (!extensionFileAllowed(file?.rel)) fail('The extension holds a file that is not allowed.');
    if (!Buffer.isBuffer(file.bytes) || file.bytes.length > EXTENSION_MAX_FILE_BYTES) fail('A file of the extension is too large.');
    const key = file.rel.toLowerCase();
    if (seen.has(key)) fail('The extension names a file twice.');
    seen.add(key);
  }
  if (!seen.has('manifest.json')) fail('The extension has no manifest.');
}

/** The package of `files` ([{ rel, bytes }]) in SynaBun's one zip form. The same files give the same bytes. */
export function writeExtensionZip(files) {
  checkFiles(files);
  const sorted = [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const parts = [], directory = [];
  let offset = 0;
  for (const { rel, bytes } of sorted) {
    const name = Buffer.from(rel, 'ascii'), crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0); local.writeUInt16LE(NEEDED, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0); central.writeUInt16LE(MADE_BY, 4); central.writeUInt16LE(NEEDED, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE((MODE << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    parts.push(local, name, bytes); directory.push(central, name);
    offset += 30 + name.length + bytes.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(sorted.length, 8); end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, directoryBytes, end]);
}

/**
 * The files of a package in SynaBun's one zip form: [{ rel, bytes }], sorted by name. Throws
 * EXTENSION_ARCHIVE_INVALID for anything else (see the top of this file); never writes and never inflates.
 */
export function readExtensionZip(zip) {
  if (!Buffer.isBuffer(zip) || zip.length < 22) fail('The package is not a zip file.');
  const endAt = zip.length - 22;
  if (zip.readUInt32LE(endAt) !== END) fail('The package does not end as SynaBun writes it.');
  const count = zip.readUInt16LE(endAt + 10), directorySize = zip.readUInt32LE(endAt + 12), directoryAt = zip.readUInt32LE(endAt + 16);
  if (zip.readUInt16LE(endAt + 4) || zip.readUInt16LE(endAt + 6) || zip.readUInt16LE(endAt + 8) !== count || zip.readUInt16LE(endAt + 20)) fail('The package is not a plain single zip file.');
  if (!count || count > EXTENSION_MAX_FILES) fail('The package holds no files, or too many.');
  if (directoryAt + directorySize !== endAt) fail('The package has bytes its directory does not account for.');
  const files = [], seen = new Set();
  let at = directoryAt, dataAt = 0, previous = '';
  for (let i = 0; i < count; i++) {
    if (at + 46 > endAt || zip.readUInt32LE(at) !== CENTRAL) fail('The package directory is damaged.');
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10), crc = zip.readUInt32LE(at + 16);
    const packed = zip.readUInt32LE(at + 20), size = zip.readUInt32LE(at + 24), nameLength = zip.readUInt16LE(at + 28);
    const attributes = zip.readUInt32LE(at + 38), localAt = zip.readUInt32LE(at + 42);
    if (flags !== 0 || method !== 0 || packed !== size) fail('The package holds an entry that is compressed, encrypted or streamed.');
    if (zip.readUInt16LE(at + 30) || zip.readUInt16LE(at + 32) || zip.readUInt16LE(at + 34)) fail('The package holds an entry with extra data.');
    // Every other field is the one value SynaBun's writer puts there: the version needed, the time, the date, the
    // internal attributes (and, below, the same in the entry's own header).
    if (zip.readUInt16LE(at + 6) !== NEEDED || zip.readUInt16LE(at + 12) !== DOS_TIME || zip.readUInt16LE(at + 14) !== DOS_DATE || zip.readUInt16LE(at + 36) !== 0) fail('The package holds an entry that SynaBun did not write.');
    if (size > EXTENSION_MAX_FILE_BYTES) fail('The package holds a file that is too large.');
    if (at + 46 + nameLength > endAt) fail('The package directory is damaged.');
    const nameBytes = zip.subarray(at + 46, at + 46 + nameLength), rel = nameBytes.toString('latin1');
    // A regular file and nothing else: a link, a folder, a device are told by the Unix mode a zip keeps for its maker.
    if (zip.readUInt16LE(at + 4) !== MADE_BY || (attributes >>> 16) !== MODE) fail('The package holds an entry that is not a plain file.');
    if (!extensionFileAllowed(rel)) fail('The package holds a file that is not part of the extension.');
    const key = rel.toLowerCase();
    if (seen.has(key)) fail('The package names a file twice.');
    if (previous && !(previous < rel)) fail('The package is not in SynaBun\'s order.');
    seen.add(key); previous = rel;
    // The entry itself: where the last one ended, with a header that says what the directory says.
    if (localAt !== dataAt || localAt + 30 + nameLength + size > directoryAt) fail('The package has a gap or an overlap between its files.');
    if (zip.readUInt32LE(localAt) !== LOCAL || zip.readUInt16LE(localAt + 4) !== NEEDED || zip.readUInt16LE(localAt + 6) !== 0 || zip.readUInt16LE(localAt + 8) !== 0
      || zip.readUInt16LE(localAt + 10) !== DOS_TIME || zip.readUInt16LE(localAt + 12) !== DOS_DATE || zip.readUInt32LE(localAt + 14) !== crc
      || zip.readUInt32LE(localAt + 18) !== size || zip.readUInt32LE(localAt + 22) !== size || zip.readUInt16LE(localAt + 26) !== nameLength || zip.readUInt16LE(localAt + 28) !== 0
      || !zip.subarray(localAt + 30, localAt + 30 + nameLength).equals(nameBytes)) fail('The package has an entry whose header does not match its directory.');
    const bytes = Buffer.from(zip.subarray(localAt + 30 + nameLength, localAt + 30 + nameLength + size));
    if (crc32(bytes) !== crc) fail('The package holds a damaged file.');
    files.push({ rel, bytes });
    dataAt = localAt + 30 + nameLength + size;
    at += 46 + nameLength;
  }
  if (at !== endAt || dataAt !== directoryAt) fail('The package has bytes its directory does not account for.');
  if (!seen.has('manifest.json')) fail('The package has no manifest.');
  return files;
}

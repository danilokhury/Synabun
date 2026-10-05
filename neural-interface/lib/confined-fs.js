// ── File operations that stay where they were checked ──
// lib/path-confine.js decides whether a path is inside a folder. Between that
// decision and the read or write that follows, the filesystem can change: a
// file or a folder on the way swapped for a link. These helpers close that
// window as far as Node allows without native code:
//   - they work on the canonical path (every link resolved), so nothing on the
//     way to the file is a link at the time of the check;
//   - the last component is opened without following a link (O_NOFOLLOW), and
//     without blocking on a FIFO (O_NONBLOCK);
//   - the opened file is checked again: it must be a regular file, the path
//     must still be canonical, and the path must still name the file that was
//     opened (same device and inode);
//   - a new file is created exclusively (O_EXCL), a temporary one under a name
//     nobody can predict.
// What stays open: Node has no openat(), so a parent folder is named by path in
// the open call itself. Someone who can already write to a parent folder can
// swap it for a link after the check and swap it back before the re-check. The
// re-check narrows that to a double swap timed inside one synchronous call
// sequence; it does not remove it.

import {
  openSync, closeSync, fstatSync, lstatSync, readSync, writeSync, ftruncateSync, fsyncSync,
  mkdirSync, readdirSync, rmSync, unlinkSync, renameSync, realpathSync, createReadStream, constants,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { PathConfineError, isInside, realPathOf } from './path-confine.js';

const O_NOFOLLOW = constants.O_NOFOLLOW || 0;
const O_NONBLOCK = constants.O_NONBLOCK || 0;

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TREE_DEPTH = 24;
export const MAX_TREE_ENTRIES = 5000;

const moved = () => new PathConfineError(409, 'That path changed while it was being used. Nothing was done; try again.');
// Two spellings of one path: a volume that stores names decomposed (HFS+) hands
// back another Unicode form than it was given, and Windows another case.
const spelled = (p) => { const n = String(p).normalize('NFC'); return process.platform === 'win32' ? n.toLowerCase() : n; };
const samePath = (a, b) => a === b || spelled(a) === spelled(b);
const notInside = () => new PathConfineError(403, 'That path leaves its folder through a link.');

/** `path` with every link resolved, when that is inside `base` (resolved too). Throws 403 otherwise. */
export function canonicalInside(base, path, { allowBase = false } = {}) {
  let realBase; let real;
  try { realBase = realPathOf(base); real = realPathOf(path); } catch { throw notInside(); }
  if (!isInside(realBase, real, { allowRoot: allowBase })) throw notInside();
  return real;
}

// The file behind `fd` is what `real` names now, and `real` is still canonical.
function verifyOpened(fd, real) {
  const opened = fstatSync(fd);
  let now;
  try { now = lstatSync(real); } catch { throw moved(); }
  if (now.isSymbolicLink() || now.dev !== opened.dev || now.ino !== opened.ino) throw moved();
  let again;
  try { again = realpathSync(real); } catch { throw moved(); }
  if (!samePath(again, real)) throw moved();
  return opened;
}

function openExisting(real, flags) {
  try { return openSync(real, flags | O_NOFOLLOW | O_NONBLOCK); }
  catch (err) {
    if (err?.code === 'ENOENT') throw new PathConfineError(404, 'File not found.');
    if (err?.code === 'ELOOP' || err?.code === 'EMLINK') throw moved();
    throw err;
  }
}

/**
 * Read one regular file inside `base`. A link is followed only by resolving it
 * first (the read is of the file it really is, inside `base`); a FIFO, a device
 * or a folder is refused without being read; a file over `maxBytes` is refused.
 * @returns a Buffer, or a string when `encoding` is given
 */
export function readConfinedFile(base, path, { maxBytes = MAX_FILE_BYTES, encoding = null } = {}) {
  const real = canonicalInside(base, path);
  const fd = openExisting(real, constants.O_RDONLY);
  try {
    const st = verifyOpened(fd, real);
    if (!st.isFile()) throw new PathConfineError(400, 'Not a regular file.');
    if (st.size > maxBytes) throw new PathConfineError(413, `That file is larger than ${Math.max(1, Math.round(maxBytes / (1024 * 1024)))} MB.`);
    const buf = Buffer.allocUnsafe(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (n <= 0) break;
      got += n;
    }
    const data = got === st.size ? buf : buf.subarray(0, got);
    return encoding ? data.toString(encoding) : data;
  } finally { try { closeSync(fd); } catch {} }
}

/**
 * A read stream of one regular file inside `base`, opened and verified the
 * same way (for files too large to read at once: transcripts).
 */
export function openConfinedStream(base, path, options = {}) {
  const real = canonicalInside(base, path);
  const fd = openExisting(real, constants.O_RDONLY);
  try {
    if (!verifyOpened(fd, real).isFile()) throw new PathConfineError(400, 'Not a regular file.');
  } catch (err) { try { closeSync(fd); } catch {} throw err; }
  return createReadStream(null, { ...options, fd, autoClose: true });
}

function writeAll(fd, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf-8');
  let at = 0;
  while (at < buf.length) at += writeSync(fd, buf, at, buf.length - at);
}

/**
 * Write one file inside `base`: created exclusively when it does not exist,
 * else opened without following a link and replaced in place (the file keeps
 * its mode and its inode; a link to it stays a link). Missing folders on the
 * way are made, and must end up where the check said.
 * @param o.exclusive refuse (409) when the file exists
 */
export function writeConfinedFile(base, path, data, { exclusive = false, mode = 0o666 } = {}) {
  const real = canonicalInside(base, path);
  const parent = dirname(real);
  mkdirSync(parent, { recursive: true });
  let parentNow;
  try { parentNow = realpathSync(parent); } catch { throw moved(); }
  if (!samePath(parentNow, parent)) throw moved();
  let fd;
  let created = false;
  try {
    fd = openSync(real, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, mode);
    created = true;
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    if (exclusive) throw new PathConfineError(409, 'File already exists.');
    fd = openExisting(real, constants.O_WRONLY);
  }
  try {
    const st = verifyOpened(fd, real);
    if (!st.isFile()) throw new PathConfineError(400, 'Not a regular file.');
    if (!created) ftruncateSync(fd, 0);
    writeAll(fd, data);
  } finally { try { closeSync(fd); } catch {} }
  return real;
}

/** Make a folder inside `base` (and the folders on the way), where the check said it would be. */
export function makeConfinedDir(base, path) {
  const real = canonicalInside(base, path);
  mkdirSync(real, { recursive: true });
  let now;
  try { now = realpathSync(real); } catch { throw moved(); }
  if (!samePath(now, real)) throw moved();
  return real;
}

/**
 * Remove the entry `path` names: a file, a folder with what is in it, or a
 * link (the link itself, never what it points to). The folder holding it is
 * resolved and, when `base` is given, must be `base` or inside it.
 * @returns false when there was nothing to remove
 */
export function removeConfinedEntry(base, path) {
  const parent = base ? canonicalInside(base, dirname(String(path)), { allowBase: true }) : realPathOf(dirname(String(path)));
  const entry = join(parent, basename(String(path)));
  let st;
  try { st = lstatSync(entry); } catch { return false; }
  // rm() never follows a link: one inside a removed folder is unlinked.
  if (st.isDirectory()) rmSync(entry, { recursive: true, force: true });
  else unlinkSync(entry);
  return true;
}

/**
 * Replace `path` with `data` through a temporary file in the same folder:
 * created exclusively under an unpredictable name, never through a link, then
 * renamed over `path` (a rename replaces a link, it does not follow it).
 * `expect` is the file's state when it was read ({ dev, ino, mtimeMs, size }):
 * a file that changed since is not overwritten (409).
 */
export function replaceFileAtomic(path, data, { mode = 0o600, expect = null } = {}) {
  const dir = realPathOf(dirname(String(path)));
  const target = join(dir, basename(String(path)));
  const tmp = join(dir, `.${basename(target)}.${randomBytes(12).toString('hex')}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, mode);
  let renamed = false;
  try {
    try {
      const st = verifyOpened(fd, tmp);
      if (!st.isFile()) throw moved();
      writeAll(fd, data);
      try { fsyncSync(fd); } catch {}
    } finally { try { closeSync(fd); } catch {} }
    if (expect) {
      let now;
      try { now = lstatSync(target); } catch { throw moved(); }
      if (now.isSymbolicLink() || now.dev !== expect.dev || now.ino !== expect.ino || now.mtimeMs !== expect.mtimeMs || now.size !== expect.size) throw moved();
    }
    renameSync(tmp, target);
    renamed = true;
  } finally {
    if (!renamed) { try { unlinkSync(tmp); } catch {} }
  }
  return target;
}

/**
 * What is below `dir`, as a tree: `{ name, path, type: 'dir' | 'file', size?,
 * real, children? }`, folders first. `dir` must be `base` or inside it.
 *   - a link is followed only when it resolves inside `base`;
 *   - a folder already on the way down (by its canonical path) is not entered
 *     again, so a link cycle ends where it closes;
 *   - only regular files and folders are listed (no FIFO, socket or device);
 *   - at most `maxDepth` levels and `maxEntries` entries: `truncated` says so.
 * @returns {{ entries: object[], truncated: boolean, count: number }}
 */
export function listConfined(base, dir, { maxDepth = MAX_TREE_DEPTH, maxEntries = MAX_TREE_ENTRIES, skip = null } = {}) {
  const state = { count: 0, truncated: false };
  let realBase; let top;
  try { realBase = realPathOf(base); top = canonicalInside(realBase, dir, { allowBase: true }); } catch { return { entries: [], truncated: false, count: 0 }; }
  const walk = (realDir, rel, depth, trail) => {
    let dirents;
    try { dirents = readdirSync(realDir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const entry of dirents) {
      if (state.count >= maxEntries) { state.truncated = true; break; }
      if (skip && skip(entry.name)) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      let real = join(realDir, entry.name);
      let st;
      try {
        if (entry.isSymbolicLink()) {
          real = realpathSync(real);
          if (!isInside(realBase, real)) continue;
        }
        st = lstatSync(real);
      } catch { continue; }
      if (st.isDirectory()) {
        if (trail.has(real)) continue; // a cycle: this folder is already on the way down
        state.count++;
        const node = { name: entry.name, path: relPath, type: 'dir', real, children: [] };
        if (depth + 1 >= maxDepth) state.truncated = true;
        else { trail.add(real); node.children = walk(real, relPath, depth + 1, trail); trail.delete(real); }
        out.push(node);
      } else if (st.isFile()) {
        state.count++;
        out.push({ name: entry.name, path: relPath, type: 'file', size: st.size, real });
      }
    }
    return out.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
  };
  const entries = walk(top, '', 0, new Set([top]));
  return { entries, truncated: state.truncated, count: state.count };
}

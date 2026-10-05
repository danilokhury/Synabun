// ═══════════════════════════════════════════
// SynaBun — careful file writes for other tools' config files
// ═══════════════════════════════════════════
//
// The rules installer edits files that belong to the user and to other CLIs
// (~/.codex/AGENTS.md, ~/.gemini/GEMINI.md, OpenCode's config.json). These
// helpers make each write all-or-nothing, keep a symlinked file a symlink,
// refuse to write through a link that points at nothing, keep a copy of what
// was there before, never read a corrupt JSON file as `{}`, and never write
// over a change someone else made since the file was read.
//
// Two SynaBun processes are kept apart by the installer's writer lock
// (lock.js), not by anything here. That last rule is for everyone who does not
// take the lock: the user's editor and the AI tools themselves. A write or a
// delete goes through only while the file still holds the bytes its caller
// looked at; a file that changed or vanished in between is CHANGED_UNDERNEATH.

import {
  chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

const MAX_LINK_HOPS = 40;

/**
 * The link that breaks the chain at `path`, as {link, target}: a symlink (the
 * path itself, or one it leads to) whose target does not exist. Null when
 * there is no such link: a file, a chain that ends in one, or nothing at all.
 */
export function findBrokenLink(path) {
  let current = path;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    let info;
    try { info = lstatSync(current); } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null; // nothing here: the caller's own case
      throw error;
    }
    if (!info.isSymbolicLink()) return null;
    const target = resolve(dirname(current), readlinkSync(current));
    let there = true;
    try { lstatSync(target); } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      there = false;
    }
    if (!there) return { link: current, target };
    current = target;
  }
  return null; // a loop: realpath reports it
}

function brokenLinkError(path, broken) {
  const through = broken.link === path ? '' : ` (reached through ${path})`;
  const error = new Error(`${broken.link}${through} is a symbolic link to ${broken.target}, which does not exist. SynaBun does not write through a broken link: fix or remove the link, then try again.`);
  error.code = 'BROKEN_LINK';
  error.path = path;
  error.link = broken.link;
  error.target = broken.target;
  return error;
}

/**
 * Where a write to `path` really lands: the file at the end of its symlinks,
 * or `path` itself when nothing is there yet. The chain is followed hop by
 * hop, and a link whose target does not exist is refused (BROKEN_LINK): with
 * a -> b -> c and no c, a write must not land on `b` and replace that link.
 */
export function resolveWriteTarget(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const broken = findBrokenLink(path);
  if (broken) throw brokenLinkError(path, broken);
  return path;
}

/** What `path` holds right now (through a symlink), or null when there is no file. */
export function readBytes(path) {
  try {
    return readFileSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function isLink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function sameContent(current, expected) {
  if (expected === null) return current === null;
  if (current === null) return false;
  return Buffer.isBuffer(expected) ? current.equals(expected) : current.toString('utf8') === String(expected);
}

function changedError(path) {
  const error = new Error(`${path} changed while SynaBun was about to write it, so nothing was written. Try again.`);
  error.code = 'CHANGED_UNDERNEATH';
  error.path = path;
  return error;
}
/** True for "there is no such file": the file itself, or a directory on the way to it. */
function isGone(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

/**
 * Write `text` (a string, or a Buffer for exact bytes) to `path` in one step:
 * a temp file beside the target, fsync, rename. A symlinked target stays a
 * link (the file it points at is replaced), a link that points at nothing is
 * refused (BROKEN_LINK), and an existing file keeps its mode. The parent
 * directory must exist. Returns the path that was written.
 *
 * `expect` is what the caller read before it worked out `text`: a string, a
 * Buffer, or null for "no file". Right before the rename the file is read
 * again, and when it no longer holds that, nothing is written and the call
 * throws CHANGED_UNDERNEATH: another writer's change is never lost.
 * `beforeRename` runs just before that check (a seam for tests).
 */
export function writeTextAtomic(path, text, { expect, beforeRename } = {}) {
  const target = resolveWriteTarget(path);
  let mode = null;
  try { mode = statSync(target).mode & 0o7777; } catch { /* new file */ }
  const temp = join(dirname(target), `.${basename(target)}.synabun-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  let fd;
  try { fd = openSync(temp, 'wx', mode ?? 0o644); } catch (error) {
    // The caller read a file here and its directory is gone by now: the file went with it.
    if (isGone(error) && expect !== undefined && expect !== null) throw changedError(path);
    throw error;
  }
  try {
    if (Buffer.isBuffer(text)) writeSync(fd, text);
    else writeSync(fd, String(text), null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (mode !== null) chmodSync(temp, mode);
    if (beforeRename) beforeRename(path);
    // A rename onto a link replaces the link. `target` was a file (or nothing) when it was resolved; a link there by
    // now was put there since.
    if (isLink(target)) throw changedError(path);
    if (expect !== undefined && !sameContent(readBytes(target), expect)) throw changedError(path);
    renameSync(temp, target);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* nothing left to clean */ }
    throw error;
  }
  try {
    const dirFd = openSync(dirname(target), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* directories cannot be fsynced on every platform */ }
  return target;
}

/**
 * Delete `path`, but only while it still holds `expect` (see writeTextAtomic).
 * Never follows or removes a symlink. A file that is gone already, before the
 * look or between the look and the delete, is CHANGED_UNDERNEATH like any
 * other change, never a raw ENOENT. `beforeUnlink` runs before the look and
 * `afterCheck` between the look and the delete (seams for tests).
 */
export function unlinkIfUnchanged(path, expect, { beforeUnlink, afterCheck } = {}) {
  if (beforeUnlink) beforeUnlink(path);
  let info;
  try { info = lstatSync(path); } catch (error) {
    if (isGone(error)) throw changedError(path);
    throw error;
  }
  if (info.isSymbolicLink() || !sameContent(readBytes(path), expect)) throw changedError(path);
  if (afterCheck) afterCheck(path);
  try { unlinkSync(path); } catch (error) {
    if (isGone(error)) throw changedError(path);
    throw error;
  }
}

function backupStamp(date) {
  return date.toISOString().replace(/[-:.]/g, '');
}

/**
 * Copy `path` into `backupDir` before it is changed and keep the newest `keep`
 * copies of that file: older ones made here for the same file are deleted,
 * and no other file ever is (the names are matched by their prefix and `.bak`).
 * Returns the backup path, or null when there is nothing to copy. Two files
 * with the same name in different directories never share backups: the name
 * carries a hash of the full path.
 */
export function backupFile(path, backupDir, keep = 10) {
  if (!existsSync(path)) return null;
  mkdirSync(backupDir, { recursive: true });
  const prefix = `${basename(path)}.${createHash('sha256').update(resolve(path)).digest('hex').slice(0, 8)}.`;
  const stamp = backupStamp(new Date());
  // A backup's place in time: its stamp, then its number within that millisecond (`<stamp>.bak` is 0, `<stamp>-03.bak` is 3).
  const order = (entry) => {
    const match = /^([^-]*)(?:-(\d+))?\.bak$/.exec(entry.slice(prefix.length));
    return match ? [match[1], Number(match[2] || 0)] : [entry.slice(prefix.length), 0];
  };
  const listMine = () => readdirSync(backupDir).filter((entry) => entry.startsWith(prefix) && entry.endsWith('.bak'));
  // One past the highest number this millisecond already has. Never the first free name: an earlier copy of the same
  // millisecond may have been pruned, and taking its name would make this copy, the newest, sort as the oldest.
  const sameStamp = listMine().filter((entry) => order(entry)[0] === stamp).map((entry) => order(entry)[1]);
  const number = sameStamp.length ? Math.max(...sameStamp) + 1 : 0;
  const name = number === 0 ? `${prefix}${stamp}.bak` : `${prefix}${stamp}-${String(number).padStart(2, '0')}.bak`;
  const backupPath = join(backupDir, name);
  try { copyFileSync(path, backupPath); } catch (error) {
    // Gone since the look above: nothing to copy, and the conditional write that follows says so.
    if (isGone(error) && !existsSync(path)) return null;
    throw error;
  }
  // Oldest first.
  const mine = listMine().sort((a, b) => {
    const [stampA, numberA] = order(a);
    const [stampB, numberB] = order(b);
    return stampA < stampB ? -1 : stampA > stampB ? 1 : numberA - numberB;
  });
  for (const old of mine.slice(0, Math.max(0, mine.length - Math.max(1, keep)))) {
    try { unlinkSync(join(backupDir, old)); } catch { /* an old backup we could not prune is harmless */ }
  }
  return backupPath;
}

/**
 * Parse a JSON file or throw. A missing file, an empty file, comments and
 * syntax errors all throw (code ENOENT or INVALID_JSON): a caller that is
 * about to rewrite the file must never mistake a broken one for `{}`.
 * `text` parses what the caller already read instead of reading again.
 */
export function readJsonStrict(path, { text } = {}) {
  const raw = (text ?? readFileSync(path, 'utf8')).replace(/^\uFEFF/, '');
  try {
    return JSON.parse(raw);
  } catch (cause) {
    const error = new Error(`${path} is not valid JSON: ${cause.message}`);
    error.code = 'INVALID_JSON';
    error.path = path;
    throw error;
  }
}

// ═══════════════════════════════════════════
// SynaBun — Git for Windows: fetch, check, unpack, put in place
// ═══════════════════════════════════════════
//
// How the pinned Git for Windows (pins.js) gets onto a disk. One sequence, used
// by the running application on a Windows npm install (manager.js, into the
// data home) and, from the unpacking on, by an application build
// (packaging/lib/git-bash.mjs, into the Windows payload):
//
//   download        the release file, over HTTPS and nothing else (every
//                   redirect too), stopped at the pinned size, compared with
//                   the pinned SHA-256 (cloudflared/install.js downloadPinned).
//                   A file that does not match is removed: nothing of it is
//                   ever unpacked
//   extractArchive  the .tar.bz2 read by this application itself (bzip2.js,
//                   then the tar reader below), never by a tar program: what a
//                   Windows 10 tar.exe can read differs from build to build.
//                   Every name is checked before it is used as a path; links
//                   other than the pinned `skip` ones are refused
//   treeDigest      what was unpacked, compared with the pinned tree: its
//                   number of files, their bytes, and one SHA-256 over every
//                   file's path, size and SHA-256
//   installGitBash  all of it in a work folder of its own beside the
//                   destination, the license and source files and the marker
//                   added, then one rename: the destination holds the whole
//                   checked tree or nothing
//
// A work folder an earlier attempt left (a download stopped, a server that was
// closed while it unpacked) is removed by the next attempt (sweepStaleWork):
// every attempt can be repeated. The unpacking and the digest run in a worker
// thread (extract-worker.js) when the server does it, so its event loop never
// waits for them.
//
// Only node: modules and this application's own files here (see pins.js).

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { downloadPinned, ownFolder, sweepStaleWork } from '../cloudflared/install.js';
import { bunzip2Blocks } from './bzip2.js';
import { ADDED_FILES, inTree, isTreePath, licenseText, MARKER, sourceText } from './pins.js';

/** What can go wrong, by the name the page shows a sentence for. */
export const GIT_BASH_ERROR_CODES = Object.freeze([
  'unsupported',   // there is no Git for Windows for this system (not Windows, or not pinned for its processor)
  'offline',       // the download server was not reached
  'http',          // it answered, but not with the file
  'interrupted',   // the transfer ended before the file did
  'timeout',       // nothing arrived for too long
  'checksum',      // what arrived, or what was unpacked, is not the pinned file
  'unpack',        // the archive could not be read, or holds something it must not
  'disk',          // the data home could not be written (no room, no permission)
  'cancelled',     // stopped on request
]);

export class GitBashError extends Error {
  /** @param {string} code one of GIT_BASH_ERROR_CODES */
  constructor(code, message, { cause, detail } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GitBashError';
    this.code = GIT_BASH_ERROR_CODES.includes(code) ? code : 'disk';
    if (detail) this.detail = detail;
  }
}

const WORK_PREFIX = '.work-';
const DISK_CODES = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EDQUOT', 'EMFILE', 'ENFILE', 'ENOTDIR', 'EISDIR', 'EBUSY', 'ENAMETOOLONG']);
const codeOf = (error) => error?.code || error?.cause?.code || '';

/** Any failure as a GitBashError: what it says it is (a download's, the reader's), or `fallback`. */
export function asGitBashError(error, fallback = 'disk', message = 'Git for Windows could not be put in place.') {
  if (error instanceof GitBashError) return error;
  if (error?.name === 'CloudflaredError' && GIT_BASH_ERROR_CODES.includes(error.code)) return new GitBashError(error.code, error.message, { cause: error, detail: error.detail });
  if (error?.name === 'Bzip2Error') return new GitBashError('unpack', error.message, { cause: error });
  const code = codeOf(error);
  if (DISK_CODES.has(code)) return new GitBashError('disk', `The data folder could not be written (${code}).`, { cause: error, detail: code });
  return new GitBashError(fallback, message, { cause: error, detail: code || error?.message || String(error) });
}

const cancelled = () => new GitBashError('cancelled', 'Stopped.');

// ── The tar reader ──────────────────────────────────────────────────────────

const BLOCK = 512;
const text = (block, from, to) => {
  const end = block.indexOf(0, from);
  return block.toString('utf8', from, end === -1 || end > to ? to : end);
};
const octal = (block, from, to) => {
  if (block[from] & 0x80) {   // base-256, for sizes octal cannot hold
    let value = 0;
    for (let i = from + 1; i < to; i++) value = value * 256 + block[i];
    return value;
  }
  const field = text(block, from, to).trim();
  return field ? parseInt(field, 8) : 0;
};

/** One header block: its name, size, type, link and mode, checksum checked. */
function readHeader(block) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
  if (octal(block, 148, 156) !== sum) throw new GitBashError('unpack', 'The archive is not a tar archive (a header checksum does not match).');
  const size = octal(block, 124, 136);
  if (!Number.isSafeInteger(size) || size < 0) throw new GitBashError('unpack', 'The archive names an entry without a size.');
  // POSIX ustar keeps a prefix of the name at 345; the GNU format keeps other fields there.
  const posixMagic = block.toString('latin1', 257, 263) === 'ustar\0';
  const prefix = posixMagic ? text(block, 345, 500) : '';
  return {
    name: `${prefix ? `${prefix}/` : ''}${text(block, 0, 100)}`,
    size,
    type: String.fromCharCode(block[156] || 0x30),
    link: text(block, 157, 257),
    mode: octal(block, 100, 108),
  };
}

/** The records of a PAX extended header: `path`, `linkpath`, `size` are the ones that change an entry. */
function paxRecords(data) {
  const out = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space === -1) break;
    const length = parseInt(data.toString('latin1', at, space), 10);
    if (!Number.isInteger(length) || length <= 0 || at + length > data.length) throw new GitBashError('unpack', 'The archive has an extended header it cannot read.');
    const record = data.toString('utf8', space + 1, at + length - 1);
    const equals = record.indexOf('=');
    if (equals > 0) out[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return out;
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/** A name of the archive as a path inside the tree, or a refusal: nothing outside it, nothing Windows reads otherwise. */
function treePathOf(name) {
  const clean = String(name).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!isTreePath(clean) || clean.split('/').some((part) => RESERVED.test(part))) {
    throw new GitBashError('unpack', `The archive names a path that has no place in the tree (${JSON.stringify(String(name).slice(0, 120))}).`);
  }
  return clean;
}

/**
 * Unpack the .tar.bz2 at `archive` into `destination` (a new, empty folder of the caller's). Regular files,
 * folders and hard links are written; an entry whose path is in `skip` is left out, and any other link or
 * special file stops the read. Synchronous: the server runs it in a worker thread (extract-worker.js).
 *
 * @param {object} o
 * @param {string} o.archive
 * @param {string} o.destination
 * @param {string[]} [o.skip] paths of the tree to leave out (the pin's)
 * @param {() => boolean} [o.stopped] asked between blocks: true stops the read (`cancelled`)
 * @param {(progress: { consumed: number, total: number }) => void} [o.onProgress]
 * @param {string} [o.platform] the separators to write in (process.platform)
 * @returns {{ files: number, folders: number, links: number, skipped: string[] }}
 */
export function extractArchive({ archive, destination, skip = [], stopped = () => false, onProgress = () => {}, platform = process.platform }) {
  const leaveOut = new Set(skip);
  const written = new Set();   // tree paths of the regular files written (a hard link names one of them)
  const made = new Set(['']);
  const result = { files: 0, folders: 0, links: 0, skipped: [] };
  const folder = (rel) => {
    if (made.has(rel)) return;
    mkdirSync(inTree(destination, rel, platform), { recursive: true });
    for (let at = rel; at && !made.has(at); at = at.includes('/') ? at.slice(0, at.lastIndexOf('/')) : '') made.add(at);
  };
  const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

  let input;
  try { input = readFileSync(archive); } catch (error) { throw asGitBashError(error, 'unpack', 'The archive could not be read.'); }

  let pending = Buffer.alloc(0);
  let mode = 'header';   // header | data | skip | meta | end
  let left = 0;          // bytes of the current entry's data still to come
  let padding = 0;
  let fd = null;
  let meta = null;       // { kind: 'L' | 'K' | 'x', parts: Buffer[] } while a GNU long name or a PAX header is read
  let longName = null;
  let longLink = null;
  let pax = null;
  let current = null;    // the tree path of the file being written
  const closeFile = () => { if (fd !== null) { closeSync(fd); fd = null; } };

  const startEntry = (header) => {
    if (header.type === 'L' || header.type === 'K' || header.type === 'x' || header.type === 'g') {
      if (header.size > 1024 * 1024) throw new GitBashError('unpack', 'The archive has an extended header that is too large.');
      meta = { kind: header.type, parts: [] };
      left = header.size;
      padding = (BLOCK - (header.size % BLOCK)) % BLOCK;
      mode = header.size ? 'meta' : 'header';
      if (!header.size) finishMeta();
      return;
    }
    const name = pax?.path ?? longName ?? header.name;
    const link = pax?.linkpath ?? longLink ?? header.link;
    const size = pax?.size !== undefined ? Number(pax.size) : header.size;
    longName = null; longLink = null; pax = null;
    if (!Number.isSafeInteger(size) || size < 0) throw new GitBashError('unpack', 'The archive names an entry without a size.');
    padding = (BLOCK - (size % BLOCK)) % BLOCK;
    left = size;
    const rel = treePathOf(name);
    if (leaveOut.has(rel)) {
      result.skipped.push(rel);
      mode = size + padding ? 'skip' : 'header';
      left = size + padding;
      return;
    }
    const type = header.type;
    if (type === '5' || ((type === '0' || type === '\0') && String(name).endsWith('/'))) {
      folder(rel);
      result.folders++;
      mode = size + padding ? 'skip' : 'header';
      left = size + padding;
      return;
    }
    if (type === '0' || type === '\0' || type === '7') {
      if (written.has(rel)) throw new GitBashError('unpack', `The archive holds ${rel} twice.`);
      folder(parentOf(rel));
      const path = inTree(destination, rel, platform);
      fd = openSync(path, 'wx', platform === 'win32' ? undefined : ((header.mode & 0o111) ? 0o755 : 0o644));
      current = rel;
      written.add(rel);
      result.files++;
      if (!size) { closeFile(); mode = padding ? 'skip' : 'header'; left = padding; } else mode = 'data';
      return;
    }
    if (type === '1') {
      const target = treePathOf(link);
      if (!written.has(target)) throw new GitBashError('unpack', `The archive links ${rel} to ${target}, which it does not hold.`);
      if (written.has(rel)) throw new GitBashError('unpack', `The archive holds ${rel} twice.`);
      folder(parentOf(rel));
      const from = inTree(destination, target, platform);
      const to = inTree(destination, rel, platform);
      // A file system without hard links (FAT, exFAT) gets a copy: the same bytes either way.
      try { linkSync(from, to); } catch { copyFileSync(from, to, constants.COPYFILE_EXCL); }
      written.add(rel);
      result.links++;
      mode = size + padding ? 'skip' : 'header';
      left = size + padding;
      return;
    }
    if (type === '2') throw new GitBashError('unpack', `The archive has a link ${rel} the pins do not leave out.`);
    throw new GitBashError('unpack', `The archive has an entry of a kind that has no place in the tree (${rel}, type ${JSON.stringify(type)}).`);
  };

  function finishMeta() {
    const data = Buffer.concat(meta.parts);
    if (meta.kind === 'L') longName = text(data, 0, data.length);
    else if (meta.kind === 'K') longLink = text(data, 0, data.length);
    else if (meta.kind === 'x') pax = paxRecords(data);
    meta = null;
  }

  try {
    for (const chunk of bunzip2Blocks(input, { progress: (consumed, total) => onProgress({ consumed, total }) })) {
      if (stopped()) throw cancelled();
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let at = 0;
      while (at < pending.length && mode !== 'end') {
        if (mode === 'header') {
          if (pending.length - at < BLOCK) break;
          const block = pending.subarray(at, at + BLOCK);
          at += BLOCK;
          if (block.every((byte) => byte === 0)) { mode = 'end'; break; }
          startEntry(readHeader(block));
          continue;
        }
        const take = Math.min(left, pending.length - at);
        if (mode === 'data') {
          let off = at;
          while (off < at + take) off += writeSync(fd, pending, off, at + take - off);
          left -= take;
          at += take;
          if (left === 0) { closeFile(); current = null; mode = padding ? 'skip' : 'header'; left = padding; }
          continue;
        }
        if (mode === 'meta') {
          meta.parts.push(Buffer.from(pending.subarray(at, at + take)));
          left -= take;
          at += take;
          if (left === 0) { finishMeta(); mode = padding ? 'skip' : 'header'; left = padding; }
          continue;
        }
        // skip: what is left of an entry that is not written, or a padding
        left -= take;
        at += take;
        if (left === 0) mode = 'header';
      }
      pending = at < pending.length ? Buffer.from(pending.subarray(at)) : Buffer.alloc(0);
      if (mode === 'end') break;
    }
    if (mode !== 'end') throw new GitBashError('unpack', current ? `The archive ends inside ${current}.` : 'The archive ends before its last entry.');
    return result;
  } catch (error) {
    throw asGitBashError(error, 'unpack', 'The archive could not be unpacked.');
  } finally {
    closeFile();
  }
}

// ── What was unpacked ───────────────────────────────────────────────────────

/** SHA-256 of a file, read whole (the tree's files are at most a few tens of MB). */
const sha256Of = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * What a tree is: every file under `root` (forward-slash paths, JavaScript string order), its count, its bytes,
 * and the SHA-256 over one line `path NUL size NUL sha256 LF` per file. The names of `exclude` at the top are
 * left out (what SynaBun adds). A link, or anything that is neither a file nor a folder, is a refusal: the
 * pinned tree has none. Synchronous (a worker thread runs it for the server).
 * @returns {{ files: number, bytes: number, sha256: string }}
 */
export function treeDigest(root, { exclude = ADDED_FILES, stopped = () => false } = {}) {
  const files = [];
  const walk = (rel) => {
    for (const entry of readdirSync(rel ? join(root, ...rel.split('/')) : root, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && exclude.includes(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new GitBashError('checksum', `The tree holds a link (${path}); the pinned one has none.`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
      else throw new GitBashError('checksum', `The tree holds something that is not a file (${path}).`);
    }
  };
  walk('');
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash('sha256');
  let bytes = 0;
  for (const rel of files) {
    if (stopped()) throw cancelled();
    const data = readFileSync(join(root, ...rel.split('/')));
    bytes += data.length;
    hash.update(`${rel}\0${data.length}\0${createHash('sha256').update(data).digest('hex')}\n`);
  }
  return { files: files.length, bytes, sha256: hash.digest('hex') };
}

/** Is a digest the pinned tree? null when it is, otherwise what differs, as a sentence. */
export function treeMismatch(digest, pin) {
  if (digest.files !== pin.tree.files) return `${digest.files} files, the pinned tree has ${pin.tree.files}`;
  if (digest.bytes !== pin.tree.bytes) return `${digest.bytes} bytes, the pinned tree has ${pin.tree.bytes}`;
  if (digest.sha256 !== pin.tree.sha256) return 'files with other contents than the pinned tree';
  return null;
}

/** The files SynaBun starts (the pin's `key`), each its pinned size and SHA-256? null when so, else the first that is not. */
export function keyFilesMismatch(root, pin, { platform = process.platform } = {}) {
  for (const [rel, want] of Object.entries(pin.keyFiles)) {
    const path = inTree(root, rel, platform);
    let info;
    try { info = lstatSync(path); } catch { return `${rel} is missing`; }
    if (info.isSymbolicLink() || !info.isFile()) return `${rel} is not a file`;
    if (info.size !== want.size) return `${rel} has ${info.size} bytes, the pinned one ${want.size}`;
    if (sha256Of(path) !== want.sha256) return `${rel} is not the pinned file`;
  }
  return null;
}

/** The marker of a copy, read; null when there is none or it cannot be read. */
export function readMarker(root) {
  try {
    const marker = JSON.parse(readFileSync(join(root, MARKER), 'utf8'));
    return marker && typeof marker === 'object' ? marker : null;
  } catch { return null; }
}

/**
 * Is the copy at `root` the pinned one, as far as a look that costs nothing can tell? Its marker names this very
 * release file and tree (the marker is written only after the whole tree passed its digest), and the files
 * SynaBun starts are there, each the pinned file. `{ ok, reason }`, `reason` one of missing, marker, key.
 */
export function checkInstalled(root, pin, { platform = process.platform } = {}) {
  try {
    if (!statSync(root).isDirectory()) return { ok: false, reason: 'missing' };
  } catch { return { ok: false, reason: 'missing' }; }
  const marker = readMarker(root);
  if (!marker || marker.synabunGit !== 1 || marker.version !== pin.version || marker.sha256 !== pin.sha256 || marker.tree?.sha256 !== pin.tree.sha256) {
    return { ok: false, reason: 'marker' };
  }
  const key = keyFilesMismatch(root, pin, { platform });
  return key ? { ok: false, reason: 'key', detail: key } : { ok: true, reason: null };
}

/** The license, source and marker files SynaBun adds at the top of its copy (after the tree passed its digest). */
export function writeAddedFiles(root, { pins, pin, source, digest, now = () => new Date().toISOString(), licensesDir } = {}) {
  for (const name of ADDED_FILES) {
    if (existsSync(join(root, name))) throw new GitBashError('unpack', `The archive holds ${name}, a name SynaBun adds itself: the pins need a look.`);
  }
  writeFileSync(join(root, 'LICENSE.txt'), licenseText(licensesDir));
  writeFileSync(join(root, 'SOURCE.txt'), sourceText(pins, pin));
  writeFileSync(join(root, MARKER), `${JSON.stringify({
    synabunGit: 1,
    name: pins.name,
    version: pin.version,
    tag: pin.tag,
    file: pin.file,
    sha256: pin.sha256,
    tree: digest,
    source,
    placedAt: now(),
  }, null, 2)}\n`);
}

/**
 * Unpack and check, in one go: the tree of `archive` in `destination`, compared with the pin, the added files
 * written. Synchronous: what the worker thread runs, and what a build runs as it is.
 * @returns {{ files: number, folders: number, links: number, skipped: string[], digest: object }}
 */
export function unpackAndCheck({ archive, destination, pins, pin, source, stopped, onProgress, onStep = () => {}, platform = process.platform, licensesDir }) {
  onStep('extract');
  const unpacked = extractArchive({ archive, destination, skip: pin.skip, stopped, onProgress, platform });
  // The tree's empty folders (MSYS2's /dev/shm, /dev/mqueue): there whatever the archive held of them.
  for (const rel of pin.folders || []) mkdirSync(inTree(destination, rel, platform), { recursive: true });
  onStep('verify');
  const digest = treeDigest(destination, { stopped });
  const wrong = treeMismatch(digest, pin);
  if (wrong) throw new GitBashError('checksum', `What the archive unpacked to is not the pinned tree (${wrong}). It was removed.`, { detail: wrong });
  const key = keyFilesMismatch(destination, pin, { platform });
  if (key) throw new GitBashError('checksum', `What the archive unpacked to is not the pinned tree (${key}). It was removed.`, { detail: key });
  writeAddedFiles(destination, { pins, pin, source, digest, licensesDir });
  return { ...unpacked, digest };
}

/**
 * unpackAndCheck in a worker thread: the server's event loop is not held for the minute it takes. `data` is what
 * unpackAndCheck takes, without its functions (it is copied into the thread); a stop on `signal` is seen by the
 * worker between two blocks, which then closes what it has open and answers `cancelled`.
 */
export function unpackInWorker(data, { signal, onProgress = () => {}, onStep = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const flag = new Int32Array(new SharedArrayBuffer(4));
    let worker;
    try {
      worker = new Worker(new URL('./extract-worker.js', import.meta.url), { workerData: { ...data, flag } });
    } catch (error) {
      reject(asGitBashError(error, 'unpack', 'The archive could not be unpacked (no worker).'));
      return;
    }
    const onAbort = () => Atomics.store(flag, 0, 1);
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    worker.on('message', (message) => {
      if (message?.type === 'progress') onProgress(message.progress);
      else if (message?.type === 'step') onStep(message.step);
      else if (message?.type === 'done') finish(resolve, message.result);
      else if (message?.type === 'error') finish(reject, new GitBashError(message.code, message.message, { detail: message.detail }));
    });
    worker.on('error', (error) => finish(reject, asGitBashError(error, 'unpack', 'The archive could not be unpacked.')));
    worker.on('exit', (code) => finish(reject, new GitBashError('unpack', `The unpacking stopped (${code}).`)));
  });
}

/** Renaming a folder on Windows can meet a file an antivirus scanner holds open for a moment: try again, briefly. */
async function renameWithRetry(from, to, { tries = 6, wait = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { renameSync(from, to); return; } catch (error) {
      if (attempt >= tries || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
      await wait(150 * attempt);
    }
  }
}

/**
 * Download the pinned Git for Windows and put it at `<root>/<version>/`. Everything happens in a work folder of
 * this attempt inside `root`, removed whatever the outcome; the tree is renamed into place only after the release
 * file matched its SHA-256 and the unpacked tree its digest, so the place holds the whole checked tree or
 * nothing. A copy already there that checks out (another process won) is the result; one that does not is
 * replaced. `root` is SynaBun's own folder (0700 where the system has modes). One attempt at a time per process
 * is the caller's business (manager.js).
 *
 * @param {object} o
 * @param {object} o.pins  pins.js readGitBashPins()
 * @param {object} o.pin   gitBashPinFor()
 * @param {string} o.root  DATA_HOME/runtime/git
 * @param {(step: 'download' | 'extract' | 'verify' | 'place') => void} [o.onStep]
 * @param {(p: { phase: string, received?: number, total: number, consumed?: number }) => void} [o.onProgress]
 * @param {boolean} [o.worker] unpack in a worker thread (true for the server; tests and builds run it inline)
 * @param {Function} [o.unpack] what unpacks (data, { signal, onProgress, onStep }): unpackInWorker or unpackAndCheck
 * @returns {Promise<{ path: string, version: string }>}
 */
export async function installGitBash({ pins, pin, root, fetchImpl, signal, onStep = () => {}, onProgress = () => {}, stallMs, worker = true, unpack = null, platform = process.platform, licensesDir }) {
  const directory = join(root, pin.version);
  let work = null;
  try {
    mkdirSync(dirname(root), { recursive: true });
    ownFolder(root);
    sweepStaleWork(root);
    work = join(root, `${WORK_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}`);
    mkdirSync(work, { mode: 0o700 });
    const releaseFile = join(work, 'release.part');
    onStep('download');
    await downloadPinned({ pin, destination: releaseFile, fetchImpl, signal, stallMs, onProgress: ({ received, total }) => onProgress({ phase: 'download', received, total }) });
    if (signal?.aborted) throw cancelled();
    const tree = join(work, 'tree');
    mkdirSync(tree);
    const options = { archive: releaseFile, destination: tree, pins, pin, source: 'downloaded', platform, licensesDir };
    const report = ({ consumed, total }) => onProgress({ phase: 'extract', consumed, total });
    const run = unpack || (worker
      ? unpackInWorker
      : (data, o) => unpackAndCheck({ ...data, stopped: () => !!o.signal?.aborted, onProgress: o.onProgress, onStep: o.onStep }));
    await run(options, { signal, onProgress: report, onStep });
    if (signal?.aborted) throw cancelled();
    rmSync(releaseFile, { force: true });
    onStep('place');
    if (existsSync(directory)) {
      if (checkInstalled(directory, pin, { platform }).ok) return { path: directory, version: pin.version };
      rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    }
    await renameWithRetry(tree, directory);
    return { path: directory, version: pin.version };
  } catch (error) {
    throw asGitBashError(error);
  } finally {
    if (work) { try { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); } catch { /* the next attempt sweeps it */ } }
  }
}

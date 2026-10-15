// ═══════════════════════════════════════════
// SynaBun — cloudflared: fetch, check, unpack, put in place
// ═══════════════════════════════════════════
//
// How a pinned cloudflared (pins.js) gets onto a disk. One sequence, used by
// the running application (manager.js, into the data home) and, from the
// unpacking on, by an application build (packaging/lib/stage.mjs):
//
//   downloadPinned      the release file, over HTTPS and nothing else (every
//                       redirect too), into a file of its own; stopped at the
//                       pinned size, then compared with the pinned SHA-256
//   binaryFromRelease   the cloudflared of that file: the file itself, or the
//                       one member of the archive, read out by this module
//                       (no tar program is started, no name in the archive is
//                       ever used as a path); compared with the pinned SHA-256
//                       of the binary, then made executable
//   installCloudflared  both, in a folder of its own beside the destination,
//                       and one rename at the end: the destination holds the
//                       whole checked binary or nothing
//
// A file that fails a check is removed in the same step and never renamed into
// place; whatever a stopped process left behind is removed by the next attempt
// (sweepStaleWork). Every failure is a CloudflaredError with a `code` the page
// has words for.
//
// SynaBun's own folder for its copy (DATA_HOME/runtime/cloudflared) is one only
// its owner can open (0700, ownFolder); nothing is put in it through a link. A
// copy that is about to run is checked where it lies (unsafePlace: no link, no
// folder others may write) and hashed through one handle opened without
// following a link (checkCloudflared), which says what file it read
// (fileIdentity): manager.js compares that with the file once more as it is
// started.
//
// Only node: modules here (see pins.js).

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, constants, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { copyFile, lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createGunzip } from 'node:zlib';

/** What can go wrong, by the name the page shows a sentence for. */
export const CLOUDFLARED_ERROR_CODES = Object.freeze([
  'unsupported',   // Cloudflare publishes no cloudflared for this system
  'offline',       // the download server was not reached
  'http',          // it answered, but not with the file
  'interrupted',   // the transfer ended before the file did
  'timeout',       // nothing arrived for too long
  'checksum',      // what arrived is not the pinned file
  'unpack',        // the archive does not hold the pinned binary
  'disk',          // the data home could not be written (no room, no permission)
  'cancelled',     // stopped on request
]);

export class CloudflaredError extends Error {
  /** @param {string} code one of CLOUDFLARED_ERROR_CODES */
  constructor(code, message, { cause, detail } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CloudflaredError';
    this.code = code;
    if (detail) this.detail = detail;
  }
}

const WORK_PREFIX = '.work-';
const STALE_WORK_MS = 60 * 60 * 1000;
const MAX_REDIRECTS = 5;
const DISK_CODES = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EDQUOT', 'EMFILE', 'ENFILE', 'ENOTDIR', 'EISDIR', 'EEXIST']);
const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);

const codeOf = (error) => error?.code || error?.cause?.code || error?.cause?.cause?.code || '';

/** A failure as a CloudflaredError: what it already is, or what its cause says it is, or `fallback`. */
function asCloudflaredError(error, fallback, message) {
  if (error instanceof CloudflaredError) return error;
  const code = codeOf(error);
  if (DISK_CODES.has(code)) return new CloudflaredError('disk', `The data folder could not be written (${code}).`, { cause: error, detail: code });
  if (NETWORK_CODES.has(code)) return new CloudflaredError('offline', `The download server could not be reached (${code}).`, { cause: error, detail: code });
  return new CloudflaredError(fallback, message, { cause: error, detail: code || error?.message || String(error) });
}

/** SHA-256 and size of a file, read as a stream. */
export function hashFile(path, { signal } = {}) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    let size = 0;
    const stream = createReadStream(path, { signal });
    stream.on('data', (chunk) => { hash.update(chunk); size += chunk.length; });
    stream.on('error', fail);
    stream.on('end', () => done({ sha256: hash.digest('hex'), size }));
  });
}

/** SHA-256 and size of what an open file holds, read from its start. */
async function hashHandle(handle, { signal } = {}) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let size = 0;
  for (;;) {
    if (signal?.aborted) throw new CloudflaredError('cancelled', 'Stopped.');
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead));
    size += bytesRead;
  }
  return { sha256: hash.digest('hex'), size };
}

/** Opening a file without following a link at its last part, where the system has that (not Windows: asked with lstat first). */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * What a file is, from a stat taken with `{ bigint: true }`: the same identity is the same file with the same bytes
 * (any write changes its change time, and no program can set that back).
 */
export function fileIdentity(info) {
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs };
}

/** Are two fileIdentity() the same file, unchanged? */
export function sameFile(a, b) {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/**
 * Is the file at `path` the pinned binary? Its size first, then its SHA-256, read through one handle opened without
 * following a link at `path` (a link there is `link`, never what it points to). The file is compared before and
 * after the read, and with what `path` names once it is read: `changed` when either differs. `file` is the
 * identity (fileIdentity) of the file the handle opened, whose bytes were read (or could not be: `unreadable`).
 * @returns {Promise<{ ok: boolean, reason: 'missing' | 'link' | 'not-a-file' | 'size' | 'sha256' | 'changed' | 'unreadable' | null, file?: object }>}
 */
export async function checkCloudflared(path, pin, { signal } = {}) {
  let handle;
  try {
    if (!NO_FOLLOW && (await lstat(path)).isSymbolicLink()) return { ok: false, reason: 'link' };
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    const code = error?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing' };
    if (code === 'ELOOP' || code === 'EMLINK') return { ok: false, reason: 'link' };
    if (code === 'EISDIR') return { ok: false, reason: 'not-a-file' };
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return { ok: false, reason: 'not-a-file' };
    const file = fileIdentity(before);
    if (before.size !== BigInt(pin.binary.size)) return { ok: false, reason: 'size', file };
    let sha256;
    try {
      ({ sha256 } = await hashHandle(handle, { signal }));
    } catch (error) {
      if (signal?.aborted) throw new CloudflaredError('cancelled', 'Stopped.', { cause: error });
      return { ok: false, reason: 'unreadable', file };
    }
    // Written to while it was read, or no longer the file `path` names: what was read is not what is there.
    const after = fileIdentity(await handle.stat({ bigint: true }));
    let named = null;
    try { named = fileIdentity(await lstat(path, { bigint: true })); } catch { /* gone meanwhile */ }
    if (!sameFile(file, after) || !sameFile(file, named)) return { ok: false, reason: 'changed', file };
    return sha256 === pin.binary.sha256 ? { ok: true, reason: null, file } : { ok: false, reason: 'sha256', file };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Is the file at `path` the pinned binary? checkCloudflared, without the identity.
 * @returns {Promise<{ ok: boolean, reason: 'missing' | 'link' | 'not-a-file' | 'size' | 'sha256' | 'changed' | 'unreadable' | null }>}
 */
export async function verifyCloudflared(path, pin, options) {
  const { ok, reason } = await checkCloudflared(path, pin, options);
  return { ok, reason };
}

/**
 * Is `path`, a cloudflared in SynaBun's own folder `area`, kept where nobody else can change it? Each step from the
 * file up to `area` (both included) is looked at without following a link. null when every one is safe; otherwise
 * the first that is not, `{ reason, at }`: `missing`, `link`, `not-a-file`, `not-a-folder`, `writable` (its group
 * or everybody may write it), `owner` (it belongs to a user other than this one and root), `outside` (`path` is not
 * inside `area`). Permissions are POSIX ones: on Windows only links are looked for. Nothing above `area` is asked:
 * that is the data home, or the installed application, which have to be the user's anyway.
 */
export function unsafePlace(path, area, options) {
  return lookAtPlace(path, area, options).unsafe;
}

/**
 * unsafePlace, with what that look saw of the file itself: `{ unsafe, file }`, `unsafe` what unsafePlace says and
 * `file` the identity (fileIdentity) of what is at `path`, its last part not followed, from the very lstat that
 * judged it; null when nothing is there. A copy refused for where it lies is known by it (manager.js), never by a
 * second look at its path.
 */
export function lookAtPlace(path, area, { platform = process.platform, uid = process.getuid?.() } = {}) {
  const top = resolve(area);
  const file = resolve(path);
  const inside = relative(top, file);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { unsafe: { reason: 'outside', at: file }, file: null };
  let seen = null;
  const refused = (reason, at) => ({ unsafe: { reason, at }, file: seen });
  for (let at = file; ;) {
    let info;
    try { info = lstatSync(at, { bigint: true }); } catch { return refused('missing', at); }
    if (at === file) seen = fileIdentity(info);
    if (info.isSymbolicLink()) return refused('link', at);
    if (at === file ? !info.isFile() : !info.isDirectory()) return refused(at === file ? 'not-a-file' : 'not-a-folder', at);
    if (platform !== 'win32') {
      if (Number(info.mode) & 0o022) return refused('writable', at);
      const owner = Number(info.uid);
      if (uid !== undefined && owner !== uid && owner !== 0) return refused('owner', at);
    }
    if (at === top) return { unsafe: null, file: seen };
    const up = dirname(at);
    if (up === at) return refused('outside', at);
    at = up;
  }
}

/**
 * `path` as one of SynaBun's own folders for cloudflared, which only its owner can open (0700): made when it is not
 * there, set back to 0700 when it is this user's and lets anybody else in. A link, something that is not a folder,
 * or another user's folder is refused (`disk`): nothing is put through it, and nothing in it is touched.
 */
export function ownFolder(path, { platform = process.platform, uid = process.getuid?.() } = {}) {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new CloudflaredError('disk', `${path} is ${info.isSymbolicLink() ? 'a link' : 'not a folder'}, not a folder of SynaBun's own; nothing was put there.`, { detail: info.isSymbolicLink() ? 'ELOOP' : 'ENOTDIR' });
  }
  if (platform === 'win32') return path;
  if (uid !== undefined && info.uid !== uid) throw new CloudflaredError('disk', `${path} belongs to another user; nothing was put there.`, { detail: 'EPERM' });
  if (info.mode & 0o077) chmodSync(path, 0o700);
  return path;
}

async function writeAll(handle, buffer) {
  let at = 0;
  while (at < buffer.length) at += (await handle.write(buffer, at, buffer.length - at)).bytesWritten;
}

/** The next address of a redirect, which has to be HTTPS like the first one. */
function redirectTarget(response, from) {
  const location = response.headers.get('location');
  let next;
  try { next = new URL(location, from); } catch { next = null; }
  if (!location || !next) throw new CloudflaredError('http', 'The download server sent a redirect without an address.', { detail: String(response.status) });
  if (next.protocol !== 'https:') throw new CloudflaredError('http', 'The download server redirected to an address that is not HTTPS; it was not followed.', { detail: next.protocol });
  return next;
}

/**
 * Download a pinned release file into `destination` (a new file: it must not exist) and check it.
 * Resolves `{ sha256, size }` of what is then there, which is the pinned file; anything else rejects, and
 * `destination` is removed before it does.
 *
 * @param {object} o
 * @param {object} o.pin a pin of pins.js
 * @param {string} o.destination
 * @param {typeof fetch} [o.fetchImpl] the transport (tests stand a local server in for GitHub through it)
 * @param {AbortSignal} [o.signal] stops the download: `cancelled`
 * @param {(progress: { received: number, total: number }) => void} [o.onProgress]
 * @param {number} [o.stallMs] how long nothing may arrive, headers included
 */
export async function downloadPinned({ pin, destination, fetchImpl = fetch, signal, onProgress = () => {}, stallMs = 45_000 }) {
  if (!pin?.url?.startsWith('https://')) throw new CloudflaredError('http', 'The pinned address is not HTTPS; nothing was downloaded.');
  const stop = new AbortController();
  const onAbort = () => stop.abort(new CloudflaredError('cancelled', 'The download was stopped.'));
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  let timer = null;
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stop.abort(new CloudflaredError('timeout', `Nothing arrived from the download server for ${Math.round(stallMs / 1000)} seconds.`)), stallMs);
  };
  let handle = null;
  let made = false;       // the destination is this call's own file: only then is it removed on a failure
  let answered = false;   // the server sent the file's headers: what fails after that is the transfer
  let received = 0;
  const hash = createHash('sha256');
  try {
    alive();
    let url = new URL(pin.url);
    let response = null;
    for (let hop = 0; ; hop++) {
      // identity: the file's bytes as they are, so that their number is the pinned size
      response = await fetchImpl(url, { redirect: 'manual', signal: stop.signal, headers: { accept: 'application/octet-stream', 'accept-encoding': 'identity', 'user-agent': 'synabun' } });
      if (response.status < 300 || response.status >= 400) break;
      const next = redirectTarget(response, url);
      try { await response.body?.cancel(); } catch { /* nothing to drain */ }
      if (hop >= MAX_REDIRECTS) throw new CloudflaredError('http', 'The download server redirected too many times.');
      url = next;
      alive();
    }
    if (response.status !== 200 || !response.body) {
      try { await response.body?.cancel(); } catch { /* nothing to drain */ }
      throw new CloudflaredError('http', `The download server answered ${response.status} instead of the file.`, { detail: String(response.status) });
    }
    const announced = Number(response.headers.get('content-length'));
    if (Number.isFinite(announced) && announced > 0 && announced !== pin.size) {
      try { await response.body.cancel(); } catch { /* nothing to drain */ }
      throw new CloudflaredError('checksum', `The download server offered a file of ${announced} bytes; the pinned one has ${pin.size}. It was not downloaded.`);
    }
    answered = true;
    handle = await open(destination, 'wx', 0o600);
    made = true;
    onProgress({ received: 0, total: pin.size });
    for await (const chunk of response.body) {
      alive();
      received += chunk.length;
      if (received > pin.size) throw new CloudflaredError('checksum', 'The download is larger than the pinned file. It was stopped and removed.');
      hash.update(chunk);
      await writeAll(handle, chunk);
      onProgress({ received, total: pin.size });
    }
    if (received !== pin.size) throw new CloudflaredError('interrupted', `The download ended after ${received} of ${pin.size} bytes.`);
    const sha256 = hash.digest('hex');
    if (sha256 !== pin.sha256) throw new CloudflaredError('checksum', 'The downloaded file does not match its pinned checksum. It was removed and will never be run.', { detail: sha256 });
    await handle.sync();
    await handle.close();
    handle = null;
    return { sha256, size: received };
  } catch (error) {
    try { await handle?.close(); } catch { /* already closed */ }
    handle = null;
    if (made) rmSync(destination, { force: true });
    // An abort arrives as whatever the transport makes of it: the reason it was given is the answer.
    if (stop.signal.aborted && stop.signal.reason instanceof CloudflaredError) throw stop.signal.reason;
    if (error instanceof CloudflaredError) throw error;
    if (DISK_CODES.has(codeOf(error))) throw asCloudflaredError(error, 'disk', 'The data folder could not be written.');
    if (answered) throw new CloudflaredError('interrupted', `The download ended after ${received} of ${pin.size} bytes.`, { cause: error, detail: codeOf(error) || error?.message });
    throw asCloudflaredError(error, 'offline', 'The download server could not be reached.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** One header block of a tar archive: the entry's name, the size of its data, and whether it is a plain file. */
function readTarHeader(block) {
  const text = (from, to) => { const end = block.indexOf(0, from); return block.toString('utf8', from, end === -1 || end > to ? to : end); };
  const stored = parseInt(text(148, 156).trim(), 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
  if (stored !== sum) throw new CloudflaredError('unpack', 'The archive is not a tar archive.');
  let size = 0;
  if (block[124] & 0x80) for (let i = 125; i < 136; i++) size = size * 256 + block[i];   // base-256, for sizes octal cannot hold
  else size = parseInt(text(124, 136).trim() || '0', 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new CloudflaredError('unpack', 'The archive names an entry without a size.');
  const prefix = text(345, 500);
  const name = `${prefix ? `${prefix}/` : ''}${text(0, 100)}`.replace(/^\.\//, '');
  const flag = block[156];
  return { name, size, file: flag === 0 || flag === 48 };   // "\0" and "0": a regular file
}

/**
 * Read one member out of a gzipped tar archive into `destination` (a new file), without a tar program and
 * without ever using a name of the archive as a path: the entry called `member` that is a regular file of
 * exactly `size` bytes is copied out, and nothing else is looked at. Resolves `{ sha256, size }` of what was
 * written; rejects `unpack` (and removes `destination`) when the archive holds no such entry or ends inside it.
 */
export async function extractTarMember({ archive, member, size, destination, signal }) {
  const hash = createHash('sha256');
  let source = null;
  let gunzip = null;
  let handle = null;
  let made = false;
  let pending = Buffer.alloc(0);
  let mode = 'header';   // header | member | skip | done | end
  let left = 0;          // bytes of the current entry still to come (its padding included, when skipping)
  let padding = 0;
  let written = 0;
  try {
    handle = await open(destination, 'wx', 0o600);
    made = true;
    // Made here, with nothing awaited before the loop that reads them: an archive that cannot be opened fails
    // the loop. (The listener on gunzip is for the instant before the loop has its own: an 'error' nobody
    // listens for would be an uncaught exception of the whole server.)
    source = createReadStream(archive);
    gunzip = createGunzip();
    gunzip.on('error', () => {});
    source.on('error', (error) => gunzip.destroy(error));
    for await (const chunk of source.pipe(gunzip)) {
      if (signal?.aborted) throw new CloudflaredError('cancelled', 'Stopped.');
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length && mode !== 'done') {
        if (mode === 'header') {
          if (pending.length < 512) break;
          const block = pending.subarray(0, 512);
          pending = pending.subarray(512);
          if (block.every((byte) => byte === 0)) { mode = 'end'; break; }
          const entry = readTarHeader(block);
          padding = (512 - (entry.size % 512)) % 512;
          if (entry.file && entry.name === member) {
            if (entry.size !== size) throw new CloudflaredError('unpack', `The archive's ${member} has ${entry.size} bytes; the pinned one has ${size}.`);
            mode = 'member';
            left = entry.size;
          } else {
            mode = entry.size + padding ? 'skip' : 'header';
            left = entry.size + padding;
          }
        } else {
          const take = Math.min(left, pending.length);
          if (mode === 'member') {
            const part = pending.subarray(0, take);
            hash.update(part);
            await writeAll(handle, part);
            written += take;
          }
          pending = pending.subarray(take);
          left -= take;
          if (left === 0) mode = mode === 'member' ? 'done' : 'header';
        }
      }
      if (mode === 'done' || mode === 'end') break;
    }
    if (mode !== 'done') throw new CloudflaredError('unpack', mode === 'member' ? `The archive ends inside its ${member}.` : `The archive holds no ${member}.`);
    await handle.sync();
    await handle.close();
    handle = null;
    return { sha256: hash.digest('hex'), size: written };
  } catch (error) {
    try { await handle?.close(); } catch { /* already closed */ }
    handle = null;
    if (made) rmSync(destination, { force: true });
    throw asCloudflaredError(error, 'unpack', 'The archive could not be read.');
  } finally {
    source?.destroy();
    gunzip?.destroy();
  }
}

/**
 * The cloudflared of a release file that was already checked, as a new executable file at `destination`:
 * the file itself (moved there with `move`, copied otherwise), or the member of the archive. What ends up
 * there is compared with the pinned SHA-256 of the binary; a file that is not it is removed and `checksum`
 * (or `unpack`) is thrown.
 */
export async function binaryFromRelease({ pin, releaseFile, destination, move = false, signal, platform = process.platform }) {
  let made = false;   // the destination is this call's own file from here on: only then is it removed on a failure
  try {
    if (existsSync(destination)) throw new CloudflaredError('disk', 'Something is already where cloudflared was to be put; it was left as it is.', { detail: 'EEXIST' });
    if (pin.archive === 'tgz') {
      const unpacked = await extractTarMember({ archive: releaseFile, member: pin.member, size: pin.binary.size, destination, signal });
      made = true;
      if (unpacked.sha256 !== pin.binary.sha256) throw new CloudflaredError('checksum', 'The cloudflared inside the archive does not match its pinned checksum. It was removed and will never be run.', { detail: unpacked.sha256 });
    } else {
      if (move) renameSync(releaseFile, destination);
      else await copyFile(releaseFile, destination, constants.COPYFILE_EXCL);
      made = true;
      const check = await verifyCloudflared(destination, pin, { signal });
      if (!check.ok) throw new CloudflaredError('checksum', 'The file does not match the pinned checksum of cloudflared. It was removed and will never be run.', { detail: check.reason });
    }
    if (platform !== 'win32') chmodSync(destination, 0o755);
    return destination;
  } catch (error) {
    if (made) rmSync(destination, { force: true });
    throw asCloudflaredError(error, 'disk', 'cloudflared could not be put in place.');
  }
}

const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
};

/**
 * Remove the work folders an earlier attempt left in `root` (a process that was stopped mid-download cannot
 * clean up after itself): every one whose process is gone or this process itself, and any older than an hour.
 * @returns {string[]} what was removed
 */
export function sweepStaleWork(root, { now = Date.now(), alive = processAlive, pid = process.pid } = {}) {
  const removed = [];
  let names = [];
  try { names = readdirSync(root); } catch { return removed; }
  for (const name of names) {
    if (!name.startsWith(WORK_PREFIX)) continue;
    const owner = Number(name.slice(WORK_PREFIX.length).split('-')[0]);
    const path = join(root, name);
    let age = Infinity;
    try { age = now - statSync(path).mtimeMs; } catch { /* gone meanwhile */ }
    if (owner === pid || !Number.isInteger(owner) || !alive(owner) || age > STALE_WORK_MS) {
      try { rmSync(path, { recursive: true, force: true }); removed.push(name); } catch { /* in use: the next attempt asks again */ }
    }
  }
  return removed;
}

/**
 * Download the pinned cloudflared and put it at `<root>/<version>/cloudflared[.exe]`. Everything happens in a
 * work folder of this attempt inside `root`, which is removed whatever the outcome; the binary is renamed into
 * place only after both of its checks, so its place holds the whole checked file or nothing. `root` and the
 * version's folder are SynaBun's own, 0700 (ownFolder): a link or another user's folder there stops the install.
 * One attempt at a time per process is the caller's business (manager.js); two processes that download at once
 * each rename a checked file into the same place, and the place holds one of them, whole.
 *
 * @returns {Promise<{ path: string, version: string }>}
 */
export async function installCloudflared({ pin, root, fetchImpl, signal, onProgress, stallMs, platform = process.platform }) {
  const directory = join(root, pin.version);
  const destination = join(directory, pin.binary.name);
  let work = null;
  let placed = false;
  try {
    mkdirSync(dirname(root), { recursive: true });
    ownFolder(root);
    sweepStaleWork(root);
    work = join(root, `${WORK_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}`);
    mkdirSync(work, { mode: 0o700 });
    const releaseFile = join(work, 'release.part');
    await downloadPinned({ pin, destination: releaseFile, fetchImpl, signal, onProgress, stallMs });
    const binary = join(work, 'binary.part');
    await binaryFromRelease({ pin, releaseFile, destination: binary, move: true, signal, platform });
    if (signal?.aborted) throw new CloudflaredError('cancelled', 'Stopped.');
    // A link or a file where the version's folder belongs is taken away (the link itself, never what it points to).
    let there = null;
    try { there = lstatSync(directory); } catch { /* not there yet */ }
    if (there && (there.isSymbolicLink() || !there.isDirectory())) { try { unlinkSync(directory); } catch { rmdirSync(directory); } }
    ownFolder(directory);
    try {
      renameSync(binary, destination);
    } catch (error) {
      // Windows does not replace a file that is running: when what is there is the pinned binary, it is the result.
      if (!existsSync(destination) || !(await verifyCloudflared(destination, pin)).ok) throw error;
    }
    placed = true;
    return { path: destination, version: pin.version };
  } catch (error) {
    throw asCloudflaredError(error, 'disk', 'cloudflared could not be put in place.');
  } finally {
    if (work) { try { rmSync(work, { recursive: true, force: true }); } catch { /* the next attempt sweeps it */ } }
    // A failed attempt leaves no folder of its own either (rmdir only ever removes an empty one). A `root` that was
    // not SynaBun's own (no work folder was made in it) is left as it is.
    if (!placed && work) for (const folder of [directory, root]) { try { rmdirSync(folder); } catch { /* not empty, or not there */ } }
  }
}

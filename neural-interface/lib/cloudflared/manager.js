// ═══════════════════════════════════════════
// SynaBun — cloudflared: the copy the tunnel runs
// ═══════════════════════════════════════════
//
// The public address (invite links, remote MCP) is a Cloudflare quick tunnel,
// and cloudflared is the program that opens it. SynaBun brings its own, so the
// tunnel works on a machine where nobody installed anything. Which copy runs,
// in this order:
//
//   bundled      the one inside an installer: <resources>/cloudflared/, only in
//                a packaged application (lib/packaged-runtime.js)
//   downloaded   one this module fetched earlier, in the data home:
//                DATA_HOME/runtime/cloudflared/<version>/ (outside data/, so no
//                backup ever holds it)
//   a download   of the pinned release file (pins.js), into that place
//   system       a cloudflared on PATH, only when no download is possible: no
//                file is published for this system, or the download failed
//
// SynaBun's own copies are the pinned binary or they are not run: each is
// compared with its pinned SHA-256 every time a tunnel is about to be started
// with it (for a look at the state of things: the first time this process
// meets it, and again whenever the file changes). A copy in the data home that
// fails is removed; the one in an installer is left where it is and never
// used. A cloudflared on PATH is the user's own installation and is run as it
// is.
//
// Where a copy of SynaBun's own lies is part of its check (install.js
// unsafePlace): the copy and its folder up to SynaBun's own cloudflared folder
// must not be a link, nor writable by anybody but their owner. The data home's
// folder is 0700. The file is hashed by its real path, through one handle, and
// confirm() checks, as the tunnel is about to start it, that it is still that
// very file (same device, inode, size and times): one that changed since its
// check is never run. What is left: Node starts a program by its path, not by
// an open file, so between confirm() and the start (no await between them)
// another process of the same user could still swap the file. Whoever can do
// that can change the data home, and SynaBun with it, anyway.
//
// A cloudflared on PATH that is really one of SynaBun's own copies (a link or a
// second name for one, or a file inside one of its folders, compared by what
// the file is, never by how a path spells it) is never the user's: it is not
// run, not even for `--version`. Nor is a second name of a copy SynaBun
// refused in this process, for whatever reason (where it lies, its bytes, a
// change before its start): what the refusal saw (the hashing handle, or the
// lstat that judged where it lies) is kept before the copy goes.
//
// One download at a time: everybody who asks while one runs waits for that
// one. A failed one is not remembered as a verdict: the next start tries again.
//
//   inspect()  what is there now; never downloads (GET /api/tunnel/status)
//   ensure()   the copy to run, downloading it when there is none ({ signal }: stop on request)
//   confirm()  the copy ensure() gave, checked once more right before it is started: the path to start
//   cancel()   stop the download that is running
//   status()   the last known state, without touching the disk
//   killNow()  kill a `cloudflared --version` that is still running (the server's exit)

import { spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, lstatSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { getDataHome } from '../../../lib/paths.js';
import { packagedRuntime } from '../../../lib/packaged-runtime.js';
import { getAugmentedPath } from '../augmented-path.js';
import { CloudflaredError, checkCloudflared, fileIdentity, installCloudflared, lookAtPlace, sameFile } from './install.js';
import { bundledCloudflaredPath, cloudflaredPinFor, readCloudflaredPins } from './pins.js';
import { endChild } from './tunnel.js';

/** A version folder nobody used for this long is removed when a newer cloudflared is put in place. */
const UNUSED_VERSION_MS = 30 * 24 * 60 * 60 * 1000;
const VERSION_FOLDER = /^\d{4}\.\d{1,2}\.\d{1,3}$/;

/** `DATA_HOME/runtime/cloudflared`: where a downloaded cloudflared lives. */
export function cloudflaredRoot(dataHome = getDataHome()) {
  return join(dataHome, 'runtime', 'cloudflared');
}

/** What a file or folder is, whatever path names it (links followed): its device and inode. null when it is not there. */
function identityOf(path) {
  try {
    const info = statSync(path, { bigint: true });
    // A file system without inode numbers (FAT) gives every file the same one: there its real path stands in.
    return info.ino ? `${info.dev}:${info.ino}` : `${info.dev}:${realpathSync(path)}`;
  } catch {
    return null;
  }
}

/**
 * identityOf() of the file a fileIdentity() describes, from what was seen then, without asking its path again. null
 * without an inode number: a file system that has none has no second names either.
 */
const identityKey = (file) => (file?.ino ? `${file.dev}:${file.ino}` : null);

/** fileIdentity() of what is at `path`, its last part not followed; null when nothing is there. */
function lstatIdentity(path) {
  try { return fileIdentity(lstatSync(path, { bigint: true })); } catch { return null; }
}

/** Is the file at the real path `real` inside one of `folders` (identityOf of each)? Asked folder by folder, by what each is. */
function insideAny(real, folders) {
  if (!folders.length) return false;
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    if (folders.includes(identityOf(dir))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/**
 * A cloudflared the user installed: the first one on PATH (with the folders installers use: lib/augmented-path.js),
 * then the folders of Cloudflare's Windows installer, as its real path (a link on PATH is followed here, and what is
 * run is the file that was looked at). Never one of SynaBun's own: a file inside one of the `exclude` folders, or
 * one `isOwn` says is SynaBun's (manager.js: its copies, and every one it refused), whatever link or
 * second name leads to it. Folders and files are compared by what they are, not by how a path spells them.
 * Null when there is none.
 */
export function findSystemCloudflared({ platform = process.platform, env = process.env, pathValue = getAugmentedPath(), exclude = [], isOwn = () => false } = {}) {
  const name = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const folders = String(pathValue || '').split(delimiter).filter(Boolean);
  if (platform === 'win32') {
    for (const base of [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']]) if (base) folders.push(join(base, 'cloudflared'));
  }
  const ours = exclude.filter(Boolean).map(identityOf).filter(Boolean);
  for (const folder of folders) {
    try {
      const candidate = resolve(folder, name);
      if (!statSync(candidate).isFile()) continue;
      if (platform !== 'win32') accessSync(candidate, constants.X_OK);
      const real = realpathSync(candidate);
      if (insideAny(real, ours) || isOwn(real)) continue;
      return real;
    } catch { /* not here */ }
  }
  return null;
}

/** `cloudflared --version` runs that have not exited yet: killNow() kills them at once. */
const probing = new Set();

/**
 * What `cloudflared --version` says ("2026.10.0"), "unknown" when it answers something else, null when it does not
 * run, does not answer within `timeoutMs`, or `signal` stops it. It settles by then, whatever the program does: one
 * that is still there is asked to end, and killed when it is still there `killAfterMs` later (tunnel.js endChild).
 */
export function probeCloudflaredVersion(path, { timeoutMs = 8000, killAfterMs = 1000, signal } = {}) {
  return new Promise((done) => {
    let child = null;
    let out = '';
    let settled = false;
    let timer = null;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', giveUp);
      done(value);
    };
    function giveUp() {
      settle(null);
      if (child) endChild(child, { killAfterMs });
    }
    if (signal?.aborted) { settle(null); return; }
    try {
      child = spawn(path, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      settle(null);
      return;
    }
    if (child.pid) { probing.add(child); child.once('exit', () => probing.delete(child)); }
    timer = setTimeout(giveUp, timeoutMs);
    signal?.addEventListener('abort', giveUp, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (out.length < 4096) out += chunk; });
    child.on('error', () => settle(null));
    child.on('close', (code) => settle(code === 0 ? (/cloudflared version (\d[\w.-]*)/i.exec(out)?.[1] || 'unknown') : null));
  });
}

const describe = (error) => ({
  code: error instanceof CloudflaredError ? error.code : 'unknown',
  message: error?.message || String(error),
});

const cancelled = () => new CloudflaredError('cancelled', 'Stopped.');

/**
 * @param {object} [o]
 * @param {string} [o.dataHome]
 * @param {{ resources: string } | null} [o.packaged] lib/packaged-runtime.js packagedRuntime(); null: not a packaged application
 * @param {object} [o.pins] pins.js readCloudflaredPins() (read here when it is left out; unreadable pins never throw)
 * @param {typeof fetch} [o.fetchImpl]
 * @param {() => (string | null)} [o.findSystem]
 * @param {string} [o.pathValue] the PATH the user's own cloudflared is looked for in (findSystemCloudflared)
 * @param {(path: string, o?: { signal?: AbortSignal }) => Promise<string | null>} [o.probeVersion]
 * @param {(line: string) => void} [o.log]
 */
export function createCloudflaredManager({
  dataHome = getDataHome(),
  packaged = packagedRuntime(),
  pins,
  platform = process.platform,
  arch = process.arch,
  fetchImpl,
  findSystem,
  pathValue,
  probeVersion = probeCloudflaredVersion,
  stallMs,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  // The pins ship with the application. Should they ever be unreadable (a damaged install), the server still
  // starts and everything else works: nothing is downloaded by guesswork, and only a cloudflared the user
  // installed can run, as on a system no file is pinned for. The log says what is wrong.
  if (!pins) {
    try {
      pins = readCloudflaredPins();
    } catch (error) {
      pins = Object.freeze({ version: null, platforms: Object.freeze({}) });
      log(`[cloudflared] ${error?.message || error} SynaBun downloads no tunnel program until this is repaired; a cloudflared on PATH is used when there is one.`);
    }
  }
  const root = cloudflaredRoot(dataHome);
  const pin = cloudflaredPinFor(pins, platform, arch);
  const bundledPath = packaged?.resources ? bundledCloudflaredPath(packaged.resources, platform) : null;
  const bundledFolder = bundledPath ? dirname(bundledPath) : null;
  const downloadedPath = pin ? join(root, pin.version, pin.binary.name) : null;
  const system = findSystem || (() => findSystemCloudflared({ platform, pathValue, exclude: [root, bundledFolder], isOwn: isOwnCopy }));

  const checked = new Map();   // real path → { stat, verdict }: a copy is hashed once, and again when it changes
  const marks = new Map();     // real path → { file, area }: what the last check of a copy read, and the folder it was checked in
  const rejected = new Set();  // identityOf() of every copy of SynaBun's own that was refused, for whatever reason: never run under another name
  const versions = new Map();  // a system copy's real path → { mtimeMs, version }
  let download = null;         // { promise, stop, progress } while one runs
  let current = null;          // { path, source, version }: the copy found last
  let lastError = null;        // why the last attempt gave no copy
  let fallback = null;         // why the copy in use is not a pinned one
  let touched = false;
  let unread = false;          // the last look found a downloaded copy it could not read (see local)
  const noted = new Set();

  const once = (key, line) => { if (!noted.has(key)) { noted.add(key); log(line); } };

  /**
   * Is the file at `path` (a real path) the pinned binary? For a look at the state of things it is hashed once per
   * file as it is on disk (its identity: inode, size, times). `again` hashes it whatever is remembered: that is how
   * the copy a tunnel is about to be started with is checked, so a file changed under the same size and time is
   * still never run.
   */
  async function isPinned(path, again = false, signal) {
    let info;
    try { info = fileIdentity(statSync(path, { bigint: true })); } catch { checked.delete(path); return { ok: false, reason: 'missing' }; }
    const known = checked.get(path);
    if (!again && known && sameFile(known.stat, info)) return known.verdict;
    const verdict = await checkCloudflared(path, pin, { signal });
    // A file that could not be read just now, or that changed while it was read, is not remembered as anything:
    // the next look reads it again.
    if (verdict.reason === 'unreadable' || verdict.reason === 'changed') checked.delete(path);
    else checked.set(path, { stat: info, verdict });
    return verdict;
  }

  /**
   * A copy of SynaBun's own was refused, and `file` (fileIdentity) is what the refusal saw of it: the bytes it is are
   * never run under another name (a link or a second name on PATH) for the rest of this process. Called before the
   * copy goes, with the identity the refusal itself read, never with a later look at its path.
   */
  function refuse(file) {
    const key = identityKey(file);
    if (key) rejected.add(key);
  }

  /**
   * One of SynaBun's own copies, at `path` in its folder `area`: where it lies first (no link, nobody else may
   * write: install.js lookAtPlace), then its bytes, by its real path. `{ ok, reason, path }` (the real path). One
   * that is refused is known by what refused it: the file the hash read, or the one the look at its place saw.
   */
  async function ownCopy(path, area, again, signal) {
    const place = lookAtPlace(path, area);
    if (place.unsafe) { refuse(place.file); return { ok: false, reason: place.unsafe.reason }; }
    let real;
    let realArea;
    try { real = realpathSync(path); realArea = realpathSync(area); } catch { return { ok: false, reason: 'missing' }; }
    const verdict = await isPinned(real, again, signal);
    if (verdict.ok) marks.set(real, { file: verdict.file ?? checked.get(real)?.stat, area: realArea });
    else if (verdict.reason !== 'missing') refuse(verdict.file ?? place.file);
    return { ok: verdict.ok, reason: verdict.reason, path: real };
  }

  /**
   * Why SynaBun's own folder in the data home cannot hold its cloudflared, or null (also when it is not there yet):
   * `link`, `not-a-folder`, `owner` (another user's). One of this user's that lets others in is set back to 0700.
   */
  function unsafeRoot() {
    let info;
    try { info = lstatSync(root); } catch { return null; }
    if (info.isSymbolicLink()) return 'link';
    if (!info.isDirectory()) return 'not-a-folder';
    if (process.platform === 'win32') return null;
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) return 'owner';
    if (info.mode & 0o077) { try { chmodSync(root, 0o700); } catch { return 'writable'; } }
    return null;
  }

  /** What stands in the version's place in SynaBun's own folder goes: the copy, or a link there (the link itself, never what it points to). */
  function removeDownloaded() {
    const entry = join(root, pin.version);
    try {
      const info = lstatSync(entry);
      if (info.isSymbolicLink() || !info.isDirectory()) { try { unlinkSync(entry); } catch { rmdirSync(entry); } }
      else rmSync(downloadedPath, { force: true, recursive: true });
    } catch { /* not there, or the next look removes it */ }
  }

  /**
   * The pinned copy that is on this disk already, or null. Removes a downloaded copy that is not the pinned
   * binary, or that is not kept as it should be. `again`: compare with the pin now, whatever an earlier look found
   * (see isPinned).
   */
  async function local(again = false, signal) {
    unread = false;
    if (!pin) return null;
    if (bundledPath) {
      const have = await ownCopy(bundledPath, bundledFolder, again, signal);
      if (have.ok) return { path: have.path, source: 'bundled', version: pin.version };
      if (have.reason !== 'missing') once(`bundled:${have.reason}`, `[cloudflared] The copy inside the application is not the pinned cloudflared ${pin.version}, or not kept where only its owner can change it (${have.reason}); it is not used.`);
    }
    // SynaBun's own folder in the data home: a link, or another user's folder, is never used or written through.
    const unsafe = unsafeRoot();
    if (unsafe) {
      once(`root:${unsafe}`, `[cloudflared] ${root} is not a folder of SynaBun's own (${unsafe}): nothing in it is run, and nothing is downloaded into it.`);
      return null;
    }
    const have = await ownCopy(downloadedPath, root, again, signal);
    if (have.ok) {
      if (!touched) { touched = true; try { const at = new Date(now()); utimesSync(dirname(have.path), at, at); } catch { /* a mark for housekeeping only */ } }
      return { path: have.path, source: 'downloaded', version: pin.version };
    }
    if (have.reason === 'unreadable' || have.reason === 'changed') {
      // It could not be read to be compared (too many open files, a file another program holds), or it changed
      // while it was read: that says nothing about what it is. Not run, and not removed either.
      unread = true;
      once('unreadable', '[cloudflared] The copy in the data folder could not be read to be checked; it is not used until it can be.');
      return null;
    }
    if (have.reason !== 'missing' && !download) {
      // Never run, never kept: whatever is there instead of the pinned binary, kept as it should be, goes.
      removeDownloaded();
      log(`[cloudflared] The copy in the data folder was not the pinned cloudflared ${pin.version} (${have.reason}); it was removed.`);
    }
    return null;
  }

  /** Version folders of the data home that nothing used for a month. The one in use is never among them. */
  function pruneUnusedVersions() {
    let names = [];
    try { names = readdirSync(root); } catch { return; }
    for (const name of names) {
      if (!VERSION_FOLDER.test(name) || name === pin?.version) continue;
      try {
        if (now() - statSync(join(root, name)).mtimeMs > UNUSED_VERSION_MS) rmSync(join(root, name), { recursive: true, force: true });
      } catch { /* in use, or gone */ }
    }
  }

  /** The one download: whoever asks while it runs gets the same one. */
  function fetchOnce() {
    // One that was stopped is still winding down (removing what it had): whoever asks now did not ask for that
    // one. A new download begins when it is gone, never beside it.
    if (download?.stop.signal.aborted) return download.promise.catch(() => {}).then(() => fetchOnce());
    if (download) return download.promise;
    const stop = new AbortController();
    const progress = { received: 0, total: pin.size };
    log(`[cloudflared] Downloading cloudflared ${pin.version} for ${pin.key} (${(pin.size / 1024 / 1024).toFixed(1)} MB) from ${pin.url}`);
    const promise = installCloudflared({
      pin, root, fetchImpl, stallMs, platform, signal: stop.signal,
      onProgress: ({ received }) => { progress.received = received; },
    }).then((placed) => {
      log(`[cloudflared] cloudflared ${pin.version} is in place, checksum verified: ${placed.path}`);
      pruneUnusedVersions();
      return placed;
    }, (error) => {
      log(`[cloudflared] The download of cloudflared ${pin.version} did not complete (${describe(error).code}): ${error?.message || error}`);
      throw error;
    }).finally(() => { if (download?.promise === promise) download = null; });
    download = { promise, stop, progress };
    return promise;
  }

  /**
   * Is the file at `path` one of SynaBun's own copies: one in place (in the application, in the data home), one that
   * was refused here, or a file inside one of SynaBun's folders for cloudflared? Compared by what the file is
   * (its device and inode, links followed), never by how a path spells it. What cannot be looked at counts as one.
   */
  function isOwnCopy(path) {
    const id = identityOf(path);
    if (!id || rejected.has(id)) return true;
    if ([bundledPath, downloadedPath].some((own) => own && identityOf(own) === id)) return true;
    let real;
    try { real = realpathSync(path); } catch { return true; }
    return insideAny(real, [root, bundledFolder].filter(Boolean).map(identityOf).filter(Boolean));
  }

  /** The real path of a cloudflared on PATH, or null when it is SynaBun's own copy by another name (said once). */
  function foreign(path) {
    let real;
    try { real = realpathSync(path); } catch { return null; }
    if (!isOwnCopy(real)) return real;
    once(`alias:${real}`, `[cloudflared] ${path} on PATH is SynaBun's own copy of cloudflared, not one installed on this computer: it is not run.`);
    return null;
  }

  /** The user's own cloudflared, with the version it reports; null when there is none that runs. */
  async function systemCopy(signal) {
    let path = null;
    try { path = system(); } catch { path = null; }
    if (!path) return null;
    // Looked at before it is run, even for --version: never one of SynaBun's own copies, whatever name leads to it.
    const real = foreign(path);
    if (!real) return null;
    let mtimeMs = 0;
    try { mtimeMs = statSync(real).mtimeMs; } catch { /* asked below */ }
    const known = versions.get(real);
    const version = known && known.mtimeMs === mtimeMs ? known.version : await probeVersion(real, { signal });
    if (signal?.aborted) throw cancelled();
    versions.set(real, { mtimeMs, version });
    return version ? { path: real, source: 'system', version } : null;
  }

  /** No pinned copy could be had (`reason`): the user's own cloudflared when there is one, the reason when not. */
  async function withoutDownload(reason, signal) {
    const copy = await systemCopy(signal);
    if (!copy) {
      current = null;
      fallback = null;
      lastError = describe(reason);
      throw reason;
    }
    once(`system:${copy.path}`, `[cloudflared] Using the cloudflared on PATH (${copy.path}, ${copy.version}): ${reason.message}`);
    current = copy;
    fallback = describe(reason);
    lastError = null;
    return { ...copy };
  }

  const found = (copy) => {
    current = copy;
    fallback = null;
    lastError = null;
    return { ...copy };
  };

  async function ensure({ signal } = {}) {
    if (signal?.aborted) throw cancelled();
    // The copy that is about to run is compared with its pin now, not by what an earlier look remembered.
    const have = await local(true, signal);
    if (have) return found(have);
    if (signal?.aborted) throw cancelled();
    if (!pin) return withoutDownload(new CloudflaredError('unsupported', `Cloudflare publishes no cloudflared for this system (${platform}-${arch}).`), signal);
    lastError = null;
    try {
      await fetchOnce();
    } catch (error) {
      if (error instanceof CloudflaredError && error.code === 'cancelled') { current = null; throw error; }
      if (signal?.aborted) throw cancelled();
      return withoutDownload(error instanceof CloudflaredError ? error : new CloudflaredError('disk', error?.message || String(error), { cause: error }), signal);
    }
    if (signal?.aborted) throw cancelled();
    // What was just put in place is met like any copy: compared with its pin before it is handed out.
    const fresh = await local(true, signal);
    if (fresh) return found(fresh);
    return withoutDownload(unread
      ? new CloudflaredError('disk', 'The downloaded cloudflared could not be read back to be checked.')
      : new CloudflaredError('checksum', 'The downloaded cloudflared did not pass its check and was removed.'), signal);
  }

  /**
   * The copy ensure() handed out, checked once more as it is about to be started (tunnel.js calls this and spawns
   * the path it returns at once, with nothing in between). SynaBun's own copy must still lie where only its owner
   * can change it and be the very file whose bytes ensure() hashed (same device, inode, size and times); a
   * cloudflared on PATH must still not be one of SynaBun's own. Returns the real path to start; throws a
   * CloudflaredError (nothing is started) otherwise. A downloaded copy that changed is removed: the next start
   * fetches the pinned one again.
   */
  function confirm(copy) {
    if (copy?.source === 'system') {
      const real = foreign(copy.path);
      if (!real) throw new CloudflaredError('launch', 'The cloudflared on PATH is SynaBun\'s own copy by another name; it was not started.');
      return real;
    }
    const mark = marks.get(copy?.path);
    // Where it lies and which file it is, in one look (its last part not followed).
    const place = mark ? lookAtPlace(copy.path, mark.area) : null;
    if (place && !place.unsafe && sameFile(mark.file, place.file)) return copy.path;
    // Another file, other bytes, a link, a folder others may write: what was checked is not what is there. What is
    // there is never run, by this name or another one.
    refuse(place ? place.file : lstatIdentity(copy?.path));
    marks.delete(copy?.path);
    checked.delete(copy?.path);
    const remove = copy?.source === 'downloaded' && !!pin && !unsafeRoot();
    if (remove) removeDownloaded();
    log(`[cloudflared] cloudflared changed after it was checked (${copy?.path}); it was not started${remove ? ' and was removed' : ''}.`);
    throw new CloudflaredError('checksum', 'cloudflared changed after it was checked against its pinned checksum; it was not started.');
  }

  async function inspect() {
    if (download) return status();
    const have = await local();
    if (have) { found(have); return status(); }
    // The user's own cloudflared is what runs only where no pinned one can be had: on a system Cloudflare
    // publishes none for, or after a download that failed. Otherwise a start downloads the pinned one.
    current = current?.source === 'system' || !pin ? await systemCopy() : null;
    return status();
  }

  function status() {
    const base = {
      pinned: pins.version,
      supported: !!pin,
      download: pin ? { size: pin.size } : null,
      progress: null,
      source: null,
      version: null,
      error: null,
      fallback: null,
    };
    if (download) {
      const { received, total } = download.progress;
      return { ...base, state: 'downloading', progress: { received, total, percent: total ? Math.min(100, Math.floor((received / total) * 100)) : 0 } };
    }
    if (current) return { ...base, state: 'ready', source: current.source, version: current.version, fallback: current.source === 'system' ? fallback : null };
    if (lastError) return { ...base, state: 'failed', error: lastError };
    return { ...base, state: pin ? 'missing' : 'unsupported' };
  }

  function cancel() {
    if (!download) return false;
    download.stop.abort();
    return true;
  }

  /** At the server's exit: a `cloudflared --version` that is still running is killed now. */
  function killNow() {
    for (const child of probing) { try { child.kill('SIGKILL'); } catch { /* gone already */ } }
  }

  return { ensure, confirm, inspect, status, cancel, killNow, root, pin };
}

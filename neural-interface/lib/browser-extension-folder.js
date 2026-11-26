// The extension folder the owner loads in the browser ("Load unpacked"): DATA_HOME/browser-extension/unpacked, in the
// owner's data home, so an npm update or a moved install never breaks the loaded extension. Its files come from the
// one package this app release pins (lib/browser-extension-pin.js), downloaded from synabun.ai and verified before a
// single byte is written here (lib/browser-extension-package.js); nothing of the extension is inside the app. When the
// folder's files change, the browser needs the extension's Reload (the server tells the owner: status `reloadNeeded`).
//
// The folder keeps the manifest's `key`, so the extension's ID is the same from this folder as from any other
// (lib/browser-extension-pin.js EXTENSION_ID). Only the setup page's content script changes: its matches name this
// server's own app port (127.0.0.1 and localhost), so the script runs on SynaBun's setup page and nowhere else.
//
// The extension has broad permissions, so the folder is held to the release, never to what a file in it says:
//
//   current    the folder holds exactly the files the pin lists (`files`: their SHA-256), byte for byte, and nothing
//              else; the manifest may differ from the package's only in the setup content script, and only as
//              folderManifest writes it for one port (inspectExtensionFolder). The marker (unpacked.json) is a record
//              for an older SynaBun and for display; nothing decides on it.
//   the root   DATA_HOME (as resolved once) and DATA_HOME/browser-extension must be folders of this user that no one
//              else can write, and the folder the browser loads a real folder (never a link). Anything else is
//              EXTENSION_FOLDER_UNSAFE and nothing is read, recovered or written there.
//   one writer every change, and the recovery before it, runs under one OS-held lock per data home (an empty SQLite
//              file, lib/rulesets/lock.js: it goes away with a process that dies). Two servers on one data home take
//              turns; nothing they do interleaves.
//   a swap     the new folder is written and synced beside the live one, a transaction record (transaction.json) is
//              written and synced, then the live folder is renamed aside and the new one into its place: two renames,
//              the same on every system, with a short moment between them where the path is empty (no program is
//              started for this, and nothing but Node's own rename is used). A live folder that cannot be moved fails
//              the first rename, so the update waits and the old folder stays whole. Live files are never overwritten
//              one by one. The marker is written once the new folder is in place, then the old one and the record are
//              removed. A process stopped at any step leaves the record, and the next locked step finishes it or takes
//              it back (settle), by the folders' inodes.
//   recovery   only what a record names is ever moved back to the browser's path, and an old folder only when the
//              record says it was the pinned extension. A leftover the record does not name is never promoted; the
//              names SynaBun's own steps leave (staging folders, temporary files, old folders once the live one is
//              there, a download nobody runs any more, and the swap-probe folders of an earlier build of this
//              branch) are removed; nothing else is touched.
//
// Nothing here is logged with a path.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EXTENSION_MAX_FILE_BYTES, EXTENSION_MAX_FILES, extensionFileAllowed, readExtensionSource, readExtensionZip } from './browser-extension-archive.js';
import { EXTENSION_PIN } from './browser-extension-pin.js';
import { createWriterLock } from './rulesets/lock.js';

/** The path of the setup page, and the content-script file that reads its one-time pairing token. */
export const SETUP_PAGE_PATH = '/extension-setup';
export const SETUP_SCRIPT = 'setup-content.js';
/** The port a manifest is set to before its SHA-256 is taken for the pin (the content script is the one part a folder changes). */
export const TEMPLATE_PORT = 1;
export const LOCK_TIMEOUT_MS = 15_000;

/** The setup page's origins for an app port: the content script's matches, and what the service worker accepts. */
export function setupMatches(appPort) {
  const port = Number(appPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('Invalid app port.'), { code: 'INVALID_MESSAGE' });
  return [`http://127.0.0.1:${port}${SETUP_PAGE_PATH}*`, `http://localhost:${port}${SETUP_PAGE_PATH}*`];
}
/** The manifest the folder gets: the package's, with the setup content script set to `appPort`. */
export function folderManifest(manifest, appPort) {
  const copy = structuredClone(manifest);
  copy.content_scripts = [{ matches: setupMatches(appPort), js: [SETUP_SCRIPT], run_at: 'document_idle', all_frames: false }];
  return copy;
}
/** Compares dotted versions (1.10.0 > 1.9.0). */
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(n => Number.parseInt(n, 10) || 0), pb = String(b || '0').split('.').map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return Math.sign(d); }
  return 0;
}

const ROOT = 'browser-extension', FOLDER = 'unpacked', MARKER = 'unpacked.json', JOURNAL = 'transaction.json', CACHE = 'package.zip', LOCK = 'install-lock.db';
/** The names SynaBun's own steps leave beside the folder (and only these are ever removed). */
export const STAGING_FOLDER = /^unpacked\.\d+\.[a-f0-9]{12}\.tmp$/;
export const RETIRED_FOLDER = /^unpacked\.[a-f0-9]{12}\.old$/;
const TEMPORARY_FILE = /^(unpacked\.json|transaction\.json|package\.zip)\.[a-f0-9]{12}\.tmp$/;
// A folder an earlier build of this branch made to test its file system, and left when it was stopped mid-test.
// Nothing makes one any more; the sweep still removes this exact name.
const SWAP_PROBE = /^swap-probe\.\d+\.[a-f0-9]{12}$/;
const DOWNLOAD_FILE = /^download\.(\d+)\.[a-f0-9]{12}\.tmp$/;
const STALE_DOWNLOAD_MS = 10 * 60 * 1000;
/** A name for a download's working file in the root (removed by the next locked step once nobody runs it). */
export const downloadWorkName = () => `download.${process.pid}.${hex()}.tmp`;

const hex = () => randomBytes(6).toString('hex');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const byRel = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
const serialize = manifest => Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
const folderError = (code, message) => Object.assign(new Error(message), { code });
const failed = message => folderError('EXTENSION_FOLDER_FAILED', message);
const unsafe = (part, reason = 'it is a link, not a folder, another user\'s, or others can write to it') => Object.assign(folderError('EXTENSION_FOLDER_UNSAFE', `SynaBun did not use ${part}: ${reason}. Nothing was read or changed there.`), { reason });
const notPinned = message => folderError('EXTENSION_VERIFY_FAILED', message);
const KNOWN_CODES = new Set(['EXTENSION_FOLDER_FAILED', 'EXTENSION_FOLDER_UNSAFE', 'EXTENSION_VERIFY_FAILED']);
const asFolderError = error => (KNOWN_CODES.has(error?.code) ? error : Object.assign(failed('The extension folder could not be written.'), { cause: error }));
const WINDOWS = process.platform === 'win32';
const NOFOLLOW = constants.O_NOFOLLOW || 0, NONBLOCK = constants.O_NONBLOCK || 0;

// ── Files, inventories and the package ──

// A file is the folder's when it is the manifest set to a port, or anything else of the allowlist, byte for byte.
function manifestOf(bytes) {
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { return null; }
  return manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : null;
}
/**
 * The pin's `files` for a package's files ([{ rel, bytes }]): each file's SHA-256, the manifest's taken with its setup
 * content script set to TEMPLATE_PORT. Throws EXTENSION_VERIFY_FAILED for files no extension folder may hold.
 */
export function packageInventory(files) {
  if (!Array.isArray(files) || !files.length || files.length > EXTENSION_MAX_FILES) throw notPinned('The extension has no files, or too many.');
  const inventory = {}, seen = new Set();
  for (const file of [...files].sort(byRel)) {
    if (!extensionFileAllowed(file?.rel) || !Buffer.isBuffer(file.bytes) || seen.has(file.rel.toLowerCase())) throw notPinned('The extension holds a file that is not allowed.');
    seen.add(file.rel.toLowerCase());
    if (file.rel === 'manifest.json') {
      const manifest = manifestOf(file.bytes);
      if (!manifest) throw notPinned('The extension\'s manifest cannot be read.');
      inventory[file.rel] = sha(serialize(folderManifest(manifest, TEMPLATE_PORT)));
    } else inventory[file.rel] = sha(file.bytes);
  }
  if (!inventory['manifest.json']) throw notPinned('The extension has no manifest.');
  return inventory;
}
const sameInventory = (a, b) => {
  const names = Object.keys(a || {});
  return names.length === Object.keys(b || {}).length && names.every(name => Object.hasOwn(b, name) && a[name] === b[name]);
};
/**
 * The files of a package that is exactly the pinned one ([{ rel, bytes }]): its size and SHA-256 are the pin's, it is
 * SynaBun's zip form, its manifest names the pinned version and key, and its files are the ones the pin lists. Throws
 * EXTENSION_VERIFY_FAILED otherwise. Writes nothing.
 */
export function verifiedPackageFiles(zip, pin = EXTENSION_PIN) {
  if (!Buffer.isBuffer(zip) || zip.length !== pin.size || sha(zip) !== pin.sha256) throw notPinned('The download is not the file this SynaBun release expects.');
  let files;
  try { files = readExtensionZip(zip); } catch (error) { throw notPinned(error?.message || 'The package cannot be read.'); }
  const manifest = manifestOf(files.find(f => f.rel === 'manifest.json').bytes);
  if (!manifest) throw notPinned('The package\'s manifest cannot be read.');
  if (manifest.version !== pin.version || manifest.key !== pin.key) throw notPinned('The package is not the extension this SynaBun release expects.');
  if (!sameInventory(packageInventory(files), pin.files)) throw notPinned('The package\'s files are not the ones this SynaBun release lists.');
  return files;
}
// The files as the folder holds them for `appPort` (the manifest set to it), the top level by name, then icons/: the
// order every folder was marked with since the first SynaBun that prepared one.
function folderFiles(files, appPort) {
  const top = files.filter(f => !f.rel.includes('/')).sort(byRel), nested = files.filter(f => f.rel.includes('/')).sort(byRel);
  return [...top, ...nested].map(f => (f.rel === 'manifest.json' ? { rel: f.rel, bytes: serialize(folderManifest(manifestOf(f.bytes), appPort)) } : { rel: f.rel, bytes: f.bytes }));
}
// The digest the marker has always carried (an older SynaBun reads it): every file's name and bytes in folder order.
function folderDigest(files) {
  const digest = createHash('sha256');
  for (const f of files) digest.update(f.rel).update('\0').update(f.bytes).update('\0');
  return digest.digest('hex');
}

// ── What is on disk, read without following a link ──

const POSIX = !WINDOWS && typeof process.getuid === 'function';
// What the ownership rule reads of the system: the platform, this process's user and group, and /etc/passwd and
// /etc/group (read as files, never through a program or NSS). `system` ({ platform, uid, gid, readFile }) replaces
// any part of it, for the tests; nothing else passes one.
function systemOf(given = null) {
  const posix = typeof process.getuid === 'function' && typeof process.getgid === 'function';
  return {
    platform: given?.platform ?? process.platform,
    uid: given?.uid ?? (posix ? process.getuid() : null),
    gid: given?.gid ?? (posix ? process.getgid() : null),
    readFile: given?.readFile ?? (path => readFileSync(path, 'utf8')),
  };
}
const PRIVATE_GROUP_UNKNOWN = 'its group can write to it, and SynaBun could not confirm from /etc/passwd and /etc/group that this group is the user\'s own private group';
// Linux's user private groups (a umask of 002): a folder its group can write is still this user's alone when that group
// is the user's primary group, named after the user, with no other member, and nobody else's primary group. Anything
// that cannot be confirmed from the two files (a user or group from LDAP or another directory, a file that cannot be
// read, a line that cannot be parsed) is refused, with the reason.
function privateGroupVerdict(folderGid, system) {
  const no = why => ({ ok: false, reason: `${PRIVATE_GROUP_UNKNOWN} (${why})` });
  const lines = path => { try { return String(system.readFile(path)).split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#')); } catch { return null; } };
  const passwd = lines('/etc/passwd');
  if (!passwd) return no('/etc/passwd could not be read');
  const group = lines('/etc/group');
  if (!group) return no('/etc/group could not be read');
  if ([...passwd, ...group].some(line => line[0] === '+' || line[0] === '-')) return no('they pull in entries from a network directory (+ or -), which SynaBun does not read');
  const id = text => (/^\d+$/.test(text) ? Number(text) : NaN);
  const users = passwd.map(line => line.split(':')).map(f => ({ ok: f.length === 7 && !!f[0], name: f[0], uid: id(f[2]), gid: id(f[3]) }));
  const groups = group.map(line => line.split(':')).map(f => ({ ok: f.length === 4 && !!f[0], name: f[0], gid: id(f[2]), members: (f[3] || '').split(',').map(m => m.trim()).filter(Boolean) }));
  if (users.some(u => !u.ok || Number.isNaN(u.uid) || Number.isNaN(u.gid))) return no('a line of /etc/passwd cannot be read');
  if (groups.some(g => !g.ok || Number.isNaN(g.gid))) return no('a line of /etc/group cannot be read');
  const me = users.filter(u => u.uid === system.uid);
  if (me.length !== 1) return no(me.length ? 'this user is listed in /etc/passwd more than once' : 'this user is not listed in /etc/passwd: an account from LDAP or another directory cannot be checked');
  const [user] = me;
  if (folderGid !== user.gid || folderGid !== system.gid) return no('the folder\'s group is not this user\'s primary group');
  const entries = groups.filter(g => g.gid === folderGid);
  if (!entries.length) return no('the group is not listed in /etc/group');
  if (entries.length > 1) return no('/etc/group lists the group more than once');
  if (entries[0].name !== user.name) return no('the group is not named after this user');
  if (entries[0].members.some(m => m !== user.name)) return no('the group has other members');
  if (users.some(u => u !== user && u.gid === folderGid)) return no('another account has it as its primary group');
  return { ok: true };
}
/**
 * Whether a folder or file (`info`: its lstat) is this user's and nobody else can write it: { ok } or { ok: false,
 * reason } (a sentence without a path). Windows has no POSIX modes to check. Others' write is never accepted; the
 * group's only on Linux, for the user's own private group (privateGroupVerdict). macOS keeps refusing it (`staff` is
 * shared). `system`: see systemOf.
 */
export function ownershipVerdict(info, given = null) {
  const system = systemOf(given);
  if (system.platform === 'win32' || system.uid === null) return { ok: true };
  if (Number(info.uid) !== system.uid) return { ok: false, reason: 'it belongs to another user' };
  const mode = Number(info.mode);
  if (mode & 0o002) return { ok: false, reason: 'other users can write to it' };
  if (!(mode & 0o020)) return { ok: true };
  if (system.platform !== 'linux') return { ok: false, reason: 'its group can write to it' };
  return privateGroupVerdict(Number(info.gid), system);
}
// A folder or file of this user that nobody else can write (a link is never one).
const ownedSafely = (info, system) => ownershipVerdict(info, system).ok;
function lstatOrNull(path) {
  try { return lstatSync(path); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
function list(dir) { try { return readdirSync(dir); } catch { return null; } }
// "<dev>:<ino>" of a real folder at `path` (never a link), or null.
function identity(path) {
  if (!path) return null;
  try { const info = lstatSync(path, { bigint: true }); return info.isDirectory() && !info.isSymbolicLink() ? `${info.dev}:${info.ino}` : null; } catch { return null; }
}
// The bytes of a regular file of at most `max` bytes, opened without following a link and without waiting on a pipe.
function readRegular(path, max = EXTENSION_MAX_FILE_BYTES) {
  let fd = null;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.size > max) return null;
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > max || (POSIX && (info.ino !== before.ino || info.dev !== before.dev))) return null;
    const bytes = Buffer.alloc(info.size);
    let at = 0;
    while (at < bytes.length) { const n = readSync(fd, bytes, at, bytes.length - at, at); if (!n) break; at += n; }
    if (at !== bytes.length || readSync(fd, Buffer.alloc(1), 0, 1, at) !== 0) return null;
    return bytes;
  } catch { return null; } finally { if (fd !== null) try { closeSync(fd); } catch {} }
}
function readJson(path) {
  const bytes = readRegular(path, 64 * 1024);
  if (!bytes) return null;
  try { const value = JSON.parse(bytes.toString('utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
}
function syncDir(dir) {
  if (WINDOWS) return;
  let fd = null;
  try { fd = openSync(dir, constants.O_RDONLY); fsyncSync(fd); } finally { if (fd !== null) closeSync(fd); }
}
function writeNew(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try { let at = 0; while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at); fsyncSync(fd); } finally { closeSync(fd); }
}
// A file replaced in one rename, synced before and after (its temporary name is one the sweep knows).
function writeDurably(path, bytes, io) {
  const temporary = `${path}.${hex()}.tmp`;
  try { writeNew(temporary, bytes); io.rename(temporary, path); } catch (error) { rmSync(temporary, { force: true }); throw error; }
  syncDir(join(path, '..'));
}

/**
 * The install root of a data home, checked: DATA_HOME resolved once, then DATA_HOME/browser-extension, each a folder of
 * this user that no one else can write (the root is never a link). Returns its paths, or null when the root is not
 * there and `create` is not set. Throws EXTENSION_FOLDER_UNSAFE (its message says why, without a path), or
 * EXTENSION_FOLDER_FAILED when it cannot be read. `system`: see systemOf.
 */
function installRoot(home, { create = false, system = null } = {}) {
  let base;
  try { base = realpathSync(String(home)); } catch (error) {
    if (error?.code === 'ENOENT' && !create) return null;
    throw failed('The data folder cannot be found.');
  }
  // A part that is not a real folder (or file) of this user that nobody else can write: refused, with the reason.
  const hold = (part, info, isKind) => {
    if (info.isSymbolicLink() || !isKind(info)) throw unsafe(part, 'it is a link or not a folder');
    const verdict = ownershipVerdict(info, system);
    if (!verdict.ok) throw unsafe(part, verdict.reason);
  };
  let root;
  try {
    hold('the data folder', lstatSync(base), info => info.isDirectory());
    root = join(base, ROOT);
    let info = lstatOrNull(root);
    if (!info) {
      if (!create) return null;
      try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
      info = lstatSync(root);
    }
    hold('its extension folder (browser-extension)', info, i => i.isDirectory());
    const lock = lstatOrNull(join(root, LOCK));
    if (lock) hold('the extension folder\'s lock file', lock, i => i.isFile());
  } catch (error) { throw asFolderError(error); }
  return { base, root, folder: join(root, FOLDER), marker: join(root, MARKER), journal: join(root, JOURNAL), cache: join(root, CACHE), lock: join(root, LOCK), system };
}
// One writer per data home: everything that changes the root, and the recovery before it, runs inside.
function withLock(paths, fn, timeoutMs = LOCK_TIMEOUT_MS) {
  const lock = createWriterLock(paths.lock, { timeoutMs });
  try { lock.enter(); } catch (error) {
    lock.close();
    throw Object.assign(failed(error?.code === 'BUSY' ? 'Another SynaBun is changing the extension folder right now. Try again in a moment.' : 'The extension folder\'s lock cannot be used.'), { cause: error });
  }
  try { return fn(); } finally { lock.leave(); lock.close(); }
}

// What the folder at `folder` holds, held to the pin: missing, unsafe (a link, not a folder, another user's), other
// (anything but the pinned files) or pinned, with the port its manifest names and the files as they are.
function inspectTree(folder, pin, system = null) {
  let info;
  try { info = lstatOrNull(folder); } catch { return { state: 'other', version: null }; }
  if (!info) return { state: 'missing' };
  if (info.isSymbolicLink() || !info.isDirectory() || !ownedSafely(info, system)) return { state: 'unsafe' };
  const other = () => ({ state: 'other', version: shownVersion(folder) });
  const wanted = Object.keys(pin.files);
  const top = new Set(wanted.filter(rel => !rel.includes('/'))), icons = new Set(wanted.filter(rel => rel.startsWith('icons/')).map(rel => rel.slice(6)));
  if (icons.size) top.add('icons');
  const same = (names, set) => !!names && names.length === set.size && names.every(name => set.has(name));
  if (!same(list(folder), top)) return other();
  if (icons.size) {
    let iconInfo;
    try { iconInfo = lstatSync(join(folder, 'icons')); } catch { return other(); }
    if (iconInfo.isSymbolicLink() || !iconInfo.isDirectory() || !ownedSafely(iconInfo, system) || !same(list(join(folder, 'icons')), icons)) return other();
  }
  const files = [];
  for (const rel of wanted) {
    const bytes = readRegular(join(folder, ...rel.split('/')));
    if (!bytes) return other();
    if (rel !== 'manifest.json' && sha(bytes) !== pin.files[rel]) return other();
    files.push({ rel, bytes });
  }
  const manifestBytes = files.find(f => f.rel === 'manifest.json').bytes, manifest = manifestOf(manifestBytes);
  const port = Number(/^http:\/\/127\.0\.0\.1:(\d{1,5})\/extension-setup\*$/.exec(manifest?.content_scripts?.[0]?.matches?.[0] || '')?.[1]);
  if (!manifest || !(port >= 1 && port <= 65535)) return other();
  // Set to that port exactly as folderManifest writes it, and otherwise the pinned manifest.
  if (!serialize(folderManifest(manifest, port)).equals(manifestBytes) || sha(serialize(folderManifest(manifest, TEMPLATE_PORT))) !== pin.files['manifest.json']) return other();
  return { state: 'pinned', port, files, version: pin.version };
}
// The version a folder's manifest names, for display only (never trusted).
function shownVersion(folder) {
  const manifest = manifestOf(readRegular(join(folder, 'manifest.json'), 256 * 1024) || Buffer.alloc(0));
  return typeof manifest?.version === 'string' && /^\d+(\.\d+){0,3}$/.test(manifest.version) ? manifest.version : null;
}

// ── The transaction ──

// 'place': no live folder, one rename. 'renames': the live folder aside, then the new one into its place.
// 'exchange' is only ever read: a record an earlier build of this branch wrote, settled by its folders' identities
// like any other (settle never needs to know how the folders were moved), and never written again.
const JOURNAL_MODES = new Set(['place', 'renames', 'exchange']);
const IDENTITY = /^\d+:\d+$/;
function readJournal(paths) {
  let info;
  try { info = lstatOrNull(paths.journal); } catch { return null; }
  if (!info) return null;
  const j = info.isFile() ? readJson(paths.journal) : null;
  const valid = j && j.v === 1 && JOURNAL_MODES.has(j.mode) && typeof j.staging === 'string' && STAGING_FOLDER.test(j.staging)
    && (j.mode === 'renames' ? typeof j.retired === 'string' && RETIRED_FOLDER.test(j.retired) : j.retired === null)
    && typeof j.next === 'string' && IDENTITY.test(j.next) && (j.mode === 'place' ? j.previous === null : typeof j.previous === 'string' && IDENTITY.test(j.previous))
    && j.marker && typeof j.marker === 'object' && typeof j.marker.version === 'string';
  // A record SynaBun did not write whole names nothing that can be trusted: it is removed, and nothing it says is done.
  if (!valid) { rmSync(paths.journal, { force: true }); return null; }
  return j;
}
/**
 * Finishes or takes back the transaction a record describes, by the folders' identities (never by their names alone).
 * `prefer`: 'forward' (a restart: the new folder, verified before it was staged, goes into place when the path is
 * empty) or 'back' (this process just failed a step: the old folder goes back). An old folder is put back by a restart
 * only when the record says it was the pinned extension. Removes the record last.
 */
function settle(paths, j, io, { prefer = 'forward' } = {}) {
  const at = name => (name ? join(paths.root, name) : null);
  const same = (a, b) => a !== null && b !== null && a === b;
  let live = identity(paths.folder);
  if (live === null) {
    if (prefer === 'forward' && same(identity(at(j.staging)), j.next)) { io.rename(at(j.staging), paths.folder); syncDir(paths.root); }
    else if (j.mode === 'renames' && same(identity(at(j.retired)), j.previous) && (prefer === 'back' || j.previousVerified === true)) { io.rename(at(j.retired), paths.folder); syncDir(paths.root); }
    live = identity(paths.folder);
  }
  if (same(live, j.next)) {
    writeDurably(paths.marker, Buffer.from(JSON.stringify(j.marker)), io);
    io.step('marked');
    // The old folder: where the first rename put it (or, for an earlier build's exchange record, the staging name).
    for (const name of [j.staging, j.retired]) if (name && same(identity(at(name)), j.previous)) rmSync(at(name), { recursive: true, force: true });
  } else if (same(identity(at(j.staging)), j.next)) {
    rmSync(at(j.staging), { recursive: true, force: true });
  }
  syncDir(paths.root);
  rmSync(paths.journal, { force: true });
  syncDir(paths.root);
  io.step('settled');
}
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };
// What SynaBun's own steps left beside the folder: removed under the lock, once no record names it. A download's
// working file only once its process is gone or it is old; an old folder only while the live one is there.
function sweep(paths, now) {
  const live = identity(paths.folder) !== null;
  for (const name of list(paths.root) || []) {
    const path = join(paths.root, name), download = DOWNLOAD_FILE.exec(name);
    let remove = STAGING_FOLDER.test(name) || TEMPORARY_FILE.test(name) || SWAP_PROBE.test(name) || (live && RETIRED_FOLDER.test(name));
    if (download) { try { remove = !pidAlive(Number(download[1])) || now - lstatSync(path).mtimeMs > STALE_DOWNLOAD_MS; } catch { remove = false; } }
    if (remove) try { rmSync(path, { recursive: true, force: true }); } catch { /* the next locked step tries again */ }
  }
}
// Inside the lock, before anything else: a stopped transaction finished or taken back, then the leftovers removed.
function recover(paths, io, now) {
  const j = readJournal(paths);
  if (j) settle(paths, j, io, { prefer: 'forward' });
  sweep(paths, now);
}
function writeTree(dir, files) {
  mkdirSync(dir, { mode: 0o700 });
  if (files.some(f => f.rel.startsWith('icons/'))) mkdirSync(join(dir, 'icons'), { mode: 0o700 });
  for (const f of files) writeNew(join(dir, ...f.rel.split('/')), f.bytes);
  if (files.some(f => f.rel.startsWith('icons/'))) syncDir(join(dir, 'icons'));
  syncDir(dir);
}
// Recognize an ordinary upgrade for the reload prompt only. Installation always verifies against the NEW pin.
// If the old manifest, contents or recorded installation disagree, keep the manual repair confirmation.
function previousInstall(paths, marker, previous, pin) {
  if (!previous?.version || previous.version !== marker?.version || compareVersions(previous.version, pin.version) >= 0) return null;
  const names = list(paths.folder);
  if (!names || names.length > EXTENSION_MAX_FILES) return null;
  const pathsInOrder = names.filter(name => name !== 'icons').sort();
  if (names.includes('icons')) {
    const icons = join(paths.folder, 'icons');
    let info;
    try { info = lstatOrNull(icons); } catch { return null; }
    if (!info?.isDirectory() || !ownedSafely(info, paths.system)) return null;
    const children = list(icons);
    if (!children || children.length + pathsInOrder.length > EXTENSION_MAX_FILES) return null;
    pathsInOrder.push(...children.sort().map(name => `icons/${name}`));
  }
  const digest = createHash('sha256');
  for (const rel of pathsInOrder) {
    if (!extensionFileAllowed(rel)) return null;
    const bytes = readRegular(join(paths.folder, rel));
    if (!bytes || (rel === 'manifest.json' && manifestOf(bytes)?.key !== pin.key)) return null;
    digest.update(rel).update('\0').update(bytes).update('\0');
  }
  return digest.digest('hex') === marker.digest ? previous.version : null;
}
// The Reload the marker asks for after a replacement (`reload`), until the setup page sees the extension running again
// (confirmExtensionReload), the new version authenticates (confirmExtensionVersion), or the owner confirms a repair.
// `repair`: the folder held files that were not the pinned extension (changed, added or
// deleted, or an unrecognized version) and they were replaced: the browser may still run them, at any version. `fromPort`: the
// same extension on another port, whose old manifest the browser keeps until a Reload. A Reload asked for before and
// not yet seen is kept (a repair stays a repair). A first install (no folder) asks for none.
function reloadAfter(pending, previous, port, fromVersion) {
  const kept = pending && typeof pending === 'object' && !Array.isArray(pending) ? pending : null;
  if (fromVersion && !kept?.repair) return { reload: { fromVersion } };
  const repair = previous?.state === 'other' || kept?.repair === true;
  const fromPort = previous?.state === 'pinned' && previous.port !== port ? previous.port : Number.isInteger(kept?.fromPort) ? kept.fromPort : null;
  if (!repair && fromPort === null && !kept) return {};
  return { reload: { ...(fromPort !== null ? { fromPort } : {}), ...(repair ? { repair: true } : {}),
    ...(!repair && kept?.fromVersion ? { fromVersion: kept.fromVersion } : {}) } };
}
const reloadReasonOf = reload => (!reload ? null : reload.repair === true ? 'repair' : reload.fromVersion ? 'version' : 'port');
// The verified files into the browser's path for `port`, as one transaction. `previous`: what inspectTree said of the
// folder that is there. Returns the marker written.
function place(paths, { files, port, pin, now, io, previous }) {
  const wanted = folderFiles(files, port);
  const staging = join(paths.root, `unpacked.${process.pid}.${hex()}.tmp`);
  // Until the record is written nothing names the staged folder: a failure here removes it at once.
  const unstage = error => { rmSync(staging, { recursive: true, force: true }); throw error; };
  try { writeTree(staging, wanted); } catch (error) { unstage(error); }
  io.step('staged');
  const live = identity(paths.folder);
  const mode = live ? 'renames' : 'place';
  const oldMarker = readJson(paths.marker);
  const fromVersion = previous?.state === 'other' ? previousInstall(paths, oldMarker, previous, pin) : null;
  const marker = { v: 1, version: pin.version, digest: folderDigest(wanted), appPort: port, preparedAt: now(), package: pin.sha256,
    ...reloadAfter(oldMarker?.reload, previous, port, fromVersion) };
  const j = { v: 1, mode, staging: basename(staging), retired: mode === 'renames' ? `unpacked.${hex()}.old` : null, next: identity(staging), previous: live,
    previousVerified: previous?.state === 'pinned', marker };
  try { writeDurably(paths.journal, Buffer.from(JSON.stringify(j)), io); } catch (error) { unstage(error); }
  io.step('journaled');
  try {
    if (mode === 'renames') {
      // A folder that cannot be moved (Windows, a folder the browser holds open) fails here: nothing has moved yet.
      io.rename(paths.folder, join(paths.root, j.retired));
      // Between these two renames the browser's path is empty for a moment; the record says how to finish or take it back.
      io.step('retired');
      io.rename(staging, paths.folder);
    } else io.rename(staging, paths.folder);
    syncDir(paths.root);
    io.step('swapped');
  } catch (error) {
    try { settle(paths, j, io, { prefer: 'back' }); } catch { /* the record stays: the next locked step settles it */ }
    throw error;
  }
  settle(paths, j, io);
  return marker;
}
function ioOf(io = {}) { return { rename: io.rename || renameSync, step: io.step || (() => {}) }; }
const markerShape = marker => (marker ? { version: marker.version || null, appPort: marker.appPort ?? null, preparedAt: marker.preparedAt ?? null, package: typeof marker.package === 'string' ? marker.package : null } : null);
// A folder that holds the pinned files for `port` with a marker that says otherwise: the marker follows the files.
function reconcileMarker(paths, files, port, pin, now, io) {
  const marker = readJson(paths.marker), digest = folderDigest(folderFiles(files, port));
  // A marker from before downloads names no package: left as it is (an older SynaBun reads it the same way).
  if (marker && marker.version === pin.version && marker.digest === digest && marker.appPort === port && (marker.package == null || marker.package === pin.sha256)) return false;
  const record = { v: 1, version: pin.version, digest, appPort: port, preparedAt: marker?.preparedAt ?? now(), package: pin.sha256, ...(marker?.reload ? { reload: marker.reload } : {}) };
  writeDurably(paths.marker, Buffer.from(JSON.stringify(record)), io);
  return true;
}
function readCache(paths, pin) {
  const bytes = readRegular(paths.cache, pin.size);
  if (!bytes) return null;
  try { return verifiedPackageFiles(bytes, pin); } catch { return null; }
}

// ── What the server calls ──

/**
 * What the folder holds now, read-only and without a lock: { state, folder, version, port }. `state`: 'missing' (no
 * folder), 'unsafe' (its root or the folder is a link, not a folder, another user's or writable by others), 'current'
 * (exactly the pinned extension, set to `appPort`), 'retarget' (exactly the pinned extension, set to another port:
 * no download needed) or 'other' (anything else: an older or newer version, a changed, added or deleted file).
 */
export function inspectExtensionFolder({ home, appPort, pin = EXTENSION_PIN, system = null }) {
  const folder = join(home, ROOT, FOLDER);
  let paths;
  try { paths = installRoot(home, { system }); } catch (error) { return error?.code === 'EXTENSION_FOLDER_UNSAFE' ? { state: 'unsafe', folder, version: null, port: null, reason: error.reason } : { state: 'other', folder, version: null, port: null }; }
  if (!paths) return { state: 'missing', folder, version: null, port: null };
  const look = inspectTree(paths.folder, pin, paths.system);
  if (look.state === 'pinned') return { state: look.port === Number(appPort) ? 'current' : 'retarget', folder, version: pin.version, port: look.port };
  return { state: look.state, folder, version: look.version ?? null, port: null };
}

/**
 * Puts the pinned extension into the owner's folder, set to `appPort`. `files` ([{ rel, bytes }]: a verified package's;
 * or, with `source`, a folder's own, read through the allowlist) must be exactly the files the pin lists, else
 * EXTENSION_VERIFY_FAILED and nothing is written. `zip`: the verified package itself, kept for a repair with no network.
 * Nothing is written when the folder already holds exactly these files for this port (its marker is brought in line).
 * Returns { folder, version, changed, previousVersion, appPort, stale }; throws EXTENSION_FOLDER_FAILED (the folder and
 * its marker are as they were, or the record of a stopped step is left for the next one) or EXTENSION_FOLDER_UNSAFE.
 * `io` ({ rename, step }) is for the tests of those failures.
 */
export function prepareExtensionFolder({ files, source, zip = null, home, appPort, pin = EXTENSION_PIN, now = Date.now, io: given = {}, lockTimeoutMs = LOCK_TIMEOUT_MS, system = null }) {
  const port = Number(appPort);
  setupMatches(port);
  const io = ioOf(given);
  const offered = source ? readExtensionSource(source) : files;
  if (!sameInventory(packageInventory(offered), pin.files)) throw notPinned('These are not the extension files this SynaBun release pins.');
  const shown = join(home, ROOT, FOLDER);
  const paths = installRoot(home, { create: true, system });
  try {
    return withLock(paths, () => {
      recover(paths, io, now());
      if (zip) { try { if (verifiedPackageFiles(zip, pin) && !readRegular(paths.cache, pin.size)?.equals(zip)) writeDurably(paths.cache, zip, io); } catch { /* a repair then downloads it again */ } }
      const before = inspectTree(paths.folder, pin, paths.system), marker = markerShape(readJson(paths.marker));
      if (before.state === 'unsafe') throw unsafe('the extension folder (unpacked)');
      if (before.state === 'pinned' && before.port === port) {
        reconcileMarker(paths, before.files, port, pin, now, io);
        return { folder: shown, version: pin.version, changed: false, previousVersion: pin.version, appPort: port, stale: false };
      }
      place(paths, { files: offered, port, pin, now, io, previous: before });
      const after = inspectTree(paths.folder, pin, paths.system);
      if (after.state !== 'pinned' || after.port !== port) throw failed('The extension folder does not hold what was written.');
      return { folder: shown, version: pin.version, changed: true, previousVersion: before.state === 'pinned' ? pin.version : marker?.version || before.version || null, appPort: port, stale: false };
    }, lockTimeoutMs);
  } catch (error) { throw asFolderError(error); }
}

/**
 * At start-up and before a setup uses the folder (no network): under the lock, a stopped transaction is settled and
 * leftovers removed; then the folder is held to the pin. The pinned extension on another port is rewritten for
 * `appPort` from its own verified files; anything else is repaired from the verified package this data home keeps,
 * when it has one (else it waits for a download: `state` 'other'). Returns { folder, version, changed, state, reason }
 * (`reason`: 'port' or 'repair' when something was written). A data home with no extension folder is not touched.
 * Throws EXTENSION_FOLDER_UNSAFE or EXTENSION_FOLDER_FAILED (a port that could not be set is a failure, never `unchanged`).
 */
export function retargetExtensionFolder({ home, appPort, pin = EXTENSION_PIN, now = Date.now, io: given = {}, lockTimeoutMs = LOCK_TIMEOUT_MS, system = null }) {
  const port = Number(appPort);
  setupMatches(port);
  const io = ioOf(given), shown = join(home, ROOT, FOLDER);
  const paths = installRoot(home, { system });
  if (!paths) return { folder: shown, version: null, changed: false, state: 'missing', reason: null };
  try {
    return withLock(paths, () => {
      recover(paths, io, now());
      const look = inspectTree(paths.folder, pin, paths.system);
      if (look.state === 'unsafe') throw unsafe('the extension folder (unpacked)');
      if (look.state === 'missing') return { folder: shown, version: null, changed: false, state: 'missing', reason: null };
      let files = null, reason = null;
      if (look.state === 'pinned') {
        if (look.port === port) { reconcileMarker(paths, look.files, port, pin, now, io); return { folder: shown, version: pin.version, changed: false, state: 'current', reason: null }; }
        files = look.files; reason = 'port';
      } else {
        files = readCache(paths, pin); reason = 'repair';
        if (!files) return { folder: shown, version: look.version ?? null, changed: false, state: 'other', reason: null };
      }
      place(paths, { files, port, pin, now, io, previous: look });
      const after = inspectTree(paths.folder, pin, paths.system);
      if (after.state !== 'pinned' || after.port !== port) throw failed('The extension folder does not hold what was written.');
      return { folder: shown, version: pin.version, changed: true, state: 'current', reason };
    }, lockTimeoutMs);
  } catch (error) { throw asFolderError(error); }
}

/**
 * The verified package this data home keeps (written after a download), or null: read and checked against the pin
 * like a download, so a changed or foreign file is simply not used.
 */
export function cachedExtensionPackage({ home, pin = EXTENSION_PIN }) {
  try { const paths = installRoot(home); return paths ? readCache(paths, pin) : null; } catch { return null; }
}
/** The root a download's working file goes into, checked (created when missing). Throws EXTENSION_FOLDER_UNSAFE / _FAILED. */
export function extensionWorkDir(home) { return installRoot(home, { create: true }).root; }

// The marker's pending Reload removed under the lock, when `clears(reload, marker)` says so. Returns whether it was.
function clearReload(home, io, clears, remaining = () => null) {
  let paths;
  try { paths = installRoot(home); } catch { return false; }
  if (!paths) return false;
  try {
    return withLock(paths, () => {
      const marker = readJson(paths.marker);
      if (!marker?.reload || !clears(marker.reload, marker)) return false;
      const { reload, ...rest } = marker;
      const pending = remaining(reload);
      if (pending) rest.reload = pending;
      writeDurably(paths.marker, Buffer.from(JSON.stringify(rest)), io);
      return true;
    });
  } catch { return false; }
}

/**
 * The setup page saw the extension's content script on `appPort` (POST …/setup/seen, the one caller): the browser
 * runs the folder's manifest for this port, so the Reload a port change asked for is done. Returns whether a pending
 * Reload was cleared. A repair's Reload is never cleared here: the copy the browser still runs (changed code included)
 * has the same matches and version, so it answers the setup page just the same; only the owner's confirmation clears
 * it (confirmExtensionRepairReload). A port change while a repair is pending keeps the repair (reloadAfter). Nothing
 * else clears either: a restart, a same-version start or a background refresh keeps the marker's `reload`
 * (reconcileMarker carries it).
 */
export function confirmExtensionReload({ home, appPort, io: given = {} }) {
  return clearReload(home, ioOf(given), (reload, marker) => !reload.fromVersion && reload.repair !== true && marker.appPort === Number(appPort));
}

// A newly authenticated browser reported the installed version. This clears only an ordinary version upgrade.
export function confirmExtensionVersion({ home, version, io: given = {} }) {
  // A same-version port change after this upgrade still needs the content script on the new port.
  return clearReload(home, ioOf(given), (reload, marker) => !!reload.fromVersion && !reload.repair && marker.version === version,
    reload => Number.isInteger(reload.fromPort) ? { fromPort: reload.fromPort } : null);
}

/**
 * The owner said, in Settings, that they reloaded the extension after a repair (POST …/reload/confirm, the one caller:
 * a deliberate click, never a page load, a poll, the setup page or the extension bridge). Clears a pending repair's
 * Reload (and a port change pending with it); a port change alone keeps its own rule (confirmExtensionReload). Returns
 * whether something was cleared.
 */
export function confirmExtensionRepairReload({ home, io: given = {} }) {
  return clearReload(home, ioOf(given), reload => reload.repair === true);
}

/**
 * What the folder's marker says, without writing or verifying: { folder, version, prepared, present, appPort,
 * preparedAt, package, reloadPending, reloadReason, fromVersion? }. `reloadReason`: 'version' for an upgrade from an
 * intact recorded installation, 'repair' (files that were not the pinned
 * extension were replaced) or 'port' (only the setup port changed), while a Reload is pending; else null. For display
 * only: whether the folder is the pinned extension is inspectExtensionFolder's answer, never this one.
 */
export function extensionFolderState(home) {
  const root = join(home, ROOT), folder = join(root, FOLDER), marker = readJson(join(root, MARKER));
  let present = false;
  try { const info = lstatSync(folder); present = info.isDirectory() && !info.isSymbolicLink() && lstatSync(join(folder, 'manifest.json')).isFile(); } catch { present = false; }
  return { folder, version: typeof marker?.version === 'string' ? marker.version : null, prepared: !!marker, present, appPort: marker?.appPort ?? null,
    preparedAt: marker?.preparedAt ?? null, package: typeof marker?.package === 'string' ? marker.package : null, reloadPending: !!marker?.reload,
    reloadReason: reloadReasonOf(marker?.reload), ...(marker?.reload?.fromVersion ? { fromVersion: marker.reload.fromVersion } : {}), root };
}

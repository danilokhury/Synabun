// ── The File Explorer's routes ──
// Everything the explorer panel asks the server for, mounted at /api/explorer:
//
//   GET  /info                      what this server and its system can do
//   GET  /list?path=                one folder: its entries, nothing of git
//   GET  /search?root=&q=           entries of a project by name
//   GET  /git?root=                 the git state of a project: branch, changed paths, ignored paths
//   GET  /watch?root=               an event stream: which shown folders changed, and when git may have
//   POST /watch/:id   { dirs }      the folders the page shows now
//   POST /create      { parent, name, type }
//   POST /rename      { path, name }
//   POST /move        { paths, into, replace?, permanent? }
//   POST /copy        { paths, into, replace?, permanent? }   into its own folder: a copy next to the original
//   POST /delete      { paths, permanent? }          to the system's Trash, unless `permanent`
//   POST /upload?into=&name=&rel=&replace=&permanent=   the request body is the file
//   POST /reveal      { path }                       show it in the system's file manager
//   GET  /raw?path=                 the bytes of an image, for the preview
//
// A path is allowed when it is inside one of the folders the server registers
// (the projects and the data home), judged as written and then as the disk
// resolves it (lib/confined-fs.js): a link that leads out of its folder is
// refused, never followed. A registered folder itself, and a folder that holds
// one, is never renamed, moved, deleted or replaced from here: judged by what
// the entry is on disk (device and inode), because a spelling says nothing on
// a disk that does not tell case apart. What a replace clears goes to the
// Trash; it is removed for good only by a request that says `permanent`, as a
// delete is. Names are checked here, whatever the page checked. A failure
// answers `{ ok: false, code, error }`: the page words `code` in the user's
// language, `error` is for a log. A batch that stopped midway also says what
// it had done (`moved`, `copied` or `deleted`) and the entry it stopped at
// (`failed`).
//
// Nothing that was checked is trusted across a wait. A request that waits (for
// the Trash, a copy, an upload's body) checks again before each thing it then
// does that both ends are where they were checked to be: the same folders, by
// device and inode, inside their root. One swapped for a link meanwhile
// answers `changed` and nothing more is touched. A copy holds to that all the
// way down: every folder it makes, and every folder it reads, is remembered by
// device and inode and looked at again before the next thing is written into
// it or read from it; a file is read and written through handles opened
// without following a link. And a name is given only while it is free: an
// entry is placed exclusively (a rename onto a placeholder that was just made
// exclusively, an exclusive copy, a folder made exclusively), so a file that
// turns up at a destination nobody was asked about is a conflict (`exists`),
// never something that was replaced. (What stays open: the instant between a
// placeholder and the rename onto it, which renameExclusive in
// lib/file-explorer-system.js describes; and what lib/confined-fs.js says of
// itself: Node has no openat(), so a swap timed inside one synchronous
// check-and-use is not excluded.)
//
// A move is a rename and nothing else. To another disk a rename cannot be
// made, and the move is not made up of a copy and a removal instead (a copy
// that missed a file, or was overtaken by a save, would lose it with the
// original): the answer is `other-disk`, and nothing is touched.
//
// Who may ask is the `guard` (server.js: lib/http-guards.js ownerRouteGuard):
// the owner, on this server's own Host, and for a write from this server's page.
// The guard looks at the Origin of a write only, and a read here is not
// harmless (a watch is a session, git is a process, a search walks a project):
// a read from another site's page is refused here as well, before anything is
// set up (`isForeignRead`).
// Dependencies are injected: the router is tested on a bare app.

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, createWriteStream, fchmodSync, fstatSync, futimesSync, lstatSync, mkdirSync, openSync, read as readHandle,
  readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, write as writeHandle,
} from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { PathConfineError, isInside } from './path-confine.js';
import { canonicalInside, openConfinedStream, removeConfinedEntry } from './confined-fs.js';
import { matchFileRoots, useFileRoot } from './editor-files-api.js';
import { runGit } from './editor-git-api.js';
import { TrashUnavailable, createRevealer, createTrash, renameExclusive } from './file-explorer-system.js';
import { isAllowedWebSocketOrigin } from './http-guards.js';
import { createTreeWatcher, watchStrategy } from './file-explorer-watch.js';
import { compareNames, copyName, validateName } from '../public/shared/explorer/fx-names.js';

/** What `GET /api/editor/capabilities` lists when these routes are mounted. */
export const EXPLORER_CAPABILITIES = Object.freeze(['explorer']);
export const LISTING_CAP = 5000;
export const SEARCH_LIMIT = 300;
export const SEARCH_BUDGET_MS = 1500;
export const SEARCH_MAX_VISITED = 200000;
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
export const MAX_RAW_BYTES = 30 * 1024 * 1024;
export const MAX_BATCH = 500;
export const MAX_WATCH_SESSIONS = 16;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_STATUS_TIMEOUT_MS = 15000;
const STAT_PARALLEL = 64;
const COPY_CHUNK_BYTES = 1024 * 1024;
const O_NOFOLLOW = constants.O_NOFOLLOW || 0;
const O_NONBLOCK = constants.O_NONBLOCK || 0;
const O_DIRECTORY = constants.O_DIRECTORY || 0;
const readFrom = promisify(readHandle);
const writeTo = promisify(writeHandle);

/** The images the preview shows, and the type each is served as. */
export const RAW_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif', '.svg': 'image/svg+xml',
});

const ERRORS = {
  'bad-request': 'The request is missing something.',
  outside: 'Path outside registered project roots',
  gone: 'That file or folder is no longer there.',
  denied: 'The system did not allow that (no permission).',
  'not-dir': 'That is not a folder.',
  exists: 'Something with that name is already there.',
  'invalid-name': 'That name cannot be used on this system.',
  root: 'A project folder is not renamed, moved, deleted or replaced from here.',
  'into-self': 'A folder cannot be moved or copied into itself.',
  'no-trash': 'There is no Trash for that path. Nothing was removed.',
  changed: 'A folder changed while this was under way. Nothing more was done.',
  'other-disk': 'That is on another disk. It is not moved from here: copy it there, then delete the original.',
  'no-reveal': 'This system has no file manager to show it in.',
  'too-large': 'That file is too large.',
  'not-image': 'That is not an image the preview shows.',
  busy: 'The file is in use by another program.',
  'no-space': 'The disk is full.',
  limit: 'Too many at once.',
  failed: 'That did not work.',
};

const slashes = (path) => String(path).replace(/\\/g, '/');
const trimSlash = (path) => { const p = slashes(path); return p.length > 1 ? p.replace(/\/+$/, '') : p; };
const isText = (value) => typeof value === 'string' && value.length > 0 && !value.includes('\0');

/**
 * What an entry is on disk, whatever it is called: its device and inode (the entry itself: a link is the link).
 * As whole numbers of any size, because a Windows file id does not fit a double. Null when it is not there, or
 * on a disk that gives no inode.
 */
export function entryId(path) {
  try { const st = lstatSync(path, { bigint: true }); return st.ino ? `${st.dev}:${st.ino}` : null; } catch { return null; }
}

/** What open file a stat describes: its device and inode, as `entryId()` says them. Null on a disk that gives none. */
const idOf = (st) => (st.ino ? `${st.dev}:${st.ino}` : null);

/**
 * The bytes of one file, from one open handle to another.
 * @param {number} input @param {number} output file descriptors
 */
export async function pumpFile(input, output) {
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  for (;;) {
    const { bytesRead } = await readFrom(input, buffer, 0, buffer.length, null);
    if (!bytesRead) return;
    for (let at = 0; at < bytesRead;) at += (await writeTo(output, buffer, at, bytesRead - at, null)).bytesWritten;
  }
}

/**
 * Whether a read (GET, HEAD) comes from the page of another site. A browser says so in one of two ways: the
 * Origin of a request it sends across origins (an EventSource, a fetch), judged by the rule of every WebSocket
 * (isAllowedWebSocketOrigin: this server under one of its own names, or one of `allowedOrigins`); and, where it
 * sends no Origin (an image, a link), `Sec-Fetch-Site`, which must then be `same-origin` or `none` (an address
 * that was typed). A request that carries neither is not a browser's (a test, a tool) and passes.
 * @param {{ method: string, headers: object }} req
 * @param {{ port?: number | string, allowedOrigins?: string[] | (() => string[]), machineName?: any }} [origins]
 */
export function isForeignRead(req, origins = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.headers?.origin !== undefined) return !isAllowedWebSocketOrigin(req, origins || {});
  const site = req.headers?.['sec-fetch-site'];
  return site !== undefined && site !== 'same-origin' && site !== 'none';
}

/** A failure as the routes answer it. */
class ExplorerError extends Error {
  constructor(status, code, extra = {}) {
    super(ERRORS[code] || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** What an errno means to the user. */
export function codeOfErrno(error) {
  switch (error?.code) {
    case 'ENOENT': return [404, 'gone'];
    case 'EACCES': case 'EPERM': case 'EROFS': return [403, 'denied'];
    case 'EEXIST': case 'ENOTEMPTY': case 'ERR_FS_CP_EEXIST': return [409, 'exists'];
    case 'ENOTDIR': return [400, 'not-dir'];
    case 'EBUSY': case 'ETXTBSY': return [423, 'busy'];
    case 'ENOSPC': case 'EDQUOT': return [507, 'no-space'];
    case 'ENAMETOOLONG': case 'EINVAL': case 'EILSEQ': return [400, 'invalid-name'];
    default: return [500, 'failed'];
  }
}

/**
 * Read what `git status --porcelain=v1 -z --ignored` printed.
 * @param {string} text @param {string} prefix the project's folder below the repository's, '' or `a/b/`
 * @returns {{ changes: Record<string, string>, ignored: string[] }} paths below the project; a folder ends in `/`
 */
export function parseGitStatus(text, prefix = '') {
  const changes = {};
  const ignored = [];
  const fields = String(text).split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const x = entry[0]; const y = entry[1];
    let path = entry.slice(3);
    // A rename or a copy is followed by the path it came from.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++;
    if (prefix) {
      if (!path.startsWith(prefix)) continue;
      path = path.slice(prefix.length);
    }
    if (!path) continue;
    const xy = x + y;
    if (xy === '!!') { ignored.push(path); continue; }
    let status;
    if (xy === '??') status = 'untracked';
    else if (x === 'U' || y === 'U' || xy === 'DD' || xy === 'AA') status = 'conflict';
    else if (x === 'A') status = 'added';
    else if (x === 'D' || y === 'D') status = 'deleted';
    else if (x === 'R') status = 'renamed';
    else if (x !== ' ' && y !== ' ') status = 'mixed';
    else if (x !== ' ') status = 'staged';
    else if (y !== ' ') status = 'modified';
    else continue;
    changes[path] = status;
  }
  return { changes, ignored };
}

/**
 * The folder a request names, where it really is inside one of the registered folders (a registered folder
 * itself included). Throws PathConfineError (403) for a path outside them, or out of one through a link. For
 * the routes of server.js that run git in a folder they are given (as lib/git-diff-api.js judges its own).
 * @param {string} path @param {{ dirs?: string[] }} roots
 */
export function confinedFolder(path, roots) {
  return useFileRoot(String(path), { dirs: (roots?.dirs || []).filter(Boolean), files: [] }, (match) => canonicalInside(match.base, match.path, { allowBase: true }));
}

/** Run `work` over `items`, at most `limit` at a time, keeping their order. */
async function mapLimit(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await work(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

/**
 * @param {object} deps
 * @param {() => { dirs: string[] }} deps.fileRoots the folders validateProjectPath() allows
 * @param {(req, res, next) => void} [deps.guard] who may use these routes
 * @param {{ port?: number | string, allowedOrigins?: string[] | (() => string[]), machineName?: any }} [deps.origins]
 *   whose pages may read (isForeignRead): the server's port and the public addresses it is reached at
 * @param {typeof runGit} [deps.git]
 * @param {ReturnType<typeof createTrash>} [deps.trash] @param {ReturnType<typeof createRevealer>} [deps.revealer]
 * @param {string} [deps.platform] @param {'recursive' | 'folders'} [deps.watch] how folders are watched
 * @param {Function} [deps.watchImpl] the system's watch (node:fs `watch`), for a test that has it fail
 * @param {{ rename?: typeof renameSync, pump?: typeof pumpFile, device?: (path: string) => any }} [deps.io]
 *   how a name is given (`rename`), how the bytes of one file are copied (`pump`) and which disk an entry is on
 *   (`device`), for a test that needs another disk or a moment in the middle of a request
 * @param {(line: string) => void} [deps.log] what the server's log is told (something that was left behind)
 * @param {{ now?: () => number, setTimer?: Function, clearTimer?: Function }} [deps.watchClock] the clock of the
 *   watcher's waits (lib/file-explorer-watch.js), for a test that moves it by hand
 * @param {number} [deps.maxUploadBytes] @param {number} [deps.listingCap]
 * @returns {import('express').Router & { close: () => void, sessions: () => number }}
 */
export function createFileExplorerRouter({
  fileRoots, guard = null, origins = {}, git = runGit, trash = createTrash(), revealer = createRevealer(),
  platform = process.platform, watch = watchStrategy(), watchImpl = undefined, watchClock = {}, io = {}, log = (line) => console.warn(line),
  maxUploadBytes = MAX_UPLOAD_BYTES, listingCap = LISTING_CAP,
} = {}) {
  if (typeof fileRoots !== 'function') throw new Error('createFileExplorerRouter requires fileRoots');
  const rename = io.rename || renameSync;
  const pump = io.pump || pumpFile;
  const device = io.device || ((path) => lstatSync(path).dev);
  const router = Router();
  if (typeof guard === 'function') router.use(guard);
  // Before any route, so before anything is set up: a stream is a watch session, of which there are sixteen.
  router.use((req, res, next) => {
    if (!isForeignRead(req, origins)) return next();
    return res.status(403).json({ ok: false, code: 'BAD_ORIGIN', error: 'Unexpected Origin header.' });
  });

  // The folders only: a single file the editor is allowed by name is not something the explorer manages.
  const roots = () => ({ dirs: (fileRoots()?.dirs || []).filter(Boolean), files: [] });
  const sessions = new Map();   // watch id → { watcher, root, real, res, written: Map<real dir, written dir> }
  const gitKnown = new Map();   // canonical project folder → { dirs: string[], files: Set<string> } git ignores
  const gitFlights = new Map(); // canonical project folder → the status being read

  function answer(res, error) {
    const done = error?.midway || {};
    if (error instanceof ExplorerError) return res.status(error.status).json({ ok: false, code: error.code, error: error.message, ...error.extra, ...done });
    if (error instanceof PathConfineError) {
      const code = error.status === 403 ? 'outside' : error.status === 404 ? 'gone' : 'failed';
      return res.status(error.status).json({ ok: false, code, error: error.message, ...done });
    }
    if (error instanceof TrashUnavailable) return res.status(409).json({ ok: false, code: 'no-trash', error: ERRORS['no-trash'], ...done });
    const [status, code] = codeOfErrno(error);
    return res.status(status).json({ ok: false, code, error: code === 'failed' ? (error?.message || ERRORS.failed) : ERRORS[code], ...done });
  }
  // A batch that stopped midway: its failure carries what had been done by then and the entry it stopped at.
  const midway = (error, done) => Object.assign(error, { midway: done });
  const route = (handler) => async (req, res) => { try { await handler(req, res); } catch (error) { if (!res.headersSent) answer(res, error); else res.end(); } };
  const need = (ok, code = 'bad-request', status = 400, extra) => { if (!ok) throw new ExplorerError(status, code, extra); };
  const goodName = (name) => { const why = validateName(name, { platform }); if (why) throw new ExplorerError(400, 'invalid-name', { reason: why }); };

  /** A folder a request names: where it really is, inside the root that holds it, and which folder that is (`id`). */
  function folderOf(path) {
    need(isText(path));
    return useFileRoot(path, roots(), (match) => {
      const real = canonicalInside(match.base, match.path, { allowBase: true });
      return { base: match.base, written: trimSlash(match.target), real, id: entryId(real) };
    });
  }

  /**
   * The entries on disk that are a registered folder or lead to one, by device and inode: each registered folder
   * as it is written (the entry itself: a registered link is the link) and as the disk resolves it, and every
   * folder above either. A spelling says nothing where the disk does not tell case apart, or keeps a name in
   * another Unicode form: there `/p/linked` is `/p/Linked`.
   */
  function rootMarks(known) {
    const marks = new Set();
    const climb = (from) => {
      for (let at = from; ;) {
        const id = entryId(at);
        if (id) marks.add(id);
        const up = dirname(at);
        if (up === at) return;
        at = up;
      }
    };
    for (const dir of known.dirs) {
      climb(resolve(dir));
      try { climb(realpathSync(dir)); } catch { /* not there: nothing of it is on disk */ }
    }
    return marks;
  }
  // The marks as they are now, worked out once for everything that is checked without a wait in between (a
  // batch of five hundred renames asks once); after any wait they are read from the disk again.
  let marksMemo = null;
  function marksNow(known) {
    if (!marksMemo) {
      marksMemo = rootMarks(known);
      queueMicrotask(() => { marksMemo = null; });
    }
    return marksMemo;
  }

  /**
   * Whether an entry is a registered folder or holds one: by the path it is written as, and by what it is on disk.
   * A link that merely points at a registered folder is neither (removing it removes nothing of what it points
   * to); the link a registered folder is written as, or one on the way to it, is.
   */
  function holdsRoot(known, written, entry, st) {
    const at = resolve(written);
    if (known.dirs.some((dir) => { const root = resolve(dir); return root === at || isInside(at, root); })) return true;
    if (!st) return false;
    const id = entryId(entry);
    if (id) return marksNow(known).has(id);
    // A disk that gives no inode: by where the path resolves.
    if (st.isSymbolicLink()) return false;
    let real = entry;
    try { real = realpathSync(entry); } catch { /* judged as written */ }
    return known.dirs.some((dir) => { try { const root = realpathSync(dir); return root === real || isInside(real, root); } catch { return false; } });
  }

  /**
   * An entry a request names, as it is itself: the folder that holds it is resolved, its own name is kept, so
   * a link is the link and never what it points to. `protect` refuses a registered folder and one that holds one.
   * `id` and `parentId` are what the entry and its folder are on disk, for the checks that follow a wait.
   */
  function entryOf(path, { protect = false } = {}) {
    need(isText(path));
    const known = roots();
    const { target, matches } = matchFileRoots(path, known);
    if (!matches.length) throw new ExplorerError(403, 'outside');
    if (protect && (matches.some((match) => match.isBase) || known.dirs.some((dir) => isInside(target, dir)))) throw new ExplorerError(403, 'root');
    return useFileRoot(path, known, (match) => {
      if (match.isBase) throw new ExplorerError(403, 'root');
      const parent = canonicalInside(match.base, dirname(match.path), { allowBase: true });
      const name = basename(match.path);
      const entry = join(parent, name);
      let st = null;
      try { st = lstatSync(entry); } catch { st = null; }
      // What it really is must not be a registered folder either (a link's own entry is fine: it is a link).
      if (protect && holdsRoot(known, target, entry, st)) throw new ExplorerError(403, 'root');
      return { base: match.base, parent, parentId: entryId(parent), name, entry, st, id: st ? entryId(entry) : null, written: trimSlash(match.target) };
    });
  }

  const present = (found) => { if (!found.st) throw new ExplorerError(404, 'gone'); return found; };
  const exists = (path) => { try { lstatSync(path); return true; } catch { return false; } };
  const sameEntry = (a, b) => { const id = entryId(a); return !!id && id === entryId(b); };
  const changed = (extra) => new ExplorerError(409, 'changed', extra);

  /**
   * A folder that was checked is still that folder: where the disk resolves it, inside its root, and the same one
   * (device and inode). For after anything a request waited for, and right before it uses the folder: one that
   * was swapped for a link in the meantime would take a write, a move or a removal somewhere else.
   */
  function sameFolder(base, real, id) {
    let now = null;
    try { now = canonicalInside(base, real, { allowBase: true }); } catch { now = null; }
    if (now !== real || (id && entryId(real) !== id)) throw changed();
  }
  /** An entry that was checked is still that entry, in the folder it was in. Throws `gone` when it is not there. */
  function sameEntryStill(found) {
    sameFolder(found.base, found.parent, found.parentId);
    const id = entryId(found.entry);
    if (!id && !exists(found.entry)) throw new ExplorerError(404, 'gone', { name: found.name });
    if (found.id && id !== found.id) throw changed({ name: found.name });
  }

  // ── What the server can do ──
  router.get('/info', (req, res) => {
    res.json({
      ok: true, version: 1, platform, trash: !!trash?.available?.(), reveal: !!revealer?.available?.(), watch: true,
      maxUploadBytes, listingCap, images: Object.keys(RAW_TYPES),
    });
  });

  // ── One folder ──
  router.get('/list', route(async (req, res) => {
    const dir = folderOf(req.query.path);
    let dirents = await readdir(dir.real, { withFileTypes: true });
    const total = dirents.length;
    const truncated = total > listingCap;
    if (truncated) {
      dirents.sort((a, b) => (a.isDirectory() !== b.isDirectory() ? (a.isDirectory() ? -1 : 1) : compareNames(a.name, b.name)));
      dirents = dirents.slice(0, listingCap);
    }
    const realBase = realpathSync(dir.base);
    const items = await mapLimit(dirents, STAT_PARALLEL, async (entry) => {
      const full = join(dir.real, entry.name);
      if (entry.isDirectory()) return { name: entry.name, type: 'dir' };
      if (entry.isSymbolicLink()) {
        try {
          const real = await realpath(full);
          // A link that leaves its project is shown, and is not followed.
          if (real !== realBase && !isInside(realBase, real)) return { name: entry.name, type: 'file', link: true, outside: true };
          const st = await stat(real);
          return st.isDirectory() ? { name: entry.name, type: 'dir', link: true } : { name: entry.name, type: 'file', link: true, size: st.size, mtime: st.mtimeMs };
        } catch { return { name: entry.name, type: 'file', link: true, broken: true }; }
      }
      if (!entry.isFile()) return { name: entry.name, type: 'file', special: true };
      try { const st = await lstat(full); return { name: entry.name, type: 'file', size: st.size, mtime: st.mtimeMs }; }
      catch { return { name: entry.name, type: 'file' }; }
    });
    items.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : compareNames(a.name, b.name)));
    res.json({ ok: true, path: dir.written, items, total, truncated });
  }));

  // ── The git state of a project ──
  async function readGit(real) {
    const top = await git(['rev-parse', '--show-toplevel'], { cwd: real, maxBuffer: 1024 * 1024 });
    if (!top.ok) return { isGit: false };
    let repo = top.stdout.toString('utf8').trim();
    try { repo = realpathSync(repo); } catch { /* as git printed it */ }
    const below = slashes(relative(repo, real));
    if (below.startsWith('..')) return { isGit: false };
    const prefix = below ? `${below}/` : '';
    let branch = '';
    const named = await git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: real, maxBuffer: 1024 * 1024 });
    if (named.ok) branch = named.stdout.toString('utf8').trim();
    if (!branch) {
      const short = await git(['rev-parse', '--short', 'HEAD'], { cwd: real, maxBuffer: 1024 * 1024 });
      if (short.ok) branch = short.stdout.toString('utf8').trim();
    }
    const status = await git(['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=normal'], { cwd: real, maxBuffer: GIT_MAX_BUFFER, timeoutMs: GIT_STATUS_TIMEOUT_MS });
    if (!status.ok) return { isGit: true, branch, changes: {}, ignored: [], partial: true };
    const { changes, ignored } = parseGitStatus(status.stdout.toString('utf8'), prefix);
    gitKnown.set(real, { dirs: ignored.filter((path) => path.endsWith('/')), files: new Set(ignored.filter((path) => !path.endsWith('/'))) });
    return { isGit: true, branch, changes, ignored };
  }
  router.get('/git', route(async (req, res) => {
    const dir = folderOf(req.query.root);
    // Two windows that ask at once share one run of git.
    let flight = gitFlights.get(dir.real);
    if (!flight) {
      flight = readGit(dir.real).finally(() => gitFlights.delete(dir.real));
      gitFlights.set(dir.real, flight);
    }
    res.json({ ok: true, root: dir.written, ...(await flight) });
  }));
  const ignoredByGit = (real) => (path) => {
    const known = gitKnown.get(real);
    return !!known && (known.files.has(path) || known.dirs.some((dir) => path.startsWith(dir) || `${path}/` === dir));
  };

  // ── Entries by name ──
  router.get('/search', route(async (req, res) => {
    const dir = folderOf(req.query.root);
    const query = String(req.query.q || '').trim().toLowerCase();
    need(query.length > 0 && query.length <= 200);
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || SEARCH_LIMIT));
    const words = query.split(/\s+/);
    const byPath = query.includes('/');
    // What git ignores as a whole folder (node_modules, build output) is not walked; without git, the usual two.
    const known = gitKnown.get(dir.real) || (await readGit(dir.real).catch(() => null), gitKnown.get(dir.real));
    const skipped = (rel, name) => name === '.git' || (known ? known.dirs.includes(`${rel}/`) : name === 'node_modules');
    const items = [];
    const queue = [''];
    const started = Date.now();
    let visited = 0; let partial = false; let truncated = false;
    walk: for (let at = 0; at < queue.length; at++) {
      const rel = queue[at];
      let dirents;
      try { dirents = await readdir(rel ? join(dir.real, rel) : dir.real, { withFileTypes: true }); } catch { continue; }
      dirents.sort((a, b) => compareNames(a.name, b.name));
      for (const entry of dirents) {
        if (++visited > SEARCH_MAX_VISITED || Date.now() - started > SEARCH_BUDGET_MS) { partial = true; break walk; }
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        const isDir = entry.isDirectory();
        const hay = (byPath ? path : entry.name).toLowerCase();
        if (words.every((word) => hay.includes(word))) {
          if (items.length >= limit) { truncated = true; break walk; }
          items.push({ path, type: isDir ? 'dir' : 'file' });
        }
        // A link is listed and not entered: it could lead anywhere, or back here.
        if (isDir && !skipped(path, entry.name)) queue.push(path);
      }
    }
    res.json({ ok: true, root: dir.written, items, truncated, partial });
  }));

  // ── Watching ──
  router.get('/watch', route(async (req, res) => {
    const dir = folderOf(req.query.root);
    need(statSync(dir.real).isDirectory(), 'not-dir');
    need(sessions.size < MAX_WATCH_SESSIONS, 'limit', 429);
    const id = randomBytes(12).toString('hex');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* the page is gone */ } };
    const session = { root: dir.written, real: dir.real, res, written: new Map([[dir.real, dir.written]]), watcher: null };
    session.watcher = createTreeWatcher({
      root: dir.real,
      strategy: watch,
      ...(watchImpl ? { watch: watchImpl } : {}),
      ...watchClock,
      ignoresGit: ignoredByGit(dir.real),
      onChange: ({ dirs, git: gitChanged }) => send('change', { dirs: dirs.map((real) => session.written.get(real)).filter(Boolean), git: gitChanged }),
      onError: () => send('resync', {}),
      // A stream is not a watch that works: what is really watched is said, and said again when it changes.
      onState: (state) => send('state', state),
    });
    sessions.set(id, session);
    send('ready', { id, ...session.watcher.state() });
    const beat = setInterval(() => { try { res.write(': still here\n\n'); } catch { /* closing */ } }, 25000);
    beat.unref?.();
    // The response's end is the page leaving (a request's own `close` only says its body was read).
    res.on('close', () => { clearInterval(beat); session.watcher.close(); sessions.delete(id); });
  }));

  router.post('/watch/:id', route(async (req, res) => {
    const session = sessions.get(String(req.params.id));
    need(session, 'gone', 404);
    const dirs = req.body?.dirs;
    need(Array.isArray(dirs) && dirs.length <= 2000 && dirs.every(isText));
    const written = new Map([[session.real, session.root]]);
    for (const path of dirs) {
      try {
        const dir = folderOf(path);
        if (dir.real === session.real || isInside(session.real, dir.real)) written.set(dir.real, dir.written);
      } catch { /* a folder that is gone or not allowed is simply not watched */ }
    }
    session.written = written;
    session.watcher.setDirs([...written.keys()]);
    res.json({ ok: true, watching: written.size, live: session.watcher.state().live });
  }));

  // ── Creating ──
  router.post('/create', route(async (req, res) => {
    const { parent, name, type } = req.body || {};
    need(type === 'file' || type === 'dir');
    need(isText(name));
    goodName(name);
    const dir = folderOf(parent);
    need(statSync(dir.real).isDirectory(), 'not-dir');
    const dest = join(dir.real, name);
    if (type === 'dir') mkdirSync(dest);
    else closeSync(openSync(dest, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o666));
    res.json({ ok: true, path: `${dir.written}/${name}`, type });
  }));

  // ── Renaming ──
  router.post('/rename', route(async (req, res) => {
    const { path, name } = req.body || {};
    need(isText(name));
    goodName(name);
    const found = present(entryOf(path, { protect: true }));
    const dest = join(found.parent, name);
    if (found.name !== name) {
      // A change of case only is the same entry on a disk that does not tell case apart: its name is simply changed.
      if (sameEntry(found.entry, dest)) rename(found.entry, dest);
      else {
        if (exists(dest)) throw new ExplorerError(409, 'exists', { name });
        // The name is taken only while it is free: something that turns up under it at this moment is not replaced.
        try { renameExclusive(found.entry, dest, { isDir: found.st.isDirectory(), platform, rename }); }
        catch (error) { throw error?.code === 'EEXIST' ? new ExplorerError(409, 'exists', { name }) : error; }
      }
    }
    res.json({ ok: true, from: found.written, path: `${trimSlash(dirname(found.written))}/${name}` });
  }));

  // What a move or a copy is about to do, checked as a whole before anything is touched.
  function plan(paths, into, { copy }) {
    need(Array.isArray(paths) && paths.length > 0 && paths.every(isText));
    need(paths.length <= MAX_BATCH, 'limit', 413);
    const target = folderOf(into);
    need(statSync(target.real).isDirectory(), 'not-dir');
    const known = roots();
    const steps = [];
    const conflicts = [];
    const taken = new Set();
    for (const path of paths) {
      const found = present(entryOf(path, { protect: !copy }));
      const isDir = found.st.isDirectory();
      if (isDir && (found.entry === target.real || isInside(found.entry, target.real))) throw new ExplorerError(400, 'into-self', { name: found.name });
      const inPlace = found.parent === target.real;
      if (inPlace && !copy) continue;   // it is there already
      let name = found.name;
      // A copy into its own folder sits next to the original under a name of its own.
      if (inPlace) name = copyName(found.name, (candidate) => taken.has(candidate) || exists(join(target.real, candidate)), { isDir });
      const dest = join(target.real, name);
      if (taken.has(name)) throw new ExplorerError(409, 'exists', { conflicts: [name] });
      taken.add(name);
      const to = `${target.written}/${name}`;
      const replaces = !inPlace && exists(dest) && !sameEntry(found.entry, dest);
      if (replaces) {
        // A replace would clear what is there: never a project folder, or a folder that holds one.
        let there = null;
        try { there = lstatSync(dest); } catch { there = null; }
        if (holdsRoot(known, to, dest, there)) throw new ExplorerError(403, 'root', { name });
        conflicts.push(name);
      }
      steps.push({ found, name, dest, from: found.written, to, replaces, isDir });
    }
    return { target, steps, conflicts };
  }

  /**
   * Which names a request allows to be replaced. `replace: true` is every name the plan found taken;
   * `replace: [names]` only those, which is what the page sends: the names it asked about. A name that is taken
   * and not among them is a conflict before anything is touched, so the page can ask about it too.
   */
  function refuseUnasked(conflicts, replace) {
    const asked = replace === true ? null : new Set(Array.isArray(replace) ? replace.filter(isText) : []);
    const unasked = asked ? conflicts.filter((name) => !asked.has(name)) : [];
    if (unasked.length) throw new ExplorerError(409, 'exists', { conflicts: unasked });
  }

  /**
   * Right before a step touches the disk, and again after anything it waited for: both ends are where they were
   * checked to be, the entry is the one that was asked about, and neither it (for a move) nor what is in its way
   * has become a registered folder.
   * @param {boolean} o.free nothing may be in the way: nobody was asked about replacing anything there (or what
   *   was there has just been cleared), so something there now is a conflict
   * @returns {boolean} whether something is in the way that the request allows to be replaced
   */
  function recheck(target, step, { move, free }) {
    sameFolder(target.base, target.real, target.id);
    sameEntryStill(step.found);
    const known = roots();
    if (move && holdsRoot(known, step.from, step.found.entry, step.found.st)) throw new ExplorerError(403, 'root', { name: step.found.name });
    let there = null;
    try { there = lstatSync(step.dest); } catch { there = null; }
    if (!there || sameEntry(step.found.entry, step.dest)) return false;
    if (holdsRoot(known, step.to, step.dest, there)) throw new ExplorerError(403, 'root', { name: step.name });
    if (free) throw new ExplorerError(409, 'exists', { conflicts: [step.name] });
    return true;
  }
  // A name that was taken at the very moment of placing: a conflict the page can ask about, like any other.
  const takenMeanwhile = (error, step) => (error?.code === 'EEXIST' ? new ExplorerError(409, 'exists', { conflicts: [step.name] }) : error);

  // The folders a copy came down through, each as it was when it was listed or made (device and inode): one that
  // was swapped for a link since, or for another folder, is no longer the folder that was checked.
  const stillThere = (places) => { for (const place of places) if (entryId(place.path) !== place.id) throw changed(); };

  // A folder's mode and times are set through a handle on the folder itself, opened without following a link: by
  // its path they would reach whatever a link put under its name since.
  function finishFolder(dest, id, st) {
    if (entryId(dest) !== id) throw changed();
    let fd = null;
    try {
      fd = openSync(dest, constants.O_RDONLY | O_NOFOLLOW | O_DIRECTORY);
      if (idOf(fstatSync(fd, { bigint: true })) !== id) return;
      fchmodSync(fd, Number(st.mode) & 0o7777);
      futimesSync(fd, st.atime, st.mtime);
    } catch { /* the copy is whole all the same (Windows opens no folder this way) */ }
    finally { if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } } }
  }

  /**
   * Copy one entry to a name that must be free, never over or into something that is there, and never through
   * something that was not checked. A folder is made exclusively and then filled; a file is read through a handle
   * opened without following a link, which must be the file that was listed, and written through a handle made
   * exclusively, and its mode and times are set through that handle; a link is made again as the link it is
   * (nothing is read through it).
   *
   * `verify` (both ends of the request are still where they were checked to be) runs before each of those, and
   * with it every folder on the way down is looked at again: the ones this copy made before anything is written
   * into them, the ones it reads before anything is taken from them. A change answers `changed`.
   *
   * A child that cannot be read stops the copy: nothing is skipped, because a copy that says it is whole and is
   * not is how a file gets lost. (An entry that left its folder while the folder was being copied is no child any
   * more.) A file that was not copied whole is taken away again.
   * @param {{ id?: string | null }} made says what was made under `dest`, also when the copy then failed
   */
  async function copyEntry(src, dest, verify, made = {}) {
    const down = async (from, to, st, read, written) => {
      const top = !written.length;
      const ends = () => { verify(); stillThere(read); stillThere(written); };
      // Inside a folder this copy made nobody was asked about anything: a name that is taken there is a change.
      const place = (work) => { try { return work(); } catch (error) { throw !top && error?.code === 'EEXIST' ? changed() : error; } };
      ends();
      if (st.isSymbolicLink()) {
        let target;
        try { target = readlinkSync(from); } catch { throw changed(); }   // no longer the link that was listed
        place(() => symlinkSync(target, to));
        if (top) made.id = entryId(to);
        return;
      }
      if (st.isDirectory()) {
        place(() => mkdirSync(to));
        const mine = lstatSync(to, { bigint: true });
        if (!mine.isDirectory()) throw changed();
        if (top) made.id = idOf(mine);
        const deeper = [[...read, { path: from, id: idOf(st) }], [...written, { path: to, id: idOf(mine) }]];
        for (const name of await readdir(from)) {
          verify(); stillThere(deeper[0]); stillThere(deeper[1]);
          const child = join(from, name);
          let inner;
          try { inner = lstatSync(child, { bigint: true }); }
          catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
          await down(child, join(to, name), inner, ...deeper);
        }
        verify(); stillThere(deeper[0]); stillThere(deeper[1]);
        finishFolder(to, idOf(mine), st);
        return;
      }
      if (!st.isFile()) throw new Error('Only files, folders and links are copied.');
      let input = null; let output = null; let mine = null;
      // What was made is the file under that name, in the folder that was checked.
      const placed = () => { ends(); if (entryId(to) !== mine) throw changed(); };
      try {
        try { input = openSync(from, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK); }
        catch (error) { throw ['ELOOP', 'EMLINK'].includes(error?.code) ? changed() : error; }
        // What was opened is the file that was listed: not a link that took its name, not what a swapped folder leads to.
        const opened = fstatSync(input, { bigint: true });
        if (!opened.isFile() || idOf(opened) !== idOf(st)) throw changed();
        output = place(() => openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600));
        mine = idOf(fstatSync(output, { bigint: true }));
        if (top) made.id = mine;
        placed();
        await pump(input, output, { from, to });
        placed();
        try { fchmodSync(output, Number(st.mode) & 0o7777); futimesSync(output, st.atime, st.mtime); } catch { /* the copy is whole all the same */ }
      } catch (error) {
        // Half a file is not left to be taken for a whole one: removed, where it is still the file that was made here.
        if (mine) { try { placed(); unlinkSync(to); } catch { /* it cannot be told where it is: left */ } }
        throw error;
      } finally {
        for (const fd of [input, output]) if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } }
      }
    };
    verify();
    await down(src, dest, lstatSync(src, { bigint: true }), [], []);
  }

  /**
   * Send what is in the way of a replace to the Trash: a replace can then be undone too. What the Trash cannot
   * take stays where it is and the answer is `no-trash`, unless the request said `permanent`.
   * @returns {Promise<boolean>} false when it is still there and the request allows removing it for good
   */
  async function toTrash(dest, { permanent }) {
    if (!exists(dest)) return true;
    if (trash?.available?.()) {
      try { await trash.trash(dest); } catch (error) { if (!(error instanceof TrashUnavailable)) throw error; }
      if (!exists(dest)) return true;
    }
    if (!permanent) throw new ExplorerError(409, 'no-trash');
    return false;
  }
  /**
   * Clear what is in the way of a replace: to the Trash, and for good only when the request said so. The Trash is
   * waited for: `verify` runs after it, before anything is removed here.
   */
  async function makeRoom(base, dest, { permanent, verify }) {
    if (await toTrash(dest, { permanent })) return;
    verify();
    removeConfinedEntry(base, dest);
  }
  // No Trash at all, and a replace that did not say "for good": refused before anything of the batch is touched.
  function needTrashFor(steps, permanent, done) {
    const first = steps.find((step) => step.replaces);
    if (first && !permanent && !trash?.available?.()) throw midway(new ExplorerError(409, 'no-trash'), { ...done, failed: first.from });
  }

  // Whether an entry is on another disk than a folder: a move there would be a copy and a removal, which is not
  // made here. Asked before anything is cleared for the move; where it cannot be told, the rename itself says so.
  const otherDisk = (entry, folder) => { try { return device(entry) !== device(folder); } catch { return false; } };
  const notMovedThere = (step) => new ExplorerError(409, 'other-disk', { name: step.name });

  // ── Moving ──
  router.post('/move', route(async (req, res) => {
    const { paths, into, replace, permanent } = req.body || {};
    const { target, steps, conflicts } = plan(paths, into, { copy: false });
    refuseUnasked(conflicts, replace);
    const forGood = permanent === true;
    const moved = [];
    needTrashFor(steps, forGood, { moved });
    for (const step of steps) {
      try {
        if (otherDisk(step.found.entry, target.real)) throw notMovedThere(step);
        // Earlier steps may have waited (the Trash): nothing of the plan is taken on trust.
        const ends = () => recheck(target, step, { move: true, free: true });
        if (recheck(target, step, { move: true, free: !step.replaces })) {
          await makeRoom(target.base, step.dest, { permanent: forGood, verify: () => recheck(target, step, { move: true, free: false }) });
          ends();
        }
        try {
          renameExclusive(step.found.entry, step.dest, { isDir: step.isDir, platform, rename });
        } catch (error) {
          // Another disk after all (the system says so where the devices did not): nothing of the entry was touched.
          throw error?.code === 'EXDEV' ? notMovedThere(step) : takenMeanwhile(error, step);
        }
      } catch (error) { throw midway(error, { moved, failed: step.from }); }
      moved.push({ from: step.from, to: step.to });
    }
    res.json({ ok: true, moved });
  }));

  // ── Copying ──
  router.post('/copy', route(async (req, res) => {
    const { paths, into, replace, permanent } = req.body || {};
    const { target, steps, conflicts } = plan(paths, into, { copy: true });
    refuseUnasked(conflicts, replace);
    const forGood = permanent === true;
    const copied = [];
    needTrashFor(steps, forGood, { copied });
    for (const step of steps) {
      const made = {};
      try {
        if (recheck(target, step, { move: false, free: !step.replaces })) {
          await makeRoom(target.base, step.dest, { permanent: forGood, verify: () => recheck(target, step, { move: false, free: false }) });
          recheck(target, step, { move: false, free: true });
        }
        // Links inside a copied folder stay links: nothing is read through them.
        try { await copyEntry(step.found.entry, step.dest, () => { sameFolder(target.base, target.real, target.id); sameEntryStill(step.found); }, made); }
        catch (error) { throw takenMeanwhile(error, step); }
      } catch (error) {
        // What the copy had begun under the name stays, and is said to be there in part.
        const partial = !!made.id && entryId(step.dest) === made.id;
        throw midway(error, { copied, failed: step.from, ...(partial ? { partial: step.to } : {}) });
      }
      copied.push({ from: step.from, to: step.to });
    }
    res.json({ ok: true, copied });
  }));

  // ── Deleting ──
  router.post('/delete', route(async (req, res) => {
    const { paths, permanent } = req.body || {};
    need(Array.isArray(paths) && paths.length > 0 && paths.every(isText));
    need(paths.length <= MAX_BATCH, 'limit', 413);
    const found = paths.map((path) => entryOf(path, { protect: true }));
    const forGood = permanent === true;
    const deleted = [];
    if (!forGood && !trash?.available?.()) throw midway(new ExplorerError(409, 'no-trash'), { deleted, failed: found.find((item) => item.st)?.written });
    let waited = false;
    for (const item of found) {
      if (!item.st) continue;   // gone in the meantime: that is what was asked for
      try {
        if (waited) {
          // The Trash was waited for since the check: it is still that entry, in that folder, and no project folder.
          if (!exists(item.entry) && entryId(item.parent) === item.parentId) continue;
          sameEntryStill(item);
          if (holdsRoot(roots(), item.written, item.entry, item.st)) throw new ExplorerError(403, 'root', { name: item.name });
        }
        waited = !forGood;
        if (forGood) removeConfinedEntry(item.base, item.entry);
        else await trash.trash(item.entry);
      } catch (error) {
        // Nothing more is touched. Without a Trash for it, the page asks before anything is removed for good.
        throw midway(error instanceof TrashUnavailable ? new ExplorerError(409, 'no-trash') : error, { deleted, failed: item.written });
      }
      deleted.push(item.written);
    }
    res.json({ ok: true, deleted, trashed: !forGood });
  }));

  // Put a finished file under its name, never over something: as every file is placed (renameExclusive). Not by a
  // hard link either, as it once was: the system would not report that file's later deletion (see there).
  function placeNew(temp, dest) {
    try { renameExclusive(temp, dest, { platform, rename }); }
    catch (error) { throw error?.code === 'EEXIST' ? new ExplorerError(409, 'exists') : error; }
  }

  // ── A file dropped from the computer ──
  router.post('/upload', route(async (req, res) => {
    const name = String(req.query.name || '');
    const rel = String(req.query.rel || '');
    need(isText(name));
    goodName(name);
    const parts = rel ? slashes(rel).split('/').filter(Boolean) : [];
    need(parts.length <= 32, 'limit', 413);
    parts.forEach(goodName);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxUploadBytes) throw new ExplorerError(413, 'too-large', { maxBytes: maxUploadBytes });
    const target = folderOf(req.query.into);
    need(statSync(target.real).isDirectory(), 'not-dir');
    // The folders of a dropped folder are made one by one, each where the check says it is.
    let folder = target.real;
    for (const part of parts) {
      folder = join(folder, part);
      try { mkdirSync(folder); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
      folder = canonicalInside(target.base, folder);
      need(statSync(folder).isDirectory(), 'not-dir');
    }
    const dest = join(folder, name);
    const written = [target.written, ...parts, name].join('/');
    const replace = req.query.replace === '1';
    const forGood = req.query.permanent === '1';
    // The folder the file goes into, as it is now: the body is waited for, and so is the Trash. After each, it must
    // still be this folder, where it was (one swapped for a link would take the file, or a replace, somewhere else).
    const folderId = entryId(folder);
    const still = () => sameFolder(target.base, folder, folderId);
    // What is under that name, judged before a byte is read and again when the file is whole: a project folder is
    // never replaced, a name that is taken only when the page said so, and without a Trash only "for good".
    const inTheWay = () => {
      let there = null;
      try { there = lstatSync(dest); } catch { return false; }
      if (holdsRoot(roots(), written, dest, there)) throw new ExplorerError(403, 'root', { name });
      if (!replace || !there.isFile()) throw new ExplorerError(409, 'exists', { name });
      if (!forGood && !trash?.available?.()) throw new ExplorerError(409, 'no-trash', { name });
      return true;
    };
    inTheWay();
    // The body goes to a file of its own in the same folder (made exclusively, never through a link). What is
    // under the name stays as it is until the new file is whole: an upload that fails or is given up loses nothing.
    const temp = join(folder, `.synabun-upload-${randomBytes(12).toString('hex')}.tmp`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o666);
    // Which file that is, for the end: it is removed as the file that was made here, not as whatever has its name.
    let tempId = null;
    try { tempId = idOf(fstatSync(fd, { bigint: true })); } catch { tempId = null; }
    try {
      await new Promise((done, failed) => {
        let size = 0; let failure = null; let whole = false;
        const out = createWriteStream(null, { fd, autoClose: true });
        const giveUp = (error) => { if (failure) return; failure = error || new ExplorerError(400, 'failed'); req.unpipe(out); out.destroy(); };
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxUploadBytes && !failure) { giveUp(new ExplorerError(413, 'too-large', { maxBytes: maxUploadBytes })); req.resume(); }
        });
        req.on('close', () => { if (!req.complete) giveUp(new ExplorerError(400, 'failed')); });
        req.on('error', giveUp);
        out.on('error', giveUp);
        out.on('finish', () => { whole = true; });
        // The file is closed by now, whichever way it ended.
        out.on('close', () => (whole && !failure ? done() : failed(failure || new ExplorerError(400, 'failed'))));
        req.pipe(out);
      });
      still();
      if (inTheWay()) {
        const cleared = await toTrash(dest, { permanent: forGood });
        still();
        // For good, as the request said: the new file takes the name of the one that is (still) there in one step.
        if (!cleared && inTheWay()) rename(temp, dest);
        else placeNew(temp, dest);
      } else {
        placeNew(temp, dest);
      }
    } catch (error) {
      throw error instanceof ExplorerError && !error.extra?.name ? Object.assign(error, { extra: { ...error.extra, name } }) : error;
    } finally {
      // Whichever way it ended, nothing is left under the temporary name (it is gone already when it was placed).
      // Removed only where it was made: when the folder is no longer the one it was made in, its path leads
      // somewhere else by now, and what has that name there is somebody else's. Then it is left, and logged.
      let there = 'unknown';
      try {
        still();
        // By what it is on disk; by its name alone only on a disk that tells no file from another.
        if (tempId) there = entryId(temp) === tempId ? 'mine' : exists(temp) ? 'unknown' : 'gone';
        else there = exists(temp) ? 'mine' : 'gone';
      } catch { there = 'unknown'; }
      if (there === 'mine') { try { unlinkSync(temp); } catch { /* not there */ } }
      else if (there === 'unknown') log(`[explorer] an upload left its temporary file ${basename(temp)} behind: the folder it was made in (${folder}) changed while the upload was under way.`);
    }
    res.json({ ok: true, path: written });
  }));

  // ── Showing an entry in the system's file manager ──
  router.post('/reveal', route(async (req, res) => {
    const path = req.body?.path;
    need(isText(path));
    // A project folder itself can be shown: nothing about it changes.
    const { matches } = matchFileRoots(path, roots());
    const real = matches.some((match) => match.isBase) ? folderOf(path).real : present(entryOf(path)).entry;
    if (!revealer?.available?.() || !(await revealer.reveal(real))) throw new ExplorerError(501, 'no-reveal');
    res.json({ ok: true });
  }));

  // ── The bytes of an image ──
  router.get('/raw', route(async (req, res) => {
    const path = req.query.path;
    need(isText(path));
    const type = RAW_TYPES[extname(path).toLowerCase()];
    if (!type) throw new ExplorerError(415, 'not-image');
    const file = useFileRoot(path, roots(), (match) => ({ base: match.base, real: canonicalInside(match.base, match.path) }));
    const st = statSync(file.real);
    need(st.isFile(), 'gone', 404);
    if (st.size > MAX_RAW_BYTES) throw new ExplorerError(413, 'too-large', { maxBytes: MAX_RAW_BYTES });
    const stream = openConfinedStream(file.base, file.real);
    res.writeHead(200, {
      'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
      // An SVG opened by its address is a document: it gets no scripts, no network and no way out of its frame.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }));

  router.use((req, res) => res.status(404).json({ ok: false, code: 'bad-request', error: 'Unknown explorer route.' }));

  /** Release every watch (the server is going down). */
  router.close = () => { for (const session of sessions.values()) { session.watcher.close(); try { session.res.end(); } catch { /* gone */ } } sessions.clear(); };
  router.sessions = () => sessions.size;
  return router;
}

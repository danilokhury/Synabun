// ── The code editor's file routes ──
// Reading, writing, creating and removing the files the File Explorer's editor
// works on, plus what the editor asks the server before it uses anything newer
// than read and write (GET /api/editor/capabilities).
//
// A path is allowed when it is inside one of the roots the server registers:
// the data home, the registered projects, the plan folders, and one single
// file, the user's OpenCode configuration. "Inside" is judged as written first
// (403 "Path outside registered project roots"), then as the filesystem
// resolves it: every read and write goes through lib/confined-fs.js, so a link
// that leads out of its root is refused instead of followed.
//
// A read reports the file's version ({ mtimeMs, size }); a write that sends it
// back as `expect` is refused with 409 when the file changed in between. A
// write of a file that is expected not to be there (`expectAbsent`, with
// `create`) is refused the same way when it is: it is created exclusively.
//
// Who may ask is each route's own business: the `guard` it is handed (server.js:
// lib/http-guards.js ownerRouteGuard) refuses invite guests, a Host that is not
// this server's and a write from another site's page, on the route itself.
// Dependencies are injected: the router is tested without server.js.

import { Router } from 'express';
import { lstatSync, mkdirSync, readdirSync, rmdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { PathConfineError, realPathOf } from './path-confine.js';
import { MAX_FILE_BYTES, canonicalInside, makeConfinedDir, readConfinedFile, removeConfinedEntry, writeConfinedFile } from './confined-fs.js';

/** What these routes add to the editor: the version check on save, and POST /api/file-stat. */
export const EDITOR_FILE_CAPABILITIES = Object.freeze(['file-version', 'file-stat']);
export const MAX_STAT_PATHS = 50;
/**
 * The namespace of the UI blob store (lib/ui-blob-store.js, /api/ui-blobs) that holds the editor's copies of
 * unsaved buffers. server.js allows it and keeps it for the owner; it announces `backups` when it does.
 */
export const EDITOR_BACKUP_NAMESPACE = 'editor-backups';
export const EDITOR_BACKUP_CAPABILITIES = Object.freeze(['backups']);

const OUTSIDE_ROOTS = 'Path outside registered project roots';
const BINARY_PROBE_BYTES = 8192;
const UTF8_BOM = [0xEF, 0xBB, 0xBF];

const outsideRoots = () => new PathConfineError(403, OUTSIDE_ROOTS);
const slashes = (path) => path.replace(/\\/g, '/');
const versionOf = (st) => ({ mtimeMs: st.mtimeMs, size: st.size });

/**
 * The roots a path is inside, as written.
 * @param {string} path any path a request sent
 * @param {{ dirs?: string[], files?: string[] }} roots folders, and single files allowed by their exact path
 * @returns {{ target: string, matches: { base: string, path: string, isBase: boolean }[] }} `target` is the path
 *   resolved; each match is the folder to confine to and the path to use inside it. A single file is confined to
 *   the folder it really is in: it is allowed by name, wherever a link takes it.
 */
export function matchFileRoots(path, roots = {}) {
  const target = resolve(String(path));
  const matches = [];
  for (const dir of roots.dirs || []) {
    const base = resolve(dir);
    if (target === base) matches.push({ base, path: target, isBase: true });
    else if (target.startsWith(base.endsWith(sep) ? base : base + sep)) matches.push({ base, path: target, isBase: false });
  }
  for (const file of roots.files || []) {
    if (target !== resolve(file)) continue;
    try {
      const real = realPathOf(target);
      matches.push({ base: dirname(real), path: real, isBase: false });
    } catch { /* a link that cannot be resolved: not a file to open */ }
  }
  return { target, matches };
}

/**
 * Run `use(match)` on the first root that really holds the path. A root the path leaves through a link is passed
 * over; when every root is, the path is refused (403), as a path outside every root is.
 * @param {string} path any path a request sent
 * @param {{ dirs?: string[], files?: string[] }} roots
 * @param {(match: { base: string, path: string, isBase: boolean, target: string }) => any} use
 */
export function useFileRoot(path, roots, use) {
  const { target, matches } = matchFileRoots(path, roots);
  if (!matches.length) throw outsideRoots();
  let refused = null;
  for (const match of matches) {
    try { return use({ ...match, target }); }
    catch (error) {
      if (!(error instanceof PathConfineError) || error.status !== 403) throw error;
      refused = error;
    }
  }
  throw refused;
}

/**
 * @param {object} deps
 * @param {() => { dirs: string[], files: string[] }} deps.fileRoots the roots validateProjectPath() allows
 * @param {() => string[]} [deps.capabilities] what other editor routes of this server add (GET /api/editor/capabilities)
 * @param {number} [deps.maxBytes] the largest file that is read
 * @param {(req: object, res: object, next: () => void) => void} [deps.guard] who may use these routes; without
 *   one, anybody who reaches them
 */
export function createEditorFilesRouter({ fileRoots, capabilities = () => [], maxBytes = MAX_FILE_BYTES, guard = null } = {}) {
  if (typeof fileRoots !== 'function') throw new Error('createEditorFilesRouter requires fileRoots');
  const router = Router();
  // On each route, not on the router: it is mounted at the root, where a check of its own would run for the
  // paths of every route registered after it.
  const owner = typeof guard === 'function' ? guard : (req, res, next) => next();

  const fail = (res, error) => {
    if (error instanceof PathConfineError) return res.status(error.status).json({ error: error.message });
    return res.status(500).json({ error: error?.message || String(error) });
  };

  const inRoots = (path, use) => useFileRoot(path, fileRoots(), use);

  // The canonical path of a match, and what is there (null when nothing is).
  function locate(match) {
    const real = canonicalInside(match.base, match.path, { allowBase: true });
    let st = null;
    try { st = statSync(real); } catch { st = null; }
    return { real, st };
  }

  // GET /api/file-content — read one file for the editor
  router.get('/api/file-content', owner, (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'Missing path parameter' });
      const found = inRoots(filePath, (match) => {
        let { real, st } = locate(match);
        if (!st || !st.isFile()) return { status: 400, body: { error: 'Not a valid file' } };
        if (st.size > maxBytes) {
          return { status: 413, body: { error: `File too large (the editor opens up to ${Math.round(maxBytes / (1024 * 1024))} MB)`, maxBytes } };
        }
        let buf = readConfinedFile(match.base, real, { maxBytes });
        // The version must be the one of the bytes that were read: a write in between is read again.
        let after = statSync(real);
        if (after.mtimeMs !== st.mtimeMs || after.size !== st.size) {
          buf = readConfinedFile(match.base, real, { maxBytes });
          after = statSync(real);
        }
        st = after;
        const probe = Math.min(BINARY_PROBE_BYTES, buf.length);
        for (let i = 0; i < probe; i++) {
          if (buf[i] === 0x00) return { status: 415, body: { error: 'Binary file', reason: 'binary' } };
        }
        const bom = buf.length >= 3 && UTF8_BOM.every((byte, i) => buf[i] === byte);
        let content;
        try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? buf.subarray(3) : buf); }
        catch { return { status: 415, body: { error: 'File is not valid UTF-8 text', reason: 'encoding' } }; }
        return {
          status: 200,
          body: { ok: true, content, path: slashes(match.target), name: basename(match.target), size: st.size, version: versionOf(st), bom },
        };
      });
      res.status(found.status).json(found.body);
    } catch (error) { fail(res, error); }
  });

  // POST /api/file-content — write a file (an existing one, or a new one with `create: true`)
  //   expect: { mtimeMs, size }   the version that was read: 409 { code: 'changed', current } when the file differs
  //   expectAbsent: true          with `create`: the file is expected not to be there (the editor saving a tab whose
  //                               file was deleted): 409 { code: 'changed', current } when it is
  //   force: true                 write whatever is there ("Overwrite")
  router.post('/api/file-content', owner, (req, res) => {
    try {
      const { path: filePath, content, create, expect, expectAbsent, force } = req.body || {};
      if (!filePath || typeof filePath !== 'string' || typeof content !== 'string') {
        return res.status(400).json({ error: 'Missing path or content' });
      }
      const checked = expect !== undefined && expect !== null;
      if (checked && !(Number.isFinite(expect?.mtimeMs) && Number.isFinite(expect?.size))) {
        return res.status(400).json({ error: 'expect must be the version a read returned: { mtimeMs, size }' });
      }
      const absent = expectAbsent === true && !force;
      const changed = (st) => ({ status: 409, body: { error: 'The file changed on disk', code: 'changed', current: versionOf(st) } });
      const done = inRoots(filePath, (match) => {
        const { real, st } = locate(match);
        if (st && !st.isFile()) return { status: 400, body: { error: create ? 'Not a valid file' : 'File does not exist' } };
        if (!st && !create) return { status: 400, body: { error: 'File does not exist' } };
        if (st && absent) return changed(st);
        if (st && checked && !force && (st.mtimeMs !== expect.mtimeMs || st.size !== expect.size)) return changed(st);
        // In place: an existing file keeps its mode and its inode, a link to it stays a link. A file that is
        // expected to be absent is created exclusively: one that appeared since the look above is not written over.
        try {
          writeConfinedFile(match.base, real, content, { exclusive: absent });
        } catch (error) {
          if (!(absent && error instanceof PathConfineError && error.status === 409)) throw error;
          let now = null;
          try { now = statSync(real); } catch { now = null; }
          if (now) return changed(now);
          throw error;
        }
        return { status: 200, body: { ok: true, version: versionOf(statSync(real)) } };
      });
      res.status(done.status).json(done.body);
    } catch (error) { fail(res, error); }
  });

  // POST /api/file-mkdir — create a directory
  router.post('/api/file-mkdir', owner, (req, res) => {
    try {
      const { path: dirPath } = req.body || {};
      if (!dirPath || typeof dirPath !== 'string') return res.status(400).json({ error: 'Missing path' });
      inRoots(dirPath, (match) => {
        if (match.isBase) mkdirSync(match.path, { recursive: true });
        else makeConfinedDir(match.base, match.path);
      });
      res.json({ ok: true });
    } catch (error) { fail(res, error); }
  });

  // DELETE /api/file-content — delete a file or an empty directory
  router.delete('/api/file-content', owner, (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'Missing path parameter' });
      const done = inRoots(filePath, (match) => {
        if (match.isBase) return { status: 403, body: { error: 'A registered folder is not deleted from here' } };
        // The folder that holds the entry must really be in the root; the entry itself is removed as it is
        // (a link is unlinked, never followed).
        const parent = canonicalInside(match.base, dirname(match.path), { allowBase: true });
        const entry = join(parent, basename(match.path));
        let st;
        try { st = lstatSync(entry); } catch { return { status: 404, body: { error: 'Path does not exist' } }; }
        if (st.isDirectory()) {
          if (readdirSync(entry).length > 0) return { status: 400, body: { error: 'Directory is not empty' } };
          rmdirSync(entry);
        } else {
          removeConfinedEntry(match.base, entry);
        }
        return { status: 200, body: { ok: true } };
      });
      res.status(done.status).json(done.body);
    } catch (error) { fail(res, error); }
  });

  // POST /api/file-stat — the versions of up to 50 files, to see which changed on disk
  router.post('/api/file-stat', owner, (req, res) => {
    try {
      const paths = req.body?.paths;
      if (!Array.isArray(paths) || paths.length > MAX_STAT_PATHS || paths.some((p) => typeof p !== 'string' || !p)) {
        return res.status(400).json({ error: `paths must be an array of at most ${MAX_STAT_PATHS} file paths` });
      }
      const files = {};
      for (const path of paths) {
        let entry = { exists: false };
        try {
          entry = inRoots(path, (match) => {
            const { st } = locate(match);
            return st && st.isFile() ? { exists: true, version: versionOf(st) } : { exists: false };
          });
        } catch { /* outside the roots, or out of one through a link: not a file the editor has */ }
        files[path] = entry;
      }
      res.json({ ok: true, files });
    } catch (error) { fail(res, error); }
  });

  // GET /api/editor/capabilities — what this server offers the editor beyond reading and writing
  router.get('/api/editor/capabilities', owner, (req, res) => {
    let extra = [];
    try { extra = (capabilities() || []).filter((name) => typeof name === 'string'); } catch { extra = []; }
    res.json({ ok: true, capabilities: [...new Set([...EDITOR_FILE_CAPABILITIES, ...extra])] });
  });

  return router;
}

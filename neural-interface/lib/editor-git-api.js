// ── The code editor's view of git: the committed version of a file ──
// GET /api/file-head?path= answers with the text of a file as the last commit
// has it (`git show HEAD:<path>`). The editor marks the lines that differ from
// it and shows the two against each other.
//
// The path is checked like every other file path of the editor (inside a
// registered root as written, and as the filesystem resolves it). git is run
// with an argument array, never through a shell: a file name is a name,
// whatever characters it holds. Only commands that read are run here:
// `rev-parse --show-toplevel` to find the repository, `show` for the text.
// Nothing in the repository, its index or its working tree is changed, and
// nothing the repository's own configuration names is started: every call of
// runGit() is a read as lib/git-read.js runs one (no file system monitor
// program, no hook, no external diff or textconv, no fetch).
//
// A file git does not know, a folder that is not a repository and a machine
// without git all answer `tracked: false`: for the editor that is "no markers",
// not an error. Dependencies are injected: the router is tested without server.js.

import { Router } from 'express';
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { PathConfineError } from './path-confine.js';
import { MAX_FILE_BYTES, canonicalInside } from './confined-fs.js';
import { useFileRoot } from './editor-files-api.js';
import { gitRead } from './git-read.js';

/** What this route adds to the editor (GET /api/editor/capabilities). */
export const EDITOR_GIT_CAPABILITIES = Object.freeze(['git-head']);
export const GIT_TIMEOUT_MS = 5000;

const UTF8_BOM = [0xEF, 0xBB, 0xBF];
const BINARY_PROBE_BYTES = 8192;
// Variables that would point git at another repository than the one the file is in.
const REDIRECTING = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES'];

/**
 * Run git for a read and collect what it prints. Never throws. The arguments are the command's own: what keeps a
 * read from starting a program of the repository's is added here (lib/git-read.js).
 * @param {string[]} args the command first
 * @param {{ cwd: string, maxBuffer: number, timeoutMs?: number, binary?: string, env?: object }} o
 * @returns {Promise<{ ok: boolean, stdout: Buffer, tooLarge: boolean }>} `tooLarge`: it printed more than `maxBuffer` bytes
 */
export function runGit(args, { cwd, maxBuffer, timeoutMs = GIT_TIMEOUT_MS, binary = 'git', env = process.env } = {}) {
  const clean = { ...env };
  for (const name of REDIRECTING) delete clean[name];
  const failed = { ok: false, stdout: Buffer.alloc(0), tooLarge: false };
  return gitRead(cwd, args, { binary, env: clean }).then((read) => new Promise((done) => {
    try {
      execFile(binary, read.args, { cwd, maxBuffer, timeout: timeoutMs, encoding: 'buffer', windowsHide: true, env: read.env, shell: false }, (error, stdout) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0);
        if (!error) done({ ok: true, stdout: out, tooLarge: false });
        else done({ ok: false, stdout: out, tooLarge: error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
      });
    } catch {
      done(failed);
    }
  })).catch(() => failed);
}

/**
 * The committed text of one file.
 * @param {string} real the file's canonical path (it may be gone from the disk)
 * @param {{ maxBytes: number, git: (args: string[], o: object) => Promise<object> }} o
 * @returns {Promise<{ tracked: boolean, content?: string, binary?: boolean, tooLarge?: boolean }>}
 */
export async function readHeadVersion(real, { maxBytes, git }) {
  const folder = dirname(real);
  const top = await git(['rev-parse', '--show-toplevel'], { cwd: folder, maxBuffer: 64 * 1024 });
  if (!top.ok) return { tracked: false };
  const root = top.stdout.toString('utf8').replace(/\r?\n$/, '');
  if (!root || !isAbsolute(root)) return { tracked: false };
  // The file's name inside the repository, as git writes it. Both paths are canonical: git prints its top level
  // resolved, and `real` is.
  const inside = relative(root, real);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return { tracked: false };
  const name = sep === '/' ? inside : inside.split(sep).join('/');
  const shown = await git(['show', `HEAD:${name}`], { cwd: root, maxBuffer: maxBytes });
  if (shown.tooLarge) return { tracked: true, tooLarge: true };
  if (!shown.ok) return { tracked: false };   // not in the last commit, or no commit yet
  const buf = shown.stdout;
  const probe = Math.min(BINARY_PROBE_BYTES, buf.length);
  for (let i = 0; i < probe; i++) if (buf[i] === 0x00) return { tracked: true, binary: true };
  const bom = buf.length >= 3 && UTF8_BOM.every((byte, i) => buf[i] === byte);
  try { return { tracked: true, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? buf.subarray(3) : buf) }; }
  catch { return { tracked: true, binary: true }; }
}

/**
 * GET /api/file-head?path=
 *   200 { ok, tracked: false }                 git does not know the file, the folder is no repository, or there is no git
 *   200 { ok, tracked: true, content }         the file as HEAD has it: its own line endings, a byte-order mark taken off
 *   200 { ok, tracked: true, binary: true }    HEAD holds something that is not UTF-8 text
 *   400 no path, or a folder · 403 outside the registered roots, or out of one through a link · 413 larger than `maxBytes`
 * @param {object} deps
 * @param {() => { dirs: string[], files: string[] }} deps.fileRoots the roots the editor's file routes allow
 * @param {number} [deps.maxBytes]
 * @param {(args: string[], o: object) => Promise<object>} [deps.git] runGit, or a stand-in
 * @param {(req: object, res: object, next: () => void) => void} [deps.guard] who may use the route (the files
 *   router's own: lib/http-guards.js ownerRouteGuard); on the route itself, as the router is mounted at the root
 */
export function createEditorGitRouter({ fileRoots, maxBytes = MAX_FILE_BYTES, git = runGit, guard = null } = {}) {
  if (typeof fileRoots !== 'function') throw new Error('createEditorGitRouter requires fileRoots');
  const router = Router();
  const owner = typeof guard === 'function' ? guard : (req, res, next) => next();
  const tooLarge = () => ({ status: 413, body: { error: `File too large (the editor opens up to ${Math.max(1, Math.round(maxBytes / (1024 * 1024)))} MB)`, maxBytes } });

  router.get('/api/file-head', owner, async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'Missing path parameter' });
      const found = useFileRoot(filePath, fileRoots(), (match) => {
        const real = canonicalInside(match.base, match.path, { allowBase: true });
        let st = null;
        try { st = statSync(real); } catch { st = null; }
        return { real, st };
      });
      // A file that is gone from the disk may still be in the last commit; a folder never is a file.
      if (found.st && !found.st.isFile()) return res.status(400).json({ error: 'Not a valid file' });
      if (found.st && found.st.size > maxBytes) { const refusal = tooLarge(); return res.status(refusal.status).json(refusal.body); }
      const head = await readHeadVersion(found.real, { maxBytes, git });
      if (head.tooLarge) { const refusal = tooLarge(); return res.status(refusal.status).json(refusal.body); }
      if (!head.tracked) return res.json({ ok: true, tracked: false });
      if (head.binary) return res.json({ ok: true, tracked: true, binary: true });
      res.json({ ok: true, tracked: true, content: head.content });
    } catch (error) {
      if (error instanceof PathConfineError) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: error?.message || String(error) });
    }
  });

  return router;
}

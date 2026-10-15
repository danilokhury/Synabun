// ── The working tree's changes of one folder, as text ──
// GET /api/git/diff?path=&maxLines= answers with what `git diff` and
// `git diff --cached` print for a folder, and the files git does not track.
// The Codex side panel shows it; the MCP `git` tool reads it.
//
// The folder is checked like every file path of the code editor: inside a
// registered root as written, and as the filesystem resolves it (a link that
// leaves its project is refused). Who may ask is the route's own business: the
// `guard` it is handed (server.js: lib/http-guards.js ownerRouteGuard) refuses
// invite guests. git is run with an argument array, never through a shell, and
// only with commands that read: nothing in the repository, its index or its
// working tree is changed. Dependencies are injected: tested without server.js.

import { Router } from 'express';
import { statSync } from 'node:fs';
import { PathConfineError } from './path-confine.js';
import { canonicalInside } from './confined-fs.js';
import { useFileRoot } from './editor-files-api.js';
import { runGit } from './editor-git-api.js';

/** The most one git command may print here. */
export const GIT_DIFF_MAX_BYTES = 2 * 1024 * 1024;
export const GIT_DIFF_LINES = Object.freeze({ fallback: 500, min: 50, max: 2000 });

const text = (result) => result.stdout.toString('utf8');

/** A text cut to `maxLines` lines. */
function firstLines(value, maxLines) {
  const lines = value.split('\n');
  if (lines.length <= maxLines) return { text: value, truncated: false };
  return { text: lines.slice(0, maxLines).join('\n'), truncated: true };
}

/**
 * GET /api/git/diff?path=&maxLines=
 *   200 { ok, branch, diff, stagedDiff, untrackedFiles, truncated }
 *   400 no path · 400 { error: 'Not a git repository' } (also a path that is not a folder)
 *   403 outside the registered roots, or out of one through a link; an invite guest (the guard's answer)
 *   500 git failed, or printed more than `maxBytes`
 * @param {object} deps
 * @param {() => { dirs: string[], files: string[] }} deps.fileRoots the roots the editor's file routes allow
 * @param {(args: string[], o: object) => Promise<object>} [deps.git] lib/editor-git-api.js runGit, or a stand-in
 * @param {(req: object, res: object, next: () => void) => void} [deps.guard] who may use the route; on the route
 *   itself, as the router is mounted at the root
 * @param {number} [deps.maxBytes]
 */
export function createGitDiffRouter({ fileRoots, git = runGit, guard = null, maxBytes = GIT_DIFF_MAX_BYTES } = {}) {
  if (typeof fileRoots !== 'function') throw new Error('createGitDiffRouter requires fileRoots');
  const router = Router();
  const owner = typeof guard === 'function' ? guard : (req, res, next) => next();

  router.get('/api/git/diff', owner, async (req, res) => {
    try {
      const dir = req.query.path;
      if (!dir || typeof dir !== 'string') return res.status(400).json({ error: 'path required' });
      const asked = parseInt(req.query.maxLines, 10) || GIT_DIFF_LINES.fallback;
      const maxLines = Math.min(Math.max(asked, GIT_DIFF_LINES.min), GIT_DIFF_LINES.max);

      const folder = useFileRoot(dir, fileRoots(), (match) => canonicalInside(match.base, match.path, { allowBase: true }));
      let isFolder = false;
      try { isFolder = statSync(folder).isDirectory(); } catch { isFolder = false; }
      const run = (args, timeoutMs) => git(args, { cwd: folder, maxBuffer: maxBytes, timeoutMs });
      if (!isFolder || !(await run(['rev-parse', '--is-inside-work-tree'], 3000)).ok) {
        return res.status(400).json({ error: 'Not a git repository' });
      }

      let branch = '';
      const current = await run(['branch', '--show-current'], 3000);
      if (current.ok) branch = text(current).trim();
      if (!branch) {
        const head = await run(['rev-parse', '--short', 'HEAD'], 3000);
        if (head.ok) branch = text(head).trim();
      }

      const [unstaged, staged, others] = await Promise.all([
        run(['diff', '--no-color'], 10000),
        run(['diff', '--cached', '--no-color'], 10000),
        run(['ls-files', '--others', '--exclude-standard'], 5000),
      ]);
      const failed = [unstaged, staged, others].find((result) => !result.ok);
      if (failed) {
        return res.status(500).json({ error: failed.tooLarge ? `The changes are larger than ${Math.round(maxBytes / (1024 * 1024))} MB` : 'git could not read the changes' });
      }

      const d = firstLines(text(unstaged), maxLines);
      const s = firstLines(text(staged), maxLines);
      const untracked = text(others).trim();
      res.json({
        ok: true,
        branch,
        diff: d.text,
        stagedDiff: s.text,
        untrackedFiles: untracked ? untracked.split('\n').filter(Boolean) : [],
        truncated: d.truncated || s.truncated,
      });
    } catch (error) {
      if (error instanceof PathConfineError) return res.status(error.status).json({ error: error.message });
      res.status(500).json({ error: error?.message || String(error) });
    }
  });

  return router;
}

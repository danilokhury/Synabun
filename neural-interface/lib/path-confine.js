// ── Paths built from something a browser sent ──
// An id or a name that ends up in a filesystem path is validated here first:
// a session id is a UUID and its transcript stays inside the project's own
// transcript folder; a Skills Studio artifact stays inside the skills, commands
// and agents folders; a name is one path segment. Pure functions over
// node:path (the filesystem calls are injected), so they are unit-tested.
//
// "Inside" is judged twice: as written (no `..` out of the folder) and as the
// filesystem resolves it (no link out of the folder). The second is what a read
// or a write actually follows.

import { existsSync, realpathSync, lstatSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

export class PathConfineError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSessionId = (id) => typeof id === 'string' && SESSION_ID_RE.test(id);

const fold = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;

/** True when `target` is below `root` (or is `root` itself, with allowRoot). Lexical: both are resolved first. */
export function isInside(root, target, { allowRoot = false } = {}) {
  if (!root || !target) return false;
  const r = fold(resolve(String(root)));
  const t = fold(resolve(String(target)));
  if (t === r) return allowRoot;
  return t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** One path segment: no separator, no NUL, not `.` or `..`. */
export function isPlainName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200
    && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
}

const realFs = { realpath: realpathSync, lstat: lstatSync };

/**
 * `target` with every link resolved. The part that does not exist yet is kept as
 * written under its real parent, so a file about to be created is judged by where
 * it would land. A link that cannot be resolved (dangling, a loop) is refused:
 * writing through it would create its target.
 */
export function realPathOf(target, fs = realFs) {
  let cur = resolve(String(target ?? ''));
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpath(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      let present = false;
      try { fs.lstat(cur); present = true; } catch { present = false; }
      if (present) throw new PathConfineError(403, 'That path goes through a link that cannot be resolved.');
      const parent = dirname(cur);
      if (parent === cur) throw new PathConfineError(403, 'That path cannot be resolved.');
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/** isInside() after links are resolved on both sides. False when either cannot be resolved. */
export function isInsideReal(root, target, { allowRoot = false, fs = realFs } = {}) {
  if (!root || !target) return false;
  try { return isInside(realPathOf(root, fs), realPathOf(target, fs), { allowRoot }); } catch { return false; }
}

/**
 * The transcript of one session, or null. The id must be a UUID (thrown as 400
 * otherwise), the file is looked for only in the transcript folders of the
 * registered projects, and what is found must still be inside its folder after
 * symlinks are resolved. A named project is honoured strictly: it must be
 * registered (400 otherwise) and only its folder is searched. Without one,
 * every registered project is.
 *
 * @param o.sessionId   the browser's session id
 * @param o.project     the project the tab runs in, optional
 * @param o.projects    [{ path }] the registered projects
 * @param o.projectsDir <config dir>/projects of the account
 * @param o.pathToKey   (projectPath) => the folder name Claude Code uses for it
 */
export function findSessionTranscript({ sessionId, project = '', projects = [], projectsDir, pathToKey, exists = existsSync, realpath = realpathSync } = {}) {
  if (!isSessionId(sessionId)) throw new PathConfineError(400, 'Not a session id');
  if (!projectsDir || typeof pathToKey !== 'function') return null;
  const known = (Array.isArray(projects) ? projects : []).filter(p => p?.path);
  const wanted = typeof project === 'string' && project ? resolve(project) : '';
  let order = known;
  if (wanted) {
    const named = known.find(p => resolve(p.path) === wanted);
    if (!named) throw new PathConfineError(400, 'Not a registered project');
    order = [named];
  }
  for (const proj of order) {
    const key = String(pathToKey(proj.path) || '');
    // Claude Code has written the drive letter in both cases on Windows.
    const keys = [...new Set([key.replace(/^([A-Z])/, m => m.toLowerCase()), key])].filter(isPlainName);
    for (const k of keys) {
      const folder = join(projectsDir, k);
      const candidate = join(folder, `${sessionId}.jsonl`);
      if (!exists(candidate)) continue;
      let realFile; let realFolder;
      try { realFile = realpath(candidate); realFolder = realpath(folder); } catch { continue; }
      if (!isInside(realFolder, realFile)) continue;
      // `realPath` / `realFolder`: the canonical paths that were just checked.
      // The transcript is read from those (lib/confined-fs.js), not from the
      // name it was found under, which could be swapped for a link afterwards.
      return { filePath: candidate, project: proj.path, realPath: realFile, realFolder };
    }
  }
  return null;
}

/**
 * The registered projects whose transcript folder, in one account's
 * `projectsDir`, holds a session: findSessionTranscript() asked per project
 * (same id check, same "really inside its folder" check). For saying where a
 * session is when it is not under the project a tab names.
 * @returns {string[]} project paths, in registered order
 */
export function sessionProjects({ sessionId, projects = [], projectsDir, pathToKey, exists = existsSync, realpath = realpathSync } = {}) {
  if (!isSessionId(sessionId)) throw new PathConfineError(400, 'Not a session id');
  const out = [];
  for (const proj of (Array.isArray(projects) ? projects : []).filter(p => p?.path)) {
    let found = null;
    try { found = findSessionTranscript({ sessionId, project: proj.path, projects: [proj], projectsDir, pathToKey, exists, realpath }); } catch { found = null; }
    if (found) out.push(proj.path);
  }
  return out;
}

const ARTIFACT_TYPES = new Set(['skill', 'command', 'agent']);

const rootOf = (r) => (typeof r === 'string' ? { dir: r } : (r && typeof r === 'object' ? r : {}));

// Where an artifact under `root` really lives, or null when a link leads out.
function artifactBase(type, target, root, fs) {
  let realRoot; let realTarget;
  try {
    realRoot = realPathOf(root.dir, fs);
    // A project's folders arrive with its repository: they must really be in it.
    if (root.anchor && !isInside(realPathOf(root.anchor, fs), realRoot)) return null;
    realTarget = realPathOf(target, fs);
  } catch { return null; }
  if (type !== 'skill') return isInside(realRoot, realTarget) ? realRoot : null;
  // A skill folder the user linked into their own skills folder is theirs to
  // link (`links`, direct children only): it is confined to where it really is.
  const linked = root.links === true && dirname(target) === resolve(root.dir);
  if (!linked && !isInside(realRoot, realTarget)) return null;
  try { if (!isInside(realTarget, realPathOf(join(target, 'SKILL.md'), fs))) return null; } catch { return null; }
  return realTarget;
}

/**
 * A Skills Studio artifact id (`skill:<dir>`, `command:<file.md>`, `agent:<file.md>`)
 * → its paths, only when it lies inside one of the folders of its type, as
 * written and after links are resolved. `realBase` is the folder everything
 * below the artifact is confined to (confineSubPath, staysInside).
 * @param roots { skill: [root…], command: [root…], agent: [root…] } where a root is a
 *              folder, or { dir, anchor?, links? }: `anchor` is a folder the root must
 *              really be inside (a project), `links` honours a linked skill folder.
 */
export function confineArtifact(decodedId, roots = {}, { fs = realFs } = {}) {
  const text = String(decodedId ?? '');
  const cut = text.indexOf(':');
  const type = cut > 0 ? text.slice(0, cut) : '';
  const rawPath = cut > 0 ? text.slice(cut + 1) : '';
  if (!ARTIFACT_TYPES.has(type) || !rawPath || rawPath.includes('\0')) throw new PathConfineError(400, 'Not an artifact id');
  const target = resolve(rawPath);
  const allowed = (Array.isArray(roots[type]) ? roots[type] : []).filter(Boolean).map(rootOf).filter(r => r.dir);
  const lexical = allowed.filter(root => isInside(root.dir, target));
  if (!lexical.length) throw new PathConfineError(403, 'That path is outside the skills, commands and agents folders.');
  if (type !== 'skill' && !/\.md$/i.test(target)) throw new PathConfineError(400, 'Not a command or agent file');
  for (const root of lexical) {
    const realBase = artifactBase(type, target, root, fs);
    if (!realBase) continue;
    if (type === 'skill') return { type, dirPath: target, filePath: join(target, 'SKILL.md'), realBase };
    return { type, dirPath: dirname(target), filePath: target, realBase };
  }
  throw new PathConfineError(403, 'That path leaves the skills, commands and agents folders through a link.');
}

/** True when `fullPath` (built by the server: an icon, a tree entry) really is below the artifact. Never throws. */
export function staysInside(artifact, fullPath, { fs = realFs } = {}) {
  if (!artifact?.realBase || !fullPath) return false;
  try { return isInside(artifact.realBase, realPathOf(fullPath, fs)); } catch { return false; }
}

/** A file or folder below an artifact, named by the browser → its path, when it really stays below. */
export function confineSubPath(artifact, subPath, { fs = realFs } = {}) {
  if (typeof subPath !== 'string' || !subPath || subPath.includes('\0')) throw new PathConfineError(400, 'Not a file path');
  const full = join(String(artifact?.dirPath || ''), subPath);
  if (!artifact?.dirPath || !isInside(artifact.dirPath, full)) throw new PathConfineError(403, 'Path traversal not allowed.');
  if (!staysInside(artifact, full, { fs })) throw new PathConfineError(403, 'That path leaves the artifact through a link.');
  return full;
}

/** A path about to be created under one root (create, import) → the path, when it would really land there. */
export function confineToRoot(root, target, { fs = realFs } = {}) {
  const r = rootOf(root);
  const full = resolve(String(target ?? ''));
  if (!r.dir || !isInside(r.dir, full)) throw new PathConfineError(403, 'That path is outside the skills, commands and agents folders.');
  let ok = false;
  try {
    const realRoot = realPathOf(r.dir, fs);
    ok = (!r.anchor || isInside(realPathOf(r.anchor, fs), realRoot)) && isInside(realRoot, realPathOf(full, fs));
  } catch { ok = false; }
  if (!ok) throw new PathConfineError(403, 'That path leaves the skills, commands and agents folders through a link.');
  return full;
}

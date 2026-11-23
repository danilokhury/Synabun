// ─────────────────────────────────────────────────────────────────────────────
// OpenCode V2 — a session whose folder is gone
//
// OpenCode binds a session to the folder it was created in, for good. When that
// folder no longer exists (a worktree that was removed, a project that was
// moved), OpenCode 2 still lists the session and even creates a new one there,
// and then refuses every prompt of it: 404 "Location not found: <folder>".
// Sending another folder with the prompt changes nothing.
//
// So the panel cannot repair such a session: it moves on. This module decides
// (DOM-free, unit-tested; the server imports the message and the code):
//   • which folder an error says is gone, and whether it is this panel's;
//   • where to go instead: the registered project the folder was inside (the
//     project root of a removed worktree), else no project at all, which is the
//     folder SynaBun's OpenCode serve runs in;
//   • what to tell the user.
// ocp-v2-panel.js does the moving (a new session in the other folder).
// ─────────────────────────────────────────────────────────────────────────────

/** The `code` of a refusal SynaBun's server makes for a folder that does not exist. */
export const LOCATION_MISSING_CODE = 'LOCATION_MISSING';

/** OpenCode's own sentence for it; SynaBun's server refuses in the same words, so one reading covers both. */
export function locationNotFoundMessage(directory) {
  return `Location not found: ${String(directory || '').trim()}`;
}

const LOCATION_NOT_FOUND_RE = /Location not found:\s*(\S.*?)\s*$/i;

/** The folder an error message says is gone, or null when it says nothing of the kind. */
export function missingLocationOf(message) {
  const text = typeof message === 'string' ? message : String(message?.message || message?.error || '');
  const match = text.match(LOCATION_NOT_FOUND_RE);
  return match ? match[1] : null;
}

// A folder as it is compared: one kind of separator, no trailing one, and no
// letter case on a Windows drive path.
function folderKey(folder) {
  let key = String(folder || '').trim().replace(/\\/g, '/');
  if (key.length > 1) key = key.replace(/\/+$/, '') || '/';
  if (/^[A-Za-z]:(\/|$)/.test(key)) key = key.toLowerCase();
  return key;
}

/** Whether two paths name the same folder (separators, a trailing slash, a Windows drive's case). */
export function sameFolder(a, b) {
  const left = folderKey(a);
  return !!left && left === folderKey(b);
}

/** Whether `folder` is `parent` or inside it. */
export function folderInside(folder, parent) {
  const inner = folderKey(folder);
  const outer = folderKey(parent);
  if (!inner || !outer) return false;
  if (inner === outer) return true;
  return inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`);
}

const projectPathOf = (project) => (typeof project === 'string' ? project : String(project?.path || ''));

/**
 * Where to work instead of a folder that is gone: the deepest registered
 * project that contains it (and is not one of `avoid`, the folders already
 * found gone), else '' — no project, the folder the serve itself runs in.
 */
export function fallbackProjectFor(missing, projects, { avoid = [] } = {}) {
  const gone = [missing, ...avoid].filter(Boolean);
  let best = '';
  for (const project of Array.isArray(projects) ? projects : []) {
    const path = projectPathOf(project);
    if (!path || !folderInside(missing, path)) continue;
    if (gone.some((folder) => sameFolder(folder, path))) continue;
    if (folderKey(path).length > folderKey(best).length) best = path;
  }
  return best;
}

/**
 * The folder an error names as gone, when it is this panel's: the project it
 * is on, or the folder of the session on screen. Null otherwise (an error about
 * something else, or about a folder that is not this panel's to leave).
 */
export function missingPanelLocation({ message, cwd = '', sessionDirectory = '' } = {}) {
  const missing = missingLocationOf(message);
  if (!missing) return null;
  return sameFolder(missing, cwd) || sameFolder(missing, sessionDirectory) ? missing : null;
}

/** What the user is told once the panel has moved on. */
export function locationRecoveryNotice({ missing, fallback } = {}) {
  const gone = `The folder ${missing} no longer exists, so OpenCode cannot run a session there.`;
  return fallback
    ? `${gone} A new session was started in ${fallback}. Send your message again.`
    : `${gone} A new session was started without a project: choose one in the project menu, then send your message again.`;
}

/**
 * The move for a folder that is gone: `{ missing, fallback, notice }`, or null
 * when there is nowhere better to go (the panel is already on no project, and
 * no registered project holds the folder: moving again would change nothing).
 */
export function planLocationRecovery({ missing, cwd = '', projects = [], avoid = [] } = {}) {
  if (!missing) return null;
  const fallback = fallbackProjectFor(missing, projects, { avoid });
  if (!fallback && !folderKey(cwd)) return null;
  return { missing, fallback, notice: locationRecoveryNotice({ missing, fallback }) };
}

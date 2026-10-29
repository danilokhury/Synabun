// ═══════════════════════════════════════════
// SynaBun — Browser policy: the projects where automated tests may run
// ═══════════════════════════════════════════
//
// The browser policy (lib/browser-tool-policy.js) lets a test runner (npm
// test, node --test, vitest, jest, npx playwright test) run browser tests from
// inside the session's own project, and from inside the `roots` its caller
// passes: the registered SynaBun projects (DATA_HOME/data/claude-code-projects.json,
// the "Registered projects" of the Assistant's routing sheet) that are code
// projects. A registered project is a code project when its folder
//   - is an absolute path,
//   - holds `.git` (a git work tree's root; a worktree's or a submodule's `.git`
//     file counts), `package.json`, `deno.json` or `deno.jsonc` at its top,
//   - is not the home folder or a folder above it, and
//   - is not the Downloads folder or anything inside it (downloaded files are
//     untrusted, whatever they hold).
// Read where a run starts (server.js for workers, assistant-runtime.js for the
// brain); the policy module itself reads nothing and gets the list.

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

/** What at a folder's top makes it a code project. */
export const CODE_PROJECT_MARKERS = Object.freeze(['.git', 'package.json', 'deno.json', 'deno.jsonc']);

// macOS and Windows name a folder in any letter case: the exclusions compare that way.
const caseless = (path) => (process.platform === 'darwin' || process.platform === 'win32' ? path.toLowerCase() : path);
function inside(child, parent) {
  const rel = relative(caseless(resolve(parent)), caseless(resolve(child)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Why `path` is not a code project the browser policy lets tests run in, else null. `stat`: tests. */
export function codeProjectRefusal(path, { home = homedir(), stat = statSync } = {}) {
  const text = typeof path === 'string' ? path.trim() : '';
  if (!text || !isAbsolute(text)) return 'not an absolute path';
  const root = resolve(text);
  if (inside(home, root)) return 'the home folder or a folder above it';
  if (inside(root, resolve(home, 'Downloads'))) return 'the Downloads folder (downloaded files)';
  const marked = CODE_PROJECT_MARKERS.some((name) => {
    try {
      const entry = stat(resolve(root, name));
      return name === '.git' ? entry.isDirectory() || entry.isFile() : entry.isFile();
    } catch { return false; }
  });
  return marked ? null : 'no .git, package.json, deno.json or deno.jsonc at its top';
}

/**
 * The registered projects (claude-code-projects.json rows `{ path }` or plain
 * paths) that are code projects, resolved, each once: the browser policy's
 * `roots`.
 */
export function browserPolicyRoots(projects, options = {}) {
  const out = [];
  for (const row of Array.isArray(projects) ? projects : []) {
    const path = typeof row === 'string' ? row : row?.path;
    if (typeof path !== 'string' || codeProjectRefusal(path, options) !== null) continue;
    const root = resolve(path.trim());
    if (!out.includes(root)) out.push(root);
  }
  return out;
}

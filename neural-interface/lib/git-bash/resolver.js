// ═══════════════════════════════════════════
// SynaBun — Git Bash: which one Claude Code runs
// ═══════════════════════════════════════════
//
// Claude Code on Windows looks for Git Bash itself, in this order (read from
// its 2.1.302 build): CLAUDE_CODE_GIT_BASH_PATH when it names an existing
// bash.exe / sh.exe (the `env` block of ~/.claude/settings.json is applied
// before it looks, so a value there counts the same), then
// C:\Program Files\Git\bin\bash.exe and C:\Program Files (x86)\Git\bin\bash.exe,
// then the first `git` on its PATH, two folders up, bin\bash.exe. Without one,
// its Bash tool is gone and every hook runs in PowerShell.
//
// resolveGitBash() answers which Git Bash a Claude Code started by SynaBun ends
// up with, and whether SynaBun has to name it:
//
//   env / settings  CLAUDE_CODE_GIT_BASH_PATH of SynaBun's own environment, or
//                   of the user's ~/.claude/settings.json: the user's choice,
//                   which Claude Code reads by itself
//   system          a Git Bash of the PC's own. When Claude Code finds it by
//                   its own rules nothing is passed (SynaBun never overrides
//                   what already works); one only SynaBun finds (git on PATH
//                   in a layout Claude Code does not walk, a per-user or Scoop
//                   install that is not on PATH) is passed to it
//   bundled         SynaBun's copy inside an installed app (<resources>\git)
//   downloaded      SynaBun's copy in the data home (a Windows npm install)
//
// A path inside SynaBun's own copies is never taken for the user's, whatever
// variable or PATH entry leads to it (a server started from a SynaBun terminal
// inherits both): it is found again as SynaBun's own, last. Every file system
// question is injectable, so the Windows rules are tested from any system.

import { statSync } from 'node:fs';
import { win32 } from 'node:path';

/** The variable Claude Code reads (and the settings `env` key SynaBun writes for the user's own CLI). */
export const GIT_BASH_ENV = 'CLAUDE_CODE_GIT_BASH_PATH';

/** The file names Claude Code accepts in CLAUDE_CODE_GIT_BASH_PATH. */
const BASH_NAMES = new Set(['bash.exe', 'sh.exe', 'bash', 'sh']);

/** Where Claude Code looks before PATH: these two, literally. */
export const CLAUDE_FIXED_BASH = Object.freeze(['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']);

const key = (path) => win32.normalize(String(path || '')).replace(/[\\/]+$/, '').toLowerCase();

const defaultIsFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };

/** Is `path` inside one of `roots` (or one of them)? Windows rules: case and slashes do not matter. */
export function insideAny(path, roots) {
  const at = key(path);
  return roots.filter(Boolean).some((root) => { const top = key(root); return at === top || at.startsWith(`${top}\\`); });
}

/** A value of CLAUDE_CODE_GIT_BASH_PATH that Claude Code would take: a bash.exe / sh.exe that exists. */
export function acceptableBashPath(value, { isFile = defaultIsFile } = {}) {
  const path = String(value || '').trim();
  if (!path || !BASH_NAMES.has(win32.basename(path).toLowerCase())) return false;
  return isFile(path);
}

/** The PATH folders, in order, `%VARS%` of an unexpanded entry left as they are (they name no git either way). */
function pathFolders(pathValue) {
  return String(pathValue || '').split(';').map((entry) => entry.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

/** The first git on `pathValue`, as Windows finds it (git.exe, then git.cmd), skipping SynaBun's own folders. */
export function firstGitOnPath(pathValue, { isFile = defaultIsFile, own = [] } = {}) {
  for (const folder of pathFolders(pathValue)) {
    for (const name of ['git.exe', 'git.cmd']) {
      const file = win32.join(folder, name);
      if (!isFile(file)) continue;
      if (insideAny(file, own)) continue;
      return file;
    }
  }
  return null;
}

/** The Git Bash a git found on PATH belongs to: Claude Code's own rule first (git\..\..\bin), then one more level up. */
export function bashOfGit(gitFile, { isFile = defaultIsFile } = {}) {
  if (!gitFile) return null;
  const folder = win32.dirname(gitFile);
  for (const candidate of [win32.join(folder, '..', 'bin', 'bash.exe'), win32.join(folder, '..', '..', 'bin', 'bash.exe')]) {
    if (isFile(candidate)) return win32.normalize(candidate);
  }
  return null;
}

/** The folders Git for Windows is installed in when nothing names it: every installer's default, per machine and per user, and Scoop's. */
export function standardGitRoots(env = {}) {
  const roots = [];
  const add = (base, ...rest) => { if (base) roots.push(win32.join(base, ...rest)); };
  add(env.ProgramFiles || env.PROGRAMFILES, 'Git');
  add(env.ProgramW6432, 'Git');
  add(env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)'], 'Git');
  roots.push('C:\\Program Files\\Git', 'C:\\Program Files (x86)\\Git');
  add(env.LOCALAPPDATA, 'Programs', 'Git');
  add(env.SCOOP, 'apps', 'git', 'current');
  add(env.USERPROFILE, 'scoop', 'apps', 'git', 'current');
  const seen = new Set();
  return roots.filter((root) => { const id = key(root); if (seen.has(id)) return false; seen.add(id); return true; });
}

/**
 * What Claude Code finds by itself, by its own rules, or null: its variable (from SynaBun's environment, then the
 * user's settings), its two fixed places, the first git on PATH. `{ path, source }`.
 */
export function claudeCodeFinds({ env = {}, settingsValue = null, pathValue = '', isFile = defaultIsFile, own = [] } = {}) {
  const fromEnv = env[GIT_BASH_ENV];
  if (fromEnv && !insideAny(fromEnv, own) && acceptableBashPath(fromEnv, { isFile })) return { path: win32.normalize(fromEnv), source: 'env' };
  if (settingsValue && !insideAny(settingsValue, own) && acceptableBashPath(settingsValue, { isFile })) return { path: win32.normalize(settingsValue), source: 'settings' };
  for (const fixed of CLAUDE_FIXED_BASH) if (isFile(fixed)) return { path: fixed, source: 'system' };
  const git = firstGitOnPath(pathValue, { isFile, own });
  if (git) {
    const bash = win32.normalize(win32.join(win32.dirname(git), '..', 'bin', 'bash.exe'));
    if (isFile(bash) && !insideAny(bash, own)) return { path: bash, source: 'system' };
  }
  return null;
}

/** The cmd folder (with its git.exe) of the Git for Windows a bin\bash.exe belongs to, or null. */
export function gitOfBash(bashPath, { isFile = defaultIsFile } = {}) {
  if (!bashPath || win32.basename(win32.dirname(bashPath)).toLowerCase() !== 'bin') return null;
  const root = win32.dirname(win32.dirname(bashPath));
  const git = win32.join(root, 'cmd', 'git.exe');
  return isFile(git) ? { git, cmdDir: win32.dirname(git) } : null;
}

/**
 * Which Git Bash a Claude Code started by SynaBun ends up with, and what SynaBun has to give it.
 *
 * @param {object} o
 * @param {string} [o.platform]
 * @param {object} [o.env]            SynaBun's environment (CLAUDE_CODE_GIT_BASH_PATH, the folders above)
 * @param {string|null} [o.settingsValue]  env.CLAUDE_CODE_GIT_BASH_PATH of the user's ~/.claude/settings.json
 * @param {string} [o.pathValue]      the PATH a git is looked for on (this process's, then the OS PATH)
 * @param {Array<{ source: 'bundled' | 'downloaded', root: string, ok: boolean, bash: string, git: string }>} [o.copies]
 *                                    SynaBun's own copies, already checked (manager.js), in this order
 * @param {string[]} [o.ownRoots]     SynaBun's own Git folders: nothing inside them is the user's
 * @returns {{ supported: boolean, path: string|null, source: string|null, passToClaude: boolean, git: string|null, cmdDir: string|null, claudeFindsItself: boolean }}
 */
export function resolveGitBash({ platform = process.platform, env = process.env, settingsValue = null, pathValue = '', copies = [], ownRoots = [], isFile = defaultIsFile } = {}) {
  const none = { supported: platform === 'win32', path: null, source: null, passToClaude: false, git: null, cmdDir: null, claudeFindsItself: false };
  if (platform !== 'win32') return none;
  const own = ownRoots.filter(Boolean);

  // 1. What Claude Code finds by itself: nothing is passed, nothing downloaded.
  const found = claudeCodeFinds({ env, settingsValue, pathValue, isFile, own });
  if (found) {
    const git = found.source === 'system' ? gitOfBash(found.path, { isFile }) : null;
    return { ...none, path: found.path, source: found.source, git: git?.git || null, cmdDir: git?.cmdDir || null, claudeFindsItself: true };
  }

  // 2. A Git Bash of the PC that only SynaBun finds: named to Claude Code.
  const candidates = [];
  const onPath = firstGitOnPath(pathValue, { isFile, own });
  const derived = bashOfGit(onPath, { isFile });
  if (derived) candidates.push(derived);
  for (const root of standardGitRoots(env)) candidates.push(win32.join(root, 'bin', 'bash.exe'));
  for (const candidate of candidates) {
    if (insideAny(candidate, own) || !isFile(candidate)) continue;
    const git = gitOfBash(candidate, { isFile });
    return { ...none, path: candidate, source: 'system', passToClaude: true, git: git?.git || null, cmdDir: git?.cmdDir || null };
  }

  // 3. SynaBun's own copy: the one inside the app, then the one in the data home.
  for (const copy of copies) {
    if (!copy?.ok) continue;
    return { ...none, path: copy.bash, source: copy.source, passToClaude: true, git: copy.git, cmdDir: win32.dirname(copy.git) };
  }
  return none;
}

/** `env` with PATH (whatever its spelling: Windows keeps one, under the first name) ending in `folder`, once. */
function appendToPath(env, folder) {
  const keys = Object.keys(env).filter((name) => name.toUpperCase() === 'PATH');
  const name = keys[0] || 'Path';
  const parts = String(env[name] || '').split(';').filter(Boolean);
  const out = { ...env };
  for (const each of keys) delete out[each];
  out[name] = [...parts.filter((part) => key(part) !== key(folder)), folder].join(';');
  return out;
}

/**
 * The environment of a Claude Code process SynaBun starts: `env` itself, unless SynaBun has to name its Git Bash
 * (its own copy, or one only it finds): then CLAUDE_CODE_GIT_BASH_PATH, and that Git's cmd folder at the end of
 * PATH (Claude Code's own git commands find git there). The system's PATH and registry are never changed.
 */
export function gitBashChildEnv(env, resolution, { platform = process.platform } = {}) {
  if (platform !== 'win32' || !resolution?.passToClaude || !resolution.path) return env;
  const out = { ...env, [GIT_BASH_ENV]: resolution.path };
  return resolution.cmdDir ? appendToPath(out, resolution.cmdDir) : out;
}

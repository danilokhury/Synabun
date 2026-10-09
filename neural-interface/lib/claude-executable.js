// ── Which Claude Code runs: the user's own installation ──
//
// Claude Code is installed by the user, separately from SynaBun (the native
// installer, Homebrew, npm). Nothing in SynaBun carries a copy: the Claude
// Agent SDK is installed without the executable it would otherwise bring (see
// lib/external-tools.js at the package root), so every SDK call has to be told
// which executable to start. This module is where that answer comes from, for
// the side panel, the Assistant's Claude brain, native loops, session titles
// and the model probe alike:
//
//   resolveClaudeLauncher        what a terminal or a shell would start: the
//                                user's configured command, else the first
//                                `claude` on PATH that is not inside SynaBun
//   resolveClaudeSdkExecutable   what the SDK can start. It spawns with
//                                shell:false, so an npm command file on Windows
//                                is followed to the executable behind it
//
// A missing installation is an ordinary state, not a failure: both answer with
// `path: null` and the caller says CLAUDE_NOT_INSTALLED.
//
// Every dependency is injectable (platform, PATH, the file system), so Windows
// resolution is tested from any host. Nothing here throws.

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { getAugmentedPath } from './augmented-path.js';
import { resolveClaudeExecutableOverride } from './native-binary-runtime.js';

/**
 * What a session says when no Claude Code is installed. The words "Claude CLI
 * not found" are what the side panel shows its install help on.
 */
export const CLAUDE_NOT_INSTALLED = 'Claude CLI not found. Claude Code is installed separately from SynaBun: install it, then send your message again.';

/** A real executable first, then the command files a shell can run. */
const WINDOWS_LAUNCHER_ORDER = ['.exe', '.cmd', '.bat', '.ps1'];

const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

function unique(values, pathImpl, insensitive) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text) continue;
    const normal = pathImpl.normalize(text);
    const key = insensitive ? normal.toLowerCase() : normal;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normal);
  }
  return out;
}

/**
 * The launcher Windows should start, from a list in PATH order (as `where`
 * prints it, or findOnPath below). PATH order decides between folders; inside
 * one folder a real executable beats a command file, and npm's extensionless
 * shell script (which Windows cannot start) is only ever the last resort.
 */
export function selectWindowsLauncher(launchers = [], accept = () => true) {
  const accepted = unique(launchers, path.win32, true).filter(accept);
  const folders = new Map();
  for (const launcher of accepted) {
    const folder = path.win32.dirname(launcher).toLowerCase();
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(launcher);
  }
  for (const group of folders.values()) {
    for (const extension of WINDOWS_LAUNCHER_ORDER) {
      const hit = group.find(launcher => launcher.toLowerCase().endsWith(extension));
      if (hit) return hit;
    }
  }
  return accepted[0] || null;
}

function defaultIsLaunchable(file, platform) {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH without any `node_modules/.bin` folder: a dependency's command is never the user's tool. */
export function withoutPackageBins(pathValue, platform = process.platform) {
  const delimiter = platform === 'win32' ? ';' : ':';
  return String(pathValue || '').split(delimiter)
    .filter(entry => entry && !/[\\/]node_modules[\\/]\.bin[\\/]?$/i.test(entry))
    .join(delimiter);
}

/**
 * Every file a command name resolves to, in PATH order, read from the file
 * system (no `which`, no shell: a folder with a space in its name is just a
 * folder). On Windows each folder is tried with the launcher extensions, then
 * bare.
 */
export function findOnPath(command, {
  platform = process.platform,
  pathValue = getAugmentedPath(),
  isLaunchable = defaultIsLaunchable,
} = {}) {
  const name = String(command || '').trim();
  if (!name) return [];
  const pathImpl = pathFor(platform);
  const windows = platform === 'win32';
  const names = windows && !pathImpl.extname(name) ? [...WINDOWS_LAUNCHER_ORDER.map(extension => name + extension), name] : [name];
  const found = [];
  for (const folder of String(pathValue || '').split(windows ? ';' : ':')) {
    if (!folder) continue;
    for (const candidate of names) {
      const file = pathImpl.join(folder, candidate);
      if (isLaunchable(file, platform)) found.push(file);
    }
  }
  return unique(found, pathImpl, windows);
}

/**
 * The Claude Code a terminal would start.
 *
 *   configured   cli-config.json → "claude-code": { "command": "…" } (Settings > Terminal):
 *                a path is taken as it is, a name is looked up on PATH
 *   path         the first `claude` on PATH
 *
 * Never a file inside SynaBun (`isInsideSynabun`) and never one from a
 * `node_modules/.bin` folder on PATH: a copy that came with a dependency must
 * not stand in for the user's own.
 *
 * @returns {{path: string|null, source: 'configured'|'path'|'missing', rejected: string[]}}
 */
export function resolveClaudeLauncher({
  configured = '',
  platform = process.platform,
  pathValue = getAugmentedPath(),
  isInsideSynabun = () => false,
  exists = existsSync,
  isLaunchable = defaultIsLaunchable,
} = {}) {
  const pathImpl = pathFor(platform);
  const windows = platform === 'win32';
  const rejected = [];
  const outside = (file) => {
    if (!isInsideSynabun(file)) return true;
    rejected.push(file);
    return false;
  };
  const lookup = (command) => {
    const hits = findOnPath(command, { platform, pathValue: withoutPackageBins(pathValue, platform), isLaunchable }).filter(outside);
    return (windows ? selectWindowsLauncher(hits) : hits[0]) || null;
  };

  const wanted = String(configured || '').trim();
  if (wanted && wanted !== 'claude') {
    const isPath = wanted.includes('/') || (windows && wanted.includes('\\'));
    if (isPath) {
      if (exists(wanted) && outside(wanted)) return { path: pathImpl.normalize(wanted), source: 'configured', rejected };
    } else {
      const hit = lookup(wanted);
      if (hit) return { path: hit, source: 'configured', rejected };
    }
  }

  const hit = lookup('claude');
  return hit ? { path: hit, source: 'path', rejected } : { path: null, source: 'missing', rejected };
}

/**
 * Where the executable behind an npm command file is, most likely first. npm
 * puts `claude.cmd` next to `node_modules\@anthropic-ai\claude-code`, whose
 * `bin\claude.exe` is the program (older releases: `cli.js`, run by Node). A
 * `.bin` folder has the package one level up instead.
 */
export function windowsClaudeTargets(launcher) {
  const pathImpl = path.win32;
  const folder = pathImpl.dirname(String(launcher || ''));
  const roots = [pathImpl.join(folder, 'node_modules')];
  if (pathImpl.basename(folder).toLowerCase() === '.bin') roots.push(pathImpl.dirname(folder));
  return roots.flatMap((root) => {
    const packageDir = pathImpl.join(root, '@anthropic-ai', 'claude-code');
    return [pathImpl.join(packageDir, 'bin', 'claude.exe'), pathImpl.join(packageDir, 'cli.js')];
  });
}

/**
 * The executable an Agent SDK call is given as `pathToClaudeCodeExecutable`.
 *
 *   override    cli-config.json → "claude-skin": { "sdkExecutable": "…" }, when it is usable
 *   installed   the user's Claude Code (`launcher`, from resolveClaudeLauncher)
 *
 * The SDK starts this path itself, without a shell, so it has to be a program
 * or a script: on Windows a `.cmd`, `.bat` or `.ps1` launcher is followed to
 * what it runs. `path: null` means there is nothing to start; `reason` says
 * why in a sentence a person can act on, `ignored` why an override was passed
 * over.
 *
 * @returns {{path: string|null, source: 'override'|'installed'|'missing', kind: string|null, reason: string|null, ignored: string|null, launcher: string|null}}
 */
export function resolveClaudeSdkExecutable({
  launcher = null,
  sdkExecutable = null,
  platform = process.platform,
  exists = existsSync,
  isInsideSynabun = () => false,
  validate = resolveClaudeExecutableOverride,
} = {}) {
  const answer = (fields) => ({ path: null, source: 'missing', kind: null, reason: null, ignored: null, launcher: launcher || null, ...fields });
  let ignored = null;

  const explicit = typeof sdkExecutable === 'string' ? sdkExecutable.trim() : '';
  if (explicit) {
    const verdict = validate(explicit, { platform });
    if (verdict.ok && verdict.path) return answer({ path: verdict.path, source: 'override', kind: verdict.kind });
    ignored = verdict.reason || `Not usable: ${explicit}`;
  }

  const installed = typeof launcher === 'string' ? launcher.trim() : '';
  // A bare name is what "nothing was found" looks like to older callers.
  if (!installed || !(installed.includes('/') || installed.includes('\\'))) return answer({ reason: CLAUDE_NOT_INSTALLED, ignored });

  const candidates = platform === 'win32' && !/\.exe$/i.test(installed) && !/\.[cm]?js$/i.test(installed)
    ? windowsClaudeTargets(installed).filter(file => exists(file))
    : [installed];
  let refusal = null;
  for (const candidate of candidates) {
    if (isInsideSynabun(candidate)) { refusal = `${candidate} is inside SynaBun, not an installation of Claude Code`; continue; }
    const verdict = validate(candidate, { platform });
    if (verdict.ok && verdict.path) return answer({ path: verdict.path, source: 'installed', kind: verdict.kind, ignored });
    refusal = verdict.reason || `Not usable: ${candidate}`;
  }
  return answer({
    reason: refusal
      ? `Claude Code was found at ${installed}, but it cannot be started from there: ${refusal}.`
      : `Claude Code was found at ${installed}, but not the program that command runs. Reinstall Claude Code, or name its executable in cli-config.json ("claude-skin": { "sdkExecutable": "…" }).`,
    ignored,
  });
}

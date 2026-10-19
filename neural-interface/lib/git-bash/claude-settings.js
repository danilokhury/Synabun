// ═══════════════════════════════════════════
// SynaBun — Git Bash for the user's own `claude`
// ═══════════════════════════════════════════
//
// Every Claude Code that SynaBun starts gets its Git Bash in its environment
// (resolver.js gitBashChildEnv). A `claude` the user starts in another
// terminal does not: on a PC whose only Git Bash is SynaBun's copy, that one
// is named in the `env` block of ~/.claude/settings.json, which Claude Code
// applies before it looks for Git Bash (checked in its 2.1.302 build:
// applySafeConfigEnvironmentVariables applies the user settings' env in full,
// in init(), before the Git Bash lookup).
//
//   SynaBun's copy is in use   env.CLAUDE_CODE_GIT_BASH_PATH = its bash.exe,
//                              unless the user put a value of their own there
//   it is not                  a value that is SynaBun's (a path inside one of
//                              its copies) is removed; any other is left
//
// Windows only. The file is read and written by the caller's functions
// (server.js readClaudeSettingsForWrite / writeClaudeSettings: a file that is
// not JSON is never written over, and the write is atomic). Never throws.

import { GIT_BASH_ENV, insideAny } from './resolver.js';

/**
 * Bring the user's settings in line with the Git Bash in use.
 * @param {object} o
 * @param {{ source: string|null, path: string|null }} o.resolution  resolver.js resolveGitBash()
 * @param {string} o.settingsPath   ~/.claude/settings.json
 * @param {(path: string) => object} o.read    {} when the file does not exist; throws when it is not JSON
 * @param {(path: string, settings: object) => void} o.write
 * @param {string[]} o.ownRoots     SynaBun's own Git folders
 * @returns {{ state: 'skipped' | 'unchanged' | 'written' | 'removed' | 'kept-user-value' | 'error', value?: string|null, message?: string }}
 */
export function syncClaudeSettingsGitBash({ resolution, settingsPath, read, write, ownRoots = [], platform = process.platform }) {
  if (platform !== 'win32' || !settingsPath) return { state: 'skipped' };
  const ours = resolution?.source === 'bundled' || resolution?.source === 'downloaded' ? resolution.path : null;
  let settings;
  try { settings = read(settingsPath); } catch (error) {
    return { state: 'error', message: String(error?.message || error) };
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { state: 'error', message: `${settingsPath} does not hold a settings object.` };
  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : null;
  const current = typeof env?.[GIT_BASH_ENV] === 'string' ? env[GIT_BASH_ENV] : null;
  const isOurs = current !== null && insideAny(current, ownRoots);

  if (ours) {
    if (current === ours) return { state: 'unchanged', value: ours };
    // A value of the user's own (one that does not work, or the resolver would have taken it) is theirs to change.
    if (current !== null && !isOurs) return { state: 'kept-user-value', value: current };
    settings.env = { ...(env || {}), [GIT_BASH_ENV]: ours };
  } else {
    if (!isOurs) return { state: 'unchanged', value: current };
    const rest = { ...env };
    delete rest[GIT_BASH_ENV];
    if (Object.keys(rest).length) settings.env = rest;
    else delete settings.env;
  }
  try {
    write(settingsPath, settings);
  } catch (error) {
    return { state: 'error', message: String(error?.message || error) };
  }
  return ours ? { state: 'written', value: ours } : { state: 'removed', value: null };
}

/** The user's own value of CLAUDE_CODE_GIT_BASH_PATH in their settings, or null (what the resolver weighs). */
export function settingsGitBashValue({ settingsPath, read }) {
  try {
    const settings = read(settingsPath);
    const value = settings?.env?.[GIT_BASH_ENV];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch { return null; }
}

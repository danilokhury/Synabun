// Environment + shell arguments for SynaBun terminals, matching what a native
// macOS terminal hands its shell: a login shell, a UTF-8 locale, truecolor,
// and a terminal identity of its own (TERM_PROGRAM) instead of whatever
// terminal happened to launch the SynaBun server.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

// Identity/session variables that belong to the terminal or IDE the SERVER was
// started from. Leaking them makes CLIs believe they run inside VS Code, tmux,
// iTerm2, a nested Claude Code session, etc.
const STRIP_EXACT = new Set([
  'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT',
  'TMUX', 'TMUX_PANE', 'STY', 'TERMCAP', 'COLUMNS', 'LINES',
  'TERM_SESSION_ID', 'LC_TERMINAL', 'LC_TERMINAL_VERSION', 'VTE_VERSION',
  'WT_SESSION', 'WT_PROFILE_ID',
  'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID',
]);
const STRIP_PREFIXES = ['VSCODE_', 'ITERM_', 'KITTY_', 'WEZTERM_', 'GHOSTTY_', 'ALACRITTY_'];

// Shells that accept `-l -c <cmd>` (login + command). tcsh/csh only allow -l
// as the sole argument, so they keep the plain `-c` wrapper.
const LOGIN_COMMAND_SHELLS = new Set(['zsh', 'bash', 'sh', 'dash', 'ksh', 'mksh', 'yash', 'fish']);

let _version = null;
function synabunVersion() {
  if (_version !== null) return _version;
  try {
    _version = String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '');
  } catch {
    _version = '';
  }
  return _version;
}

export function isStrippedTerminalVar(key) {
  return STRIP_EXACT.has(key) || STRIP_PREFIXES.some(p => key.startsWith(p));
}

/**
 * Layering (later wins): cleaned base < terminal identity defaults <
 * profileEnv (e.g. FORCE_COLOR/TERM for CLI profiles) < extraEnv (loop pins,
 * CODEX_HOME, ...).
 */
export function buildTerminalEnv({
  base = process.env,
  profileEnv = {},
  extraEnv = {},
  platform = process.platform,
  version = synabunVersion(),
  localeFallback = 'en_US.UTF-8',
} = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (v === undefined || isStrippedTerminalVar(k)) continue;
    env[k] = v;
  }
  env.TERM_PROGRAM = 'SynaBun';
  if (version) env.TERM_PROGRAM_VERSION = version;
  env.COLORTERM = 'truecolor';
  if (platform !== 'win32' && !env.LANG && !env.LC_ALL && !env.LC_CTYPE) {
    env.LANG = localeFallback;
  }
  return { ...env, ...(profileEnv || {}), ...(extraEnv || {}) };
}

export function shellSupportsLoginCommand(shellPath) {
  return LOGIN_COMMAND_SHELLS.has(basename(String(shellPath || '')).replace(/\.exe$/i, ''));
}

/** Interactive shell tab: a login shell, like Terminal.app / iTerm2. */
export function interactiveShellArgs(platform = process.platform) {
  return platform === 'win32' ? [] : ['-l'];
}

/**
 * CLI tab: run the CLI, then drop into an interactive login shell when it
 * exits. Login-command shells source the same profile a native terminal would
 * (PATH from .zprofile, brew shellenv) before the CLI starts.
 */
export function cliWrapperArgs(shellPath, cmd, platform = process.platform) {
  if (platform === 'win32') return ['/k', cmd];
  if (shellSupportsLoginCommand(shellPath)) return ['-lc', `${cmd}; exec $SHELL -l`];
  return ['-c', `${cmd}; exec $SHELL`];
}

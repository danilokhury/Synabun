import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTerminalEnv, cliWrapperArgs, interactiveShellArgs, isStrippedTerminalVar, shellSupportsLoginCommand } from '../lib/terminal-env.js';

test('terminal env strips the launching terminal/IDE identity and sets SynaBun\'s own', () => {
  const env = buildTerminalEnv({
    base: {
      PATH: '/usr/bin', HOME: '/Users/x', LANG: 'pt_BR.UTF-8',
      TERM_PROGRAM: 'Apple_Terminal', TERM_PROGRAM_VERSION: '455', TERM_SESSION_ID: 'w0t0p0',
      VSCODE_PID: '1', VSCODE_IPC_HOOK: 'x', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli',
      TMUX: '/tmp/tmux', TMUX_PANE: '%1', STY: 's', TERMCAP: 't', COLUMNS: '80', LINES: '24',
      ITERM_SESSION_ID: 'i', ITERM_PROFILE: 'p', LC_TERMINAL: 'iTerm2', KITTY_WINDOW_ID: '1',
      WEZTERM_PANE: '1', GHOSTTY_RESOURCES_DIR: 'g', ALACRITTY_WINDOW_ID: 'a', VTE_VERSION: '7',
      NODE_CHANNEL_FD: '3', NODE_UNIQUE_ID: 'u', WT_SESSION: 'w',
    },
    platform: 'darwin',
    version: '2026.9.8',
  });
  for (const k of ['TERM_SESSION_ID', 'VSCODE_PID', 'VSCODE_IPC_HOOK', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'TMUX',
    'TMUX_PANE', 'STY', 'TERMCAP', 'COLUMNS', 'LINES', 'ITERM_SESSION_ID', 'ITERM_PROFILE', 'LC_TERMINAL', 'KITTY_WINDOW_ID',
    'WEZTERM_PANE', 'GHOSTTY_RESOURCES_DIR', 'ALACRITTY_WINDOW_ID', 'VTE_VERSION', 'NODE_CHANNEL_FD', 'NODE_UNIQUE_ID', 'WT_SESSION']) {
    assert.equal(env[k], undefined, `${k} must be stripped`);
  }
  assert.equal(env.TERM_PROGRAM, 'SynaBun');
  assert.equal(env.TERM_PROGRAM_VERSION, '2026.9.8');
  assert.equal(env.COLORTERM, 'truecolor');
  assert.equal(env.LANG, 'pt_BR.UTF-8', 'an existing locale is kept');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/Users/x');
});

test('terminal env layering: profile env and loop extraEnv win; locale fallback only when missing', () => {
  const env = buildTerminalEnv({
    base: { PATH: '/bin', COLORTERM: '24bit' },
    profileEnv: { FORCE_COLOR: '1', TERM: 'xterm-256color' },
    extraEnv: { SYNABUN_TERMINAL_SESSION: 'abc', COLORTERM: 'override' },
    platform: 'darwin',
    version: '',
  });
  assert.equal(env.FORCE_COLOR, '1');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.SYNABUN_TERMINAL_SESSION, 'abc');
  assert.equal(env.COLORTERM, 'override', 'extraEnv is the last layer');
  assert.equal(env.LANG, 'en_US.UTF-8', 'UTF-8 locale when none is set');
  assert.equal(env.TERM_PROGRAM_VERSION, undefined, 'no version → no TERM_PROGRAM_VERSION');

  const withCtype = buildTerminalEnv({ base: { LC_CTYPE: 'UTF-8' }, platform: 'darwin' });
  assert.equal(withCtype.LANG, undefined, 'LC_CTYPE already provides the charset');
  const win = buildTerminalEnv({ base: {}, platform: 'win32' });
  assert.equal(win.LANG, undefined, 'no POSIX locale on Windows');
  assert.equal(win.TERM_PROGRAM, 'SynaBun');
});

test('shell arguments: login shells like a native terminal; tcsh keeps plain -c; Windows unchanged', () => {
  assert.deepEqual(interactiveShellArgs('darwin'), ['-l']);
  assert.deepEqual(interactiveShellArgs('linux'), ['-l']);
  assert.deepEqual(interactiveShellArgs('win32'), []);

  assert.deepEqual(cliWrapperArgs('/bin/zsh', 'claude', 'darwin'), ['-lc', 'claude; exec $SHELL -l']);
  assert.deepEqual(cliWrapperArgs('/opt/homebrew/bin/fish', 'codex', 'darwin'), ['-lc', 'codex; exec $SHELL -l']);
  assert.deepEqual(cliWrapperArgs('/bin/tcsh', 'gemini', 'darwin'), ['-c', 'gemini; exec $SHELL']);
  assert.deepEqual(cliWrapperArgs('C:\\Windows\\System32\\cmd.exe', 'claude', 'win32'), ['/k', 'claude']);

  assert.equal(shellSupportsLoginCommand('/bin/bash'), true);
  assert.equal(shellSupportsLoginCommand('/bin/csh'), false);
  assert.equal(isStrippedTerminalVar('VSCODE_ANYTHING'), true);
  assert.equal(isStrippedTerminalVar('PATH'), false);
});

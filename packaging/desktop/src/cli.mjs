/**
 * The window executable is not a command line tool: MCP clients, Claude Code
 * hooks and diagnostics run the headless entry (synabun-cli), which every
 * registration names. A registration written by an older build, before the
 * window existed, named the executable that is now the window
 * (SynaBun.app/Contents/MacOS/SynaBun, SynaBun.exe). Such a call is handed to
 * the headless entry with its arguments and stdio untouched, and the window
 * never opens; the repair sweep rewrites the registration at the next start.
 */

/** The first words the headless entry and its bootstrap answer to. */
export const CLI_MODES = Object.freeze([
  'mcp', 'claude-hook', 'diagnostics', 'start', 'launcher', 'background-server', 'app-backend',
  'version', '--version', '-v', 'doctor', 'profile', 'migrate-data', 'restore-backup', 'help', '--help', '-h',
]);

/**
 * The arguments to give the headless entry, or null for a start of the window.
 * `argv` is process.argv; a packaged app has no script argument, a run from
 * source (`electron <dir>`) has one. Chromium switches before the mode
 * (`--no-sandbox`, `--enable-logging`) and the old macOS `-psn_` argument are
 * not a mode; everything from the mode on is passed through as it is.
 */
export function cliInvocation(argv = process.argv, { packaged = true } = {}) {
  const args = argv.slice(packaged ? 1 : 2);
  let index = 0;
  while (index < args.length && (/^-psn_/.test(args[index]) || (/^--/.test(args[index]) && !CLI_MODES.includes(args[index])))) index++;
  if (index >= args.length) return null;
  return CLI_MODES.includes(args[index]) ? { args: args.slice(index) } : null;
}

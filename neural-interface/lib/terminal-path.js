// User-facing terminals start from today's OS environment, not the runtime's
// private Node/npm PATH. Shared by every PTY spawn and PATH diagnostics.
import path from 'node:path';
import { pathEnvValue, withPathEnv } from './augmented-path.js';
import { dedupePath, expandWindowsVars, splitPathValue } from './os-path.js';
import { cmdEscapeArgument, cmdEscapeCommand, spawnArgsFor } from './cli-resolver.js';

// synabunDirs: the packaged runtime, always last and never earlier. extraDirs:
// the global bin of the npm that came with it, added before them when nothing
// of the user's has put it on PATH already (then it stays where the user has it).
export function composeTerminalPath({ env = process.env, platform = process.platform, os = {}, launchers = [], synabunDirs = [], extraDirs = [] } = {}) {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  const normalize = dir => platform === 'win32' ? dir.replace(/\//g, '\\').toLowerCase().replace(/[\\/]+$/, '') : dir.replace(/\/+$/, '') || '/';
  const privateDirs = new Set(synabunDirs.filter(Boolean).map(normalize));
  const entries = [];
  const seen = new Set();
  const add = (dir, source) => {
    if (platform === 'win32') dir = expandWindowsVars(dir, env);
    const key = normalize(dir);
    if (!dir || seen.has(key) || (source !== 'SynaBun' && privateDirs.has(key))) return;
    seen.add(key); entries.push({ dir, source });
  };
  for (const dir of os.entries || []) add(dir, os.sources?.find(entry => normalize(entry.dir) === normalize(dir))?.source || 'login-shell');
  for (const found of launchers) if (found.path) add(impl.dirname(found.path), 'CLI folder');
  // An unavailable OS reader falls back to the inherited environment. Never
  // let packaged runtime folders lead user tools, even in this fallback.
  if (!os.entries?.length) for (const dir of splitPathValue(pathEnvValue(env), platform)) add(dir, 'inherited');
  for (const dir of extraDirs) if (dir) add(dir, 'npm global');
  for (const dir of synabunDirs) if (dir) add(dir, 'SynaBun');
  const value = dedupePath(entries.map(entry => entry.dir), platform).join(platform === 'win32' ? ';' : ':');
  return { env: withPathEnv(env, value, platform), entries, value };
}

const posixQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

export function terminalArgument(value, shell, platform = process.platform) {
  const name = path.win32.basename(shell).replace(/\.exe$/i, '').toLowerCase();
  if (platform !== 'win32' || ['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh'].includes(name)) return posixQuote(value);
  if (name === 'powershell' || name === 'pwsh') return `'${String(value).replace(/'/g, "''")}'`;
  return cmdEscapeArgument(value, false);
}

/** Render a resolver-owned absolute launch spec for the selected shell. */
export function terminalLaunchCommand(found, shell, { platform = process.platform, env = process.env, execPath = process.execPath } = {}) {
  if (!found?.spec) return null;
  const launch = spawnArgsFor(found.spec, [], { env, execPath });
  const words = [launch.command, ...launch.args];
  const name = path.win32.basename(shell).replace(/\.exe$/i, '').toLowerCase();
  if (platform !== 'win32' || ['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh'].includes(name)) return words.map(posixQuote).join(' ');
  if (/(?:powershell|pwsh)(?:\.exe)?$/i.test(shell)) return `& ${words.map(word => `'${String(word).replace(/'/g, "''")}'`).join(' ')}`;
  // cmd shims already have their inner escaping from spawnArgsFor. Keep that
  // command intact; native executables use the same escaping as the resolver.
  if (found.spec.kind === 'cmd') return `${cmdEscapeCommand(launch.command)} /d /s /c ${launch.args.at(-1)}`;
  return [cmdEscapeCommand(launch.command), ...launch.args.map(word => cmdEscapeArgument(word, false))].join(' ');
}

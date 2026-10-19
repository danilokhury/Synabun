// PATH augmented with the directories CLIs actually install into.
//
// SynaBun is frequently launched from Finder/launchd or the Start menu rather
// than a login shell, and that process inherits a minimal or an old PATH: no
// ~/.local/bin, no Homebrew, nothing an installer added after it started. Any
// `which claude` / bare-command spawn under that PATH fails even though the
// CLI is installed, so every lookup and spawn that needs to find a
// user-installed binary goes through here first.
//
// The PATH, in this order:
//   1. the PATH this process was given
//   2. the OS PATH as a new terminal would have it now (os-path.js reads it:
//      the registry on Windows, the login shell on macOS and Linux) and hands
//      it in through rememberOsPath()
//   3. the folders each install method uses on this system (knownInstallDirs),
//      for a CLI that no PATH names at all
// Folders that do not exist are left out of 2 and 3.
//
// Shared by lib/cli-resolver.js (where a CLI is), the model catalog (discovery
// spawns the CLI by name too, and without this a daemon-started server
// silently degrades to the static fallback model list) and every spawn that
// passes PATH on to a child.
//
// SYNABUN_TOOL_DISCOVERY=path turns 2 and 3 off: the tools are then looked
// for on the PATH this process was given and nowhere else. It is what a check
// of "nothing is installed" needs on a machine where something is (the
// packaged application's own run), and what a user sets to make SynaBun see
// exactly their PATH.
//
// A packaged application (packaging/) also hands in its own folders through
// rememberPackagedPath(): the Node runtime that came with it and the global
// bin of the npm that came with it. They go LAST, after everything of the
// user's, in every PATH built here (and in withPackagedPathLast for an env
// built elsewhere): the user's own Node and npm stay first, SynaBun's are the
// fallback on a machine that has none. The order itself is lib/child-path.js
// packagedPathLast, the one the packaged entry points use too.
//
// Only node: modules and lib/child-path.js (itself node: only) here: tests
// copy these files into a scratch tree.

import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  packagedPathLast as orderPackagedPath, parseNpmrc, pathEnvValue, resolveNpmPrefix, withPathEnv,
} from '../../lib/child-path.js';

export { pathEnvValue, withPathEnv };

const MEMO_MS = 5_000;

let _osPath = [];
let _memo = null; // { key, at, value }
let _packaged = { last: [], extra: [], npmBin: null };

/** The OS PATH a new terminal would get, as os-path.js last read it. */
export function rememberOsPath(entries) {
  _osPath = Array.isArray(entries) ? entries.map(entry => String(entry || '').trim()).filter(Boolean) : [];
  _memo = null;
}

export function rememberedOsPath() {
  return _osPath.slice();
}

/** Drop the few seconds of memory getAugmentedPath keeps: a folder an installer just made counts at once. */
export function forgetAugmentedPath() {
  _memo = null;
}

/**
 * A packaged application's own folders: `last`, the runtime it runs on (moved
 * to the end of every PATH, wherever it was), and `extra`, the global bin of
 * the npm that came with it (added before them when the PATH lacks it; where
 * the user already has it, it stays). `npmBin`, when given, is asked for that
 * bin each time (lib/packaged-runtime.js packagedNpmGlobalBin: the prefix as
 * npm settles it, cached for seconds), so a prefix the user sets later counts
 * without a restart. Called once at start; nothing for an npm or Git install.
 */
export function rememberPackagedPath({ last = [], extra = [], npmBin = null } = {}) {
  const clean = (list) => (Array.isArray(list) ? list : []).map(entry => String(entry || '').trim()).filter(Boolean);
  _packaged = { last: clean(last), extra: clean(extra), npmBin: typeof npmBin === 'function' ? npmBin : null };
  _memo = null;
}

/** The packaged folders as they are now: { last, extra } (extra with npmBin's answer after the fixed ones). */
export function rememberedPackagedPath() {
  let asked = null;
  if (_packaged.npmBin) { try { asked = _packaged.npmBin(); } catch { asked = null; } }
  const extra = _packaged.extra.slice();
  if (typeof asked === 'string' && asked.trim() && !extra.includes(asked.trim())) extra.push(asked.trim());
  return { last: _packaged.last.slice(), extra };
}

/**
 * PATH `value` with a packaged application's folders after the user's
 * (lib/child-path.js packagedPathLast; the remembered folders by default).
 */
export function packagedPathLast(value, { platform = process.platform, ...folders } = {}) {
  const { last, extra } = 'last' in folders || 'extra' in folders ? { last: folders.last || [], extra: folders.extra || [] } : rememberedPackagedPath();
  return orderPackagedPath(value, { platform, last, extra });
}

/** `env` with packagedPathLast applied to its PATH (one PATH key kept, as withPathEnv does). No packaged folders: `env` as it is. */
export function withPackagedPathLast(env = process.env, { platform = process.platform, ...folders } = {}) {
  const { last, extra } = 'last' in folders || 'extra' in folders ? { last: folders.last || [], extra: folders.extra || [] } : rememberedPackagedPath();
  if (!last.length && !extra.length) return env;
  return withPathEnv(env, orderPackagedPath(pathEnvValue(env), { platform, last, extra }), platform);
}

function pathImplFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function homeOf(env, platform) {
  if (platform === 'win32') return env.USERPROFILE || env.HOME || os.homedir();
  return env.HOME || os.homedir();
}

function expandHome(value, home, pathImpl) {
  const text = String(value || '').trim();
  if (text === '~') return home;
  if (text.startsWith('~/') || text.startsWith('~\\')) return pathImpl.join(home, text.slice(2));
  return text;
}

/** The value of `prefix=` in an .npmrc as npm's ini reader gives it (lib/child-path.js parseNpmrc), or ''. */
export function npmrcPrefix(text) {
  const value = parseNpmrc(text).prefix;
  return typeof value === 'string' ? value : '';
}

/**
 * npm's global prefix as the user set it (lib/child-path.js resolveNpmPrefix
 * without a builtin npmrc: npm_config_prefix, the user's config file named by
 * npm_config_userconfig or ~/.npmrc, the global config file it names), with
 * npm's ${VAR} substitution and `~/`: an absolute folder, or '' when the user
 * set none.
 */
export function npmGlobalPrefix({ platform = process.platform, env = process.env, home, readFile = readFileSync } = {}) {
  return resolveNpmPrefix({ platform, env, readFile, ...(home ? { home } : {}) }).prefix || '';
}

/** Version folders newest first ("v22.11.0" before "v20.18.1"); names that are not versions last. */
export function newestVersionsFirst(names) {
  const parse = (name) => {
    const match = String(name).match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1, 4).map(Number) : null;
  };
  return [...names].sort((a, b) => {
    const va = parse(a);
    const vb = parse(b);
    if (!va || !vb) return va ? -1 : vb ? 1 : String(a).localeCompare(String(b));
    for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return vb[i] - va[i];
    return 0;
  });
}

function listDir(readdir, dir) {
  try { return readdir(dir).map(String).slice(0, 200); } catch { return []; }
}

/**
 * Every folder an install method puts its commands in on this system, most
 * specific first. Folders are listed whether or not they exist: the caller
 * checks (getAugmentedPath, the resolver's candidates). `via` names the
 * method, for diagnostics.
 *
 *   native installers   ~/.local/bin (Claude Code, Codex's standalone
 *                       installer, pipx), $XDG_BIN_HOME / $XDG_BIN_DIR, ~/bin
 *   Homebrew            /opt/homebrew, /usr/local, Linuxbrew
 *   npm                 the configured prefix, ~/.npm-global, ~/.npm-packages;
 *                       on Windows %APPDATA%\npm and the Node.js folder
 *   Node managers       nvm, nvm-windows, fnm, Volta
 *   package managers    bun, pnpm, yarn, Scoop, Chocolatey, WinGet, snap
 *   version managers    asdf and mise shims
 *   cargo, the system   ~/.cargo/bin, /usr/local/bin, /usr/bin, MacPorts
 *
 * Tool-specific places (~/.opencode/bin, ~/.claude/local, the Codex installer's
 * folders, WinGet's package folders) are the resolver's (cli-resolver.js).
 */
export function knownInstallDirs({
  platform = process.platform,
  env = process.env,
  home = homeOf(env, platform),
  readdir = readdirSync,
  readFile = readFileSync,
} = {}) {
  const pathImpl = pathImplFor(platform);
  const join = (...parts) => pathImpl.join(...parts);
  const out = [];
  const add = (dir, via) => { if (dir) out.push({ dir: String(dir), via }); };
  // npm's own home rule (HOME, else the account's) for its config files.
  const npmPrefix = npmGlobalPrefix({ platform, env, home: env.HOME || home, readFile });

  if (platform === 'win32') {
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
    const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const programData = env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData';
    const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
    add(join(home, '.local', 'bin'), 'native');
    // npm keeps global commands in the prefix itself on Windows (no bin\).
    if (npmPrefix) add(npmPrefix, 'npm');
    add(join(appData, 'npm'), 'npm');
    if (env.NVM_SYMLINK) add(env.NVM_SYMLINK, 'nvm');
    if (env.NVM_HOME) for (const name of newestVersionsFirst(listDir(readdir, env.NVM_HOME).filter(n => /^v\d/.test(n)))) add(join(env.NVM_HOME, name), 'nvm');
    add(join(programFiles, 'nodejs'), 'npm');
    const fnmDir = env.FNM_DIR || join(appData, 'fnm');
    add(join(fnmDir, 'aliases', 'default'), 'fnm');
    for (const name of newestVersionsFirst(listDir(readdir, join(fnmDir, 'node-versions')))) add(join(fnmDir, 'node-versions', name, 'installation'), 'fnm');
    if (env.VOLTA_HOME) add(join(env.VOLTA_HOME, 'bin'), 'volta');
    add(join(localAppData, 'Volta', 'bin'), 'volta');
    if (env.PNPM_HOME) add(env.PNPM_HOME, 'pnpm');
    add(join(localAppData, 'pnpm'), 'pnpm');
    if (env.BUN_INSTALL) add(join(env.BUN_INSTALL, 'bin'), 'bun');
    add(join(home, '.bun', 'bin'), 'bun');
    add(join(localAppData, 'Yarn', 'bin'), 'yarn');
    if (env.SCOOP) add(join(env.SCOOP, 'shims'), 'scoop');
    add(join(home, 'scoop', 'shims'), 'scoop');
    if (env.SCOOP_GLOBAL) add(join(env.SCOOP_GLOBAL, 'shims'), 'scoop');
    add(join(programData, 'scoop', 'shims'), 'scoop');
    if (env.ChocolateyInstall) add(join(env.ChocolateyInstall, 'bin'), 'choco');
    add(join(programData, 'chocolatey', 'bin'), 'choco');
    add(join(localAppData, 'Microsoft', 'WinGet', 'Links'), 'winget');
    add(join(programFiles, 'WinGet', 'Links'), 'winget');
    add(join(localAppData, 'mise', 'shims'), 'mise');
    if (env.CARGO_HOME) add(join(env.CARGO_HOME, 'bin'), 'cargo');
    add(join(home, '.cargo', 'bin'), 'cargo');
    return dedupeDirs(out, platform);
  }

  const darwin = platform === 'darwin';
  const xdgData = env.XDG_DATA_HOME || join(home, '.local', 'share');
  add(join(home, '.local', 'bin'), 'native');
  if (env.XDG_BIN_HOME) add(expandHome(env.XDG_BIN_HOME, home, pathImpl), 'native');
  if (env.XDG_BIN_DIR) add(expandHome(env.XDG_BIN_DIR, home, pathImpl), 'native');
  add(join(home, 'bin'), 'native');
  if (env.HOMEBREW_PREFIX) add(join(env.HOMEBREW_PREFIX, 'bin'), 'brew');
  if (darwin) add('/opt/homebrew/bin', 'brew');
  add('/usr/local/bin', darwin ? 'brew' : 'system');
  if (!darwin) {
    add('/home/linuxbrew/.linuxbrew/bin', 'brew');
    add(join(home, '.linuxbrew', 'bin'), 'brew');
  }
  if (npmPrefix) add(join(npmPrefix, 'bin'), 'npm');
  add(join(home, '.npm-global', 'bin'), 'npm');
  add(join(home, '.npm-packages', 'bin'), 'npm');
  if (env.BUN_INSTALL) add(join(env.BUN_INSTALL, 'bin'), 'bun');
  add(join(home, '.bun', 'bin'), 'bun');
  if (env.PNPM_HOME) add(env.PNPM_HOME, 'pnpm');
  add(darwin ? join(home, 'Library', 'pnpm') : join(xdgData, 'pnpm'), 'pnpm');
  add(join(home, '.yarn', 'bin'), 'yarn');
  if (env.VOLTA_HOME) add(join(env.VOLTA_HOME, 'bin'), 'volta');
  add(join(home, '.volta', 'bin'), 'volta');
  // nvm: the default alias first, then every installed Node, newest first.
  const nvmDir = env.NVM_DIR || join(home, '.nvm');
  const nvmVersions = join(nvmDir, 'versions', 'node');
  let nvmDefault = '';
  try { nvmDefault = String(readFile(join(nvmDir, 'alias', 'default'), 'utf8')).trim(); } catch {}
  const nvmInstalled = newestVersionsFirst(listDir(readdir, nvmVersions));
  const nvmPick = nvmDefault ? nvmInstalled.find(name => name === nvmDefault || name === `v${nvmDefault}` || name.startsWith(`v${nvmDefault.replace(/^v/, '')}.`)) : null;
  for (const name of nvmPick ? [nvmPick, ...nvmInstalled.filter(n => n !== nvmPick)] : nvmInstalled) add(join(nvmVersions, name, 'bin'), 'nvm');
  // fnm keeps its Node versions in its own data folder.
  const fnmDirs = env.FNM_DIR ? [env.FNM_DIR] : [darwin ? join(home, 'Library', 'Application Support', 'fnm') : join(xdgData, 'fnm'), join(home, '.fnm')];
  for (const fnmDir of fnmDirs) {
    add(join(fnmDir, 'aliases', 'default', 'bin'), 'fnm');
    for (const name of newestVersionsFirst(listDir(readdir, join(fnmDir, 'node-versions')))) add(join(fnmDir, 'node-versions', name, 'installation', 'bin'), 'fnm');
  }
  add(join(env.ASDF_DATA_DIR || join(home, '.asdf'), 'shims'), 'asdf');
  add(join(env.MISE_DATA_DIR || join(xdgData, 'mise'), 'shims'), 'mise');
  add(join(env.CARGO_HOME || join(home, '.cargo'), 'bin'), 'cargo');
  if (!darwin) add('/snap/bin', 'snap');
  if (darwin) add('/opt/local/bin', 'macports');
  add('/usr/bin', 'system');
  return dedupeDirs(out, platform);
}

function dedupeDirs(list, platform) {
  const seen = new Set();
  return list.filter(({ dir }) => {
    const key = platform === 'win32' ? dir.toLowerCase().replace(/[\\/]+$/, '') : dir.replace(/\/+$/, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The PATH every lookup and spawn of a user's CLI uses: this process's PATH,
 * then the OS PATH a new terminal would have, then the known install folders
 * (each existing folder once). Options are for tests; called bare it describes
 * this process.
 */
export function getAugmentedPath({
  platform = process.platform,
  env = process.env,
  osPath = _osPath,
  exists = existsSync,
  readdir = readdirSync,
  readFile = readFileSync,
  // On Windows the folder of the Node running SynaBun comes last: an npm
  // command file (claude.cmd) starts `node` from PATH when no node.exe lies
  // beside it.
  nodeDir = platform === 'win32' && platform === process.platform ? path.win32.dirname(process.execPath) : '',
  // A packaged application's own folders (rememberPackagedPath, as they are now): after everything of the user's.
  packaged,
} = {}) {
  const folders = packaged || rememberedPackagedPath();
  const ordered = (value) => (folders.last.length || folders.extra.length ? orderPackagedPath(value, { platform, last: folders.last, extra: folders.extra }) : value);
  if (env.SYNABUN_TOOL_DISCOVERY === 'path') return ordered(pathEnvValue(env));
  const inherited = pathEnvValue(env);
  const live = env === process.env && platform === process.platform && exists === existsSync && !packaged;
  const memoKey = live ? `${inherited}\0${osPath.join('\0')}\0${folders.last.join('\0')}\0${folders.extra.join('\0')}` : null;
  if (memoKey && _memo && _memo.key === memoKey && Date.now() - _memo.at < MEMO_MS) return _memo.value;

  const delimiter = platform === 'win32' ? ';' : ':';
  const known = knownInstallDirs({ platform, env, readdir, readFile }).map(({ dir }) => dir);
  const entries = [
    ...inherited.split(delimiter),
    ...osPath.filter(dir => dir && exists(dir)),
    ...known.filter(dir => exists(dir)),
    nodeDir,
  ];
  const seen = new Set();
  const value = ordered(entries.filter((entry) => {
    if (!entry) return false;
    const id = platform === 'win32' ? entry.toLowerCase().replace(/[\\/]+$/, '') : entry;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).join(delimiter));
  if (memoKey) _memo = { key: memoKey, at: Date.now(), value };
  return value;
}

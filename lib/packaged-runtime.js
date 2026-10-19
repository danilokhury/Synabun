/**
 * SynaBun — packaged application runtime
 *
 * A packaged build (packaging/) ships this package next to its own Node
 * runtime, behind one native entry executable:
 *
 *   <resources>/synabun-package.json   written by the builder: what was built
 *   <resources>/runtime/               the Node that runs everything
 *   <resources>/app/                   this package (PACKAGE_ROOT)
 *
 * This module answers one question for the rest of the code: is this that kind
 * of install, and if so, what should the outside world run? An npm or Git
 * install has no manifest next to its package root; every function here then
 * says so and nothing changes for it.
 */

import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import {
  bundledNpmrcPath, effectiveNpmPrefix, npmGlobalBinFor, packagedPathLast, pathEnvValue, resolveNpmPrefix, withPathEnv,
} from './child-path.js';
import { PACKAGE_ROOT } from './paths.js';

export { npmGlobalBinFor };

export const PACKAGE_MANIFEST = 'synabun-package.json';

/**
 * Set by the native entry: where it lives for the outside world. For an
 * AppImage that is the image file, never the mount it is running from.
 */
export const PACKAGED_ENTRY_ENV = 'SYNABUN_PACKAGED_ENTRY';

/**
 * What the builder recorded about this install, or null when the package is
 * not inside a packaged application. Never throws.
 */
export function readPackagedRuntime({ packageRoot = PACKAGE_ROOT, env = process.env } = {}) {
  const root = resolve(packageRoot);
  const resources = dirname(root);
  const manifestPath = join(resources, PACKAGE_MANIFEST);
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return null; }
  // A manifest that does not describe this directory is somebody else's.
  if (!manifest || manifest.synabunPackage !== 1 || basename(root) !== (manifest.app || 'app')) return null;

  const recorded = typeof manifest.entry === 'string' && manifest.entry ? resolve(resources, manifest.entry) : null;
  const entry = [env[PACKAGED_ENTRY_ENV], recorded]
    .find(candidate => typeof candidate === 'string' && isAbsolute(candidate) && existsSync(candidate)) || null;

  return Object.freeze({
    resources,
    packageRoot: root,
    manifestPath,
    version: String(manifest.version || ''),
    target: String(manifest.target?.id || ''),
    platform: String(manifest.target?.platform || ''),
    arch: String(manifest.target?.arch || ''),
    artifact: manifest.artifact ? String(manifest.artifact) : null,
    entry,
    runtimeBin: resolve(resources, String(manifest.runtime?.bin || 'runtime/bin')),
    // The desktop app's window around this payload ('electron'), or null for a build without one.
    shell: manifest.shell?.kind ? String(manifest.shell.kind) : null,
  });
}

let cached;

/** readPackagedRuntime() for this process, read once. */
export function packagedRuntime() {
  if (cached === undefined) cached = readPackagedRuntime();
  return cached;
}

/**
 * Whether a path only lasts as long as this run: macOS starts a quarantined
 * copy from a random AppTranslocation folder, and an AppImage runs from a
 * mount that is gone when it exits. Nothing that outlives the process (a hook
 * command, a line a person is told to type) may point at such a path.
 */
export function isTransientPath(path, env = process.env) {
  const value = String(path || '').replace(/\\/g, '/');
  if (!value) return false;
  if (/\/AppTranslocation\//.test(value) || /\/\.mount_[^/]+\//.test(value)) return true;
  const mount = String(env.APPDIR || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return Boolean(mount) && value.startsWith(`${mount}/`);
}

const volumeWritable = (folder) => {
  try { accessSync(folder, constants.W_OK); return true; } catch { return false; }
};

/**
 * macOS: a copy started from the disk image it came in. The image is a
 * read-only volume under /Volumes, gone once it is ejected; an external drive
 * someone keeps applications on is writable, and counts as a place.
 */
export function isReadOnlyVolumePath(path, { platform = process.platform, writable = volumeWritable } = {}) {
  if (platform !== 'darwin') return false;
  const volume = /^\/Volumes\/[^/]+\//.exec(String(path || ''));
  return !!volume && !writable(volume[0]);
}

/** The entry executable when it outlives this run, otherwise null. */
export function durableEntry(runtime = packagedRuntime(), env = process.env, { platform = process.platform, writable } = {}) {
  const entry = runtime?.entry || null;
  return entry && !isTransientPath(entry, env) && !isReadOnlyVolumePath(entry, { platform, writable }) ? entry : null;
}

/**
 * The command an MCP client runs for SynaBun's stdio server. A packaged
 * application answers through its entry executable (`<entry> mcp`): the client
 * has no Node of its own to find, and the entry's path outlives an update that
 * moves the files behind it.
 */
export function mcpStdioCommand(scriptPath, { packageRoot = PACKAGE_ROOT, env = process.env, runtime } = {}) {
  const found = runtime === undefined ? readPackagedRuntime({ packageRoot, env }) : runtime;
  if (found?.entry) return { command: found.entry.replace(/\\/g, '/'), args: ['mcp'] };
  return { command: 'node', args: [scriptPath] };
}

/**
 * The global prefix of the npm that comes with the packaged runtime, as npm
 * reads it from that npm's own settings file (its builtin npmrc, which the
 * build writes: packaging/lib/bundle.mjs). `npm i -g` through it lands in a
 * per-user folder SynaBun owns, never inside the application: that folder is
 * read-only, replaced by every update and, on macOS, signed. A prefix the
 * user set (npm_config_prefix, `prefix=` in their config file or the global
 * one) comes before this file for npm, so the user's own stays in charge. The folder is in the data home's
 * runtime/ (outside every backup and data-home move), where the default data
 * home is: npm expands `~/` with HOME and `${APPDATA}` from the environment.
 */
export const BUNDLED_NPM_PREFIX = Object.freeze({
  win32: '${APPDATA}\\synabun\\runtime\\npm-global',
  posix: '~/.synabun/runtime/npm-global',
});

/** The builtin npmrc of the npm a packaged build ships for `platform` (the whole file). */
export function bundledNpmrc(platform) {
  return `prefix=${platform === 'win32' ? BUNDLED_NPM_PREFIX.win32 : BUNDLED_NPM_PREFIX.posix}\n`;
}

/**
 * The folder BUNDLED_NPM_PREFIX names on this machine, the way npm expands it
 * (HOME first, then the account's home; APPDATA on Windows), or null when it
 * names none (no APPDATA).
 */
export function defaultBundledNpmPrefix({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'win32') return env.APPDATA ? win32.join(env.APPDATA, 'synabun', 'runtime', 'npm-global') : null;
  const base = env.HOME || home;
  return base ? posix.join(base, '.synabun', 'runtime', 'npm-global') : null;
}

/**
 * Where `npm i -g` through the npm of a packaged build puts packages: npm's
 * own settings over the builtin npmrc the build wrote (lib/child-path.js
 * resolveNpmPrefix: npm_config_prefix, the user's config file, the global
 * one, then that builtin file), else, when that file cannot be read, the
 * folder BUNDLED_NPM_PREFIX names. { prefix, bin, source, from }, or null
 * without a runtime (an npm or Git install). Cached for seconds when asked
 * about this process (the options are for tests).
 */
export function packagedNpmPrefix(runtime = packagedRuntime(), { env = process.env, readFile, home, cwd } = {}) {
  if (!runtime) return null;
  const platform = runtime.platform || process.platform;
  const builtin = bundledNpmrcPath(runtime.runtimeBin, platform);
  const injected = readFile || home || cwd || env !== process.env || platform !== process.platform;
  const found = injected
    ? resolveNpmPrefix({ env, platform, builtin, ...(readFile ? { readFile } : {}), ...(home ? { home } : {}), ...(cwd ? { cwd } : {}) })
    : effectiveNpmPrefix({ builtin });
  if (found.prefix) return { prefix: found.prefix, bin: found.bin, source: found.source, from: found.from };
  const fallback = defaultBundledNpmPrefix({ platform, env, ...(home ? { home } : {}) });
  return fallback ? { prefix: fallback, bin: npmGlobalBinFor(fallback, platform), source: 'builtin', from: builtin } : { prefix: null, bin: null, source: null, from: null };
}

const insideFolder = (file, folder, platform) => {
  if (!file || !folder) return false;
  const impl = platform === 'win32' ? win32 : posix;
  const id = (value) => (platform === 'win32' ? impl.resolve(value).toLowerCase() : impl.resolve(value));
  const [a, b] = [id(file), id(folder)];
  return a === b || a.startsWith(b.endsWith(impl.sep) ? b : b + impl.sep);
};

/**
 * A packaged build's own folders on the PATH of what it starts
 * (lib/child-path.js packagedPathLast): `last`, its runtime (and the folder of
 * the Node this process runs on when that is the packaged one), and `extra`,
 * npm's global bin (packagedNpmPrefix). Nothing without a runtime.
 */
export function packagedPathFolders(runtime = packagedRuntime(), { env = process.env, execPath = process.execPath, ...options } = {}) {
  if (!runtime) return { last: [], extra: [] };
  const platform = runtime.platform || process.platform;
  const impl = platform === 'win32' ? win32 : posix;
  const last = [runtime.runtimeBin];
  if (insideFolder(execPath, runtime.resources, platform)) {
    const own = impl.dirname(execPath);
    if (!last.some(entry => (platform === 'win32' ? entry.toLowerCase() === own.toLowerCase() : entry === own))) last.push(own);
  }
  const bin = packagedNpmPrefix(runtime, { env, ...options })?.bin;
  return { last, extra: bin ? [bin] : [] };
}

/**
 * `env` for a process a packaged build starts: PATH as the user's own, then
 * npm's global bin, then the packaged runtime last (lib/child-path.js). The
 * user's Node, npm and npx stay first; SynaBun's are the fallback on a machine
 * without any. SynaBun's own Node is never found through this PATH: the entry,
 * the bootstrap and the supervisor start it by its absolute path
 * (packaging/launcher/launcher.c, packaging/runtime/bootstrap.mjs, setup.js).
 * The same object when the order is already right; `env` itself without a runtime.
 */
export function packagedChildEnv(env = process.env, runtime = packagedRuntime(), options = {}) {
  if (!runtime) return env;
  const platform = runtime.platform || process.platform;
  const { last, extra } = packagedPathFolders(runtime, { env, ...options });
  const current = pathEnvValue(env);
  const value = packagedPathLast(current, { platform, last, extra });
  if (value === current && Object.keys(env).filter(name => name.toUpperCase() === 'PATH').length === 1) return env;
  return withPathEnv(env, value, platform);
}

/**
 * packagedChildEnv() on `target` itself (process.env by default), for an entry
 * point whose every child inherits its environment: the headless MCP server,
 * a hook handler. Whether anything changed.
 */
export function applyPackagedChildPath(target = process.env, runtime = packagedRuntime(), options = {}) {
  if (!runtime) return false;
  const ordered = packagedChildEnv(target, runtime, { env: target, ...options });
  if (ordered === target) return false;
  const keys = Object.keys(target).filter(name => name.toUpperCase() === 'PATH');
  const key = keys[0] || (runtime.platform === 'win32' ? 'Path' : 'PATH');
  for (const alias of keys) if (alias !== key) delete target[alias];
  target[key] = pathEnvValue(ordered);
  return true;
}

/**
 * SynaBun — are the runtime dependencies there?
 *
 * `npm i -g synabun` installs every dependency of both parts at the package
 * root (the root package.json names them, npm-shrinkwrap.json pins each
 * version: lib/root-dependencies.mjs derives both from the parts). A desktop
 * build and a development checkout keep them in each part's own node_modules
 * instead. Either way Node finds a part's dependency by walking up from the
 * part's folder, and so does this check: it reads package.json files, never
 * loads a dependency and installs nothing.
 *
 * When something is really missing (a checkout nobody ran `npm install` in, a
 * module a virus scanner removed), `installAtPackageRoot` is the one fallback
 * the launcher keeps: npm install at the package root, from the shrinkwrap,
 * install scripts off, npm's own output on the screen, and on a failure the
 * exit code, the signal and npm's debug log named.
 *
 * Only node: modules here: setup.js and postinstall.js import this before a
 * single dependency exists.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';

/** The two parts, each with its own package.json and node_modules resolution. */
export const RUNTIME_PARTS = Object.freeze([
  Object.freeze({ name: 'Neural Interface', folder: 'neural-interface' }),
  Object.freeze({ name: 'MCP Server', folder: 'mcp-server' }),
]);

/**
 * Dependencies the root lists as optional, and what goes without them. node-pty
 * has no prebuilt binary for Linux: npm compiles it there, and an install that
 * cannot compile it goes on without the terminal instead of failing whole.
 */
export const OPTIONAL_AT_ROOT = Object.freeze({
  'node-pty': 'the terminal is unavailable (Linux needs python3, make and a C++ compiler to build it)',
});

/** The longest a fallback install may take before it is stopped. */
export const INSTALL_TIMEOUT_MS = 20 * 60_000;

const readJson = (file, readFile) => JSON.parse(readFile(file, 'utf8'));

/**
 * Where Node would find `name` for code in `fromDir`: its node_modules, then
 * each folder above it, but never above `stopAt` (the package root: a global
 * install's neighbours are other packages, not SynaBun's). Returns
 * { path, version } or null; a package.json that cannot be read is
 * { path, version: null, broken: true }.
 */
export function findInstalled(fromDir, name, { stopAt = null, exists = existsSync, readFile = readFileSync } = {}) {
  const limit = stopAt ? resolve(stopAt) : null;
  let dir = resolve(fromDir);
  for (;;) {
    if (basename(dir) !== 'node_modules') {
      const manifest = join(dir, 'node_modules', ...name.split('/'), 'package.json');
      if (exists(manifest)) {
        try {
          return { path: dirname(manifest), version: readJson(manifest, readFile).version || null };
        } catch {
          return { path: dirname(manifest), version: null, broken: true };
        }
      }
    }
    if (limit && dir === limit) return null;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Every direct dependency of both parts, found or not:
 * { ok, parts: [{ name, folder, missing, optional, error }], missing: [{ part, name }] }.
 * `missing` are the ones SynaBun needs; `optional` the OPTIONAL_AT_ROOT ones
 * that are absent (a note, never a reason to install).
 */
export function checkRuntimeDependencies({ packageRoot, exists = existsSync, readFile = readFileSync } = {}) {
  const parts = RUNTIME_PARTS.map((part) => {
    const dir = join(packageRoot, part.folder);
    let manifest;
    try { manifest = readJson(join(dir, 'package.json'), readFile); } catch (error) {
      return { ...part, missing: [], optional: [], error: `${part.folder}/package.json cannot be read: ${error.message}` };
    }
    const missing = [];
    const optional = [];
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) {
      const found = findInstalled(dir, name, { stopAt: packageRoot, exists, readFile });
      if (found && !found.broken) continue;
      (Object.hasOwn(OPTIONAL_AT_ROOT, name) ? optional : missing).push(name);
    }
    return { ...part, missing, optional, error: null };
  });
  const missing = parts.flatMap(part => part.missing.map(name => ({ part: part.name, name })));
  return { ok: !missing.length && !parts.some(part => part.error), parts, missing };
}

/**
 * What kind of install `packageRoot` is: 'packaged' (a desktop application:
 * its files are read-only, nothing is installed into it), 'npm' (a package
 * npm installed, global or not) or 'source' (a checkout).
 */
export function installKind({ packageRoot, packaged = false } = {}) {
  if (packaged) return 'packaged';
  return basename(dirname(resolve(packageRoot))) === 'node_modules' ? 'npm' : 'source';
}

const realpathOr = (file) => { try { return realpathSync(file); } catch { return file; } };

/**
 * How to run npm: the npm that started us, else the user's own (the first npm
 * on PATH, as a terminal finds it), else the one next to the Node that runs
 * us. npm's own npm-cli.js is run by this Node, with no shell in between; a
 * PATH npm that is something else (a shim, a stand-in) is run as it is.
 */
export function npmInvocation({ execPath = process.execPath, env = process.env, platform = process.platform, exists = existsSync, realpath = realpathOr } = {}) {
  const viaNode = (cli) => ({ file: execPath, args: [resolve(cli)], shell: false });
  if (env.npm_execpath && /npm-cli\.js$/i.test(env.npm_execpath) && exists(env.npm_execpath)) return viaNode(env.npm_execpath);
  const windows = platform === 'win32';
  for (const dir of String(env.PATH || env.Path || '').split(windows ? ';' : ':').filter(Boolean)) {
    const file = join(dir, windows ? 'npm.cmd' : 'npm');
    if (!exists(file)) continue;
    const cli = windows ? join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js') : realpath(file);
    if (/npm-cli\.js$/i.test(cli) && exists(cli)) return viaNode(cli);
    return { file, args: [], shell: windows };
  }
  const bin = dirname(execPath);
  const bundled = windows ? join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js') : join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (exists(bundled)) return viaNode(bundled);
  return { file: windows ? 'npm.cmd' : 'npm', args: [], shell: windows };
}

/** The arguments of the fallback install: the shrinkwrap as it is, in the package itself, no lifecycle script, no progress bar. */
export function fallbackInstallArgs({ includeDev = false, logsDir = null } = {}) {
  return [
    'install',
    '--location=project',
    ...(includeDev ? [] : ['--omit=dev']),
    '--ignore-scripts', '--no-save', '--no-audit', '--no-fund', '--progress=false',
    ...(logsDir ? [`--logs-dir=${logsDir}`] : []),
  ];
}

/**
 * The environment of that npm, without the settings an npm that started us
 * hands its scripts: inside `npm i -g` (npm_config_global=true) an
 * `npm install` installs the folder as a global package of its own, a link
 * next to SynaBun, which is what 2.0.7's postinstall did.
 */
export function fallbackInstallEnv(env = process.env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) if (/^npm_config_(?:global|location|prefix)$/i.test(key)) delete clean[key];
  return clean;
}

/** The newest npm debug log written in `logsDir` since `since` (ms), or null. */
export function newestDebugLog(logsDir, since = 0) {
  if (!logsDir) return null;
  let newest = null;
  try {
    for (const name of readdirSync(logsDir)) {
      if (!/-debug(?:-\d+)?\.log$/.test(name)) continue;
      const file = join(logsDir, name);
      const { mtimeMs } = statSync(file);
      if (mtimeMs >= since - 1000 && (!newest || mtimeMs > newest.mtimeMs)) newest = { file, mtimeMs };
    }
  } catch {}
  return newest?.file || null;
}

const quoteForCmd = (arg) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);

/**
 * What to hand spawn/execFile for `npm <args>`: { file, args, shell }. Through
 * cmd.exe (a Windows npm.cmd that is not npm's own) every word is quoted where
 * it needs it, since cmd.exe reads one joined command line.
 */
export function npmCommand(npm, args) {
  if (!npm.shell) return { file: npm.file, args: [...npm.args, ...args], shell: false };
  return { file: quoteForCmd(npm.file), args: [...npm.args, ...args].map(quoteForCmd), shell: true };
}

/**
 * npm install at the package root, its output on this process's terminal.
 * Returns { ok, command, cwd, status, signal, error, timedOut, seconds, logFile }.
 */
export function installAtPackageRoot({
  packageRoot, includeDev = false, logsDir = null, env = process.env, npm = npmInvocation({ env }),
  spawn = spawnSync, timeoutMs = INSTALL_TIMEOUT_MS,
} = {}) {
  if (logsDir) { try { mkdirSync(logsDir, { recursive: true }); } catch {} }
  const args = fallbackInstallArgs({ includeDev, logsDir });
  const startedAt = Date.now();
  const command = npmCommand(npm, args);
  const result = spawn(command.file, command.args, {
    cwd: packageRoot, env: fallbackInstallEnv(env), stdio: 'inherit', shell: command.shell, windowsHide: true, timeout: timeoutMs,
  });
  return {
    ok: !result.error && result.status === 0,
    command: `npm ${args.join(' ')}`,
    cwd: packageRoot,
    status: result.status ?? null,
    signal: result.signal || null,
    error: result.error ? (result.error.code || result.error.message) : null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    logFile: newestDebugLog(logsDir, startedAt),
  };
}

/**
 * The TypeScript compiler that builds the MCP server, found the way Node finds
 * a dependency of mcp-server (its own node_modules in a development checkout,
 * the package root's devDependencies in a fresh one), or null.
 */
export function mcpCompiler(packageRoot) {
  try {
    return createRequire(join(packageRoot, 'mcp-server', 'package.json')).resolve('typescript/bin/tsc');
  } catch {
    return null;
  }
}

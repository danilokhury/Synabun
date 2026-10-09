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

import { existsSync, readFileSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { PACKAGE_ROOT } from './paths.js';

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

/** The entry executable when it outlives this run, otherwise null. */
export function durableEntry(runtime = packagedRuntime(), env = process.env) {
  const entry = runtime?.entry || null;
  return entry && !isTransientPath(entry, env) ? entry : null;
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
 * `env` with the packaged runtime first on PATH, so that `node`, `npm` and
 * `npx` started by name are the ones that came with the application.
 */
export function withPackagedPath(env = process.env, runtime = packagedRuntime()) {
  if (!runtime) return env;
  const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH') || 'PATH';
  const parts = String(env[key] || '').split(delimiter).filter(Boolean);
  if (parts[0] === runtime.runtimeBin) return env;
  return { ...env, [key]: [runtime.runtimeBin, ...parts.filter(part => part !== runtime.runtimeBin)].join(delimiter) };
}

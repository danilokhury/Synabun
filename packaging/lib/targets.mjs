/**
 * The targets a packaged SynaBun can be built for, and what each one needs.
 *
 * A build is native unless it is asked to be otherwise: it runs on the target's
 * own operating system, with the target's own Node, so that npm picks that
 * platform's dependencies and the native modules are loaded once before
 * anything is packaged. macOS x64 on Apple Silicon counts as native, because
 * Rosetta runs the x64 Node for real.
 *
 * A target with a `cross` entry can also be built on macOS or Linux with
 * --cross (lib/cross.mjs): the pinned Node of the build machine installs the
 * target's dependencies, zig compiles what has to be compiled, and the result
 * is checked file by file. It is never run, and the build report says so.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGING_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = dirname(PACKAGING_ROOT);

export function readPins(path = join(PACKAGING_ROOT, 'pins.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const target = (definition) => Object.freeze({ ...definition, hosts: Object.freeze(definition.hosts) });

export const TARGETS = Object.freeze({
  'macos-arm64': target({
    id: 'macos-arm64',
    label: 'macOS, Apple Silicon',
    npmScript: 'build:mac:arm',
    platform: 'darwin',
    arch: 'arm64',
    nodeDist: 'darwin-arm64',
    nodeArchive: 'tar.gz',
    bundle: 'macos-app',
    artifacts: ['dmg', 'zip'],
    hosts: [{ platform: 'darwin', arch: 'arm64' }],
    runner: 'macos-15',
  }),
  'macos-x64': target({
    id: 'macos-x64',
    label: 'macOS, Intel',
    npmScript: 'build:mac:intel',
    platform: 'darwin',
    arch: 'x64',
    nodeDist: 'darwin-x64',
    nodeArchive: 'tar.gz',
    bundle: 'macos-app',
    artifacts: ['dmg', 'zip'],
    // An Apple Silicon Mac runs the x64 Node through Rosetta 2.
    hosts: [{ platform: 'darwin', arch: 'x64' }, { platform: 'darwin', arch: 'arm64', needs: 'rosetta' }],
    runner: 'macos-15-intel',
  }),
  'linux-x64': target({
    id: 'linux-x64',
    label: 'Linux x64 (glibc)',
    npmScript: 'build:linux:x64',
    platform: 'linux',
    arch: 'x64',
    libc: 'glibc',
    nodeDist: 'linux-x64',
    nodeArchive: 'tar.gz',
    bundle: 'linux-appdir',
    artifacts: ['appimage', 'portable'],
    hosts: [{ platform: 'linux', arch: 'x64', libc: 'glibc' }],
    // glibc 2.28 is what the Node 22 binaries need themselves: nothing compiled here asks for more.
    cross: { zigTarget: 'x86_64-linux-gnu.2.28', glibc: '2.28' },
    runner: 'ubuntu-22.04',
  }),
  'windows-x64': target({
    id: 'windows-x64',
    label: 'Windows x64',
    npmScript: 'build:windows:x64',
    platform: 'win32',
    arch: 'x64',
    nodeDist: 'win-x64',
    nodeArchive: 'zip',
    bundle: 'windows-dir',
    artifacts: ['installer', 'zip'],
    hosts: [{ platform: 'win32', arch: 'x64' }],
    cross: { zigTarget: 'x86_64-windows-gnu' },
    runner: 'windows-2022',
  }),
  'windows-x86': target({
    id: 'windows-x86',
    label: 'Windows x86 (32-bit)',
    npmScript: 'build:windows:x86',
    platform: 'win32',
    arch: 'ia32',
    nodeDist: 'win-x86',
    nodeArchive: 'zip',
    bundle: 'windows-dir',
    artifacts: ['installer', 'zip'],
    // A 64-bit Windows runs the 32-bit Node and the 32-bit MSVC tools natively
    // (WOW64); what comes out is a real 32-bit application either way.
    hosts: [{ platform: 'win32', arch: 'ia32' }, { platform: 'win32', arch: 'x64' }],
    // Decided 2026-10-08: SynaBun for Windows is 64-bit only. The target stays
    // registered so that asking for it explains why, and it is always refused.
    unsupported: 'SynaBun for Windows is 64-bit only; use windows-x64',
    runner: 'windows-2022',
  }),
});

export function getTarget(id) {
  const found = TARGETS[String(id || '')];
  if (!found) {
    throw Object.assign(new Error(`Unknown target "${id}". Targets: ${Object.keys(TARGETS).join(', ')}`), { exitCode: 64 });
  }
  return found;
}

/** The Node archive of a target: its file name, URL and pinned SHA-256. */
export function nodeRuntimeFor(targetDefinition, pins = readPins()) {
  const file = `node-v${pins.node.version}-${targetDefinition.nodeDist}.${targetDefinition.nodeArchive}`;
  const sha256 = pins.node.files[file];
  if (!sha256) throw new Error(`No pinned checksum for ${file} in packaging/pins.json`);
  return { version: pins.node.version, file, url: pins.node.baseUrl + file, sha256 };
}

/**
 * The pinned Node that runs on a build machine, or null when the pins have none
 * for it. A cross build installs and compiles with this one.
 */
export function hostRuntimeFor(host, pins = readPins()) {
  if (!['darwin', 'linux'].includes(host.platform) || (host.platform === 'linux' && host.libc !== 'glibc')) return null;
  const file = `node-v${pins.node.version}-${host.platform}-${host.arch}.tar.gz`;
  const sha256 = pins.node.files[file];
  return sha256 ? { version: pins.node.version, file, url: pins.node.baseUrl + file, sha256 } : null;
}

/** File names of what a build of `version` for a target produces. */
export function artifactNames(targetDefinition, version) {
  const base = `SynaBun-${version}-${targetDefinition.id}`;
  return {
    base,
    dmg: `${base}.dmg`,
    zip: `${base}.zip`,
    installer: `${base}-setup.exe`,
    appimage: `${base}.AppImage`,
    portable: `${base}-portable.tar.gz`,
  };
}

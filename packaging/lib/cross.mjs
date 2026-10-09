/**
 * Cross builds: a Linux or Windows application made on macOS or Linux.
 *
 * Nothing of the target runs on the build machine, so everything a native
 * build learns by running is replaced here by something that can be checked:
 *
 *   the target's Node    its header says which system and processor it is for
 *   npm                  the build machine's pinned Node runs it, told the
 *                        target's os, cpu and libc; what it installed is then
 *                        compared with the lockfile, package by package
 *   compiling            zig, for the target's triple: the native entry, and
 *                        node-pty where it has no prebuilt binary; what the
 *                        result asks of the target system is read back
 *   the embedding model  downloaded file by file, each against its pin
 *   the smoke run        cannot happen: the build report says "not run"
 *
 * A cross build is asked for with --cross and never chosen on its own.
 */

import {
  closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync,
  statSync, unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BuildError, fetchVerified, nativeFormat, note, run, walk, which } from './util.mjs';

/** What npm is told so that it installs the target's packages, not this machine's. */
export function crossNpmEnv(target) {
  return {
    npm_config_os: target.platform,
    npm_config_cpu: target.arch,
    ...(target.libc ? { npm_config_libc: target.libc } : {}),
  };
}

/** npm's own rule for an `os`, `cpu` or `libc` list: any listed value, and none that is negated. */
function allows(list, value) {
  if (!list || !list.length) return true;
  if (list.includes(`!${value}`)) return false;
  const named = list.filter(item => !item.startsWith('!'));
  return !named.length || named.includes(value);
}

const madeFor = (entry) => [entry.os, entry.cpu, entry.libc].filter(Boolean).map(list => list.join('/')).join(' ');

/**
 * Compare what npm installed with a lockfile. A package that names an
 * operating system, a processor or a libc belongs in the tree exactly when it
 * is for the target: one for another system means npm installed for the build
 * machine. `installed(path)` says whether a lockfile path is on disk.
 */
export function checkSelection(packages, target, installed) {
  const wrong = [];
  let kept = 0;
  let left = 0;
  for (const [path, entry] of Object.entries(packages)) {
    if (!path.startsWith('node_modules/') || !(entry.os || entry.cpu || entry.libc)) continue;
    const forTarget = allows(entry.os, target.platform) && allows(entry.cpu, target.arch) && (!target.libc || allows(entry.libc, target.libc));
    if (!installed(path)) { if (!forTarget) left++; continue; }
    if (forTarget) kept++;
    else wrong.push(`${path} (${madeFor(entry)})`);
  }
  return { kept, left, wrong };
}

/** Stop the build unless both dependency trees hold the target's packages and nobody else's. */
export function verifySelection(ctx, locks) {
  const key = `${ctx.target.platform}-${ctx.target.arch}`;
  for (const [folder, packages] of Object.entries(locks)) {
    const root = join(ctx.app, folder);
    const result = checkSelection(packages, ctx.target, path => existsSync(join(root, path, 'package.json')));
    if (result.wrong.length) {
      throw new BuildError(`npm installed packages for another system in ${folder}. Nothing was packaged.`, { details: result.wrong.slice(0, 30) });
    }
    note(`${folder}: ${result.kept} per-platform packages, all for ${key}; ${result.left} for other systems left out`);
  }
  const missing = ctx.verdict.natives
    .filter(native => native.provides && !existsSync(join(ctx.app, native.lock, 'node_modules', ...native.provides.split('/'), 'package.json')))
    .map(native => `${native.provides} (${native.feature})`);
  if (missing.length) throw new BuildError(`npm did not install what ${key} needs. Nothing was packaged.`, { details: missing });
}

function zig(ctx, args, { cwd, label } = {}) {
  const tool = process.env.ZIG || which('zig');
  if (!tool) throw new BuildError('zig was not found: a cross build compiles with it.');
  // Its caches stay in this build's own folders.
  const env = { ...process.env, ZIG_GLOBAL_CACHE_DIR: join(ctx.cache, 'zig'), ZIG_LOCAL_CACHE_DIR: join(ctx.work, 'zig') };
  return run(tool, args, { cwd, env, label });
}

/** The native entry, for the target. `resources` are compiled Windows resources to link in. */
export function compileEntry(ctx, source, output, resources = []) {
  const { zigTarget } = ctx.target.cross;
  const flags = ctx.target.platform === 'win32' ? ['-O2', '-Wall', '-municode', '-Wl,/subsystem:windows', '-lshell32'] : ['-O2', '-Wall', '-Wextra', '-std=c99'];
  zig(ctx, ['cc', '-target', zigTarget, ...flags, '-s', '-o', output, source, ...resources], { label: 'compile the native entry (zig)' });
}

/** A Windows resource script to the .res the linker takes. */
export function compileResources(ctx, script, output) {
  // The script is named from its own folder, after `--`: a leading slash would read as an option.
  zig(ctx, ['rc', '/fo', output, '--', basename(script)], { cwd: dirname(script), label: 'compile the resources (zig rc)' });
}

/**
 * node-pty for a target it has no prebuilt binary for: the one source file and
 * the settings of its binding.gyp (the `pty` target of every system but
 * Windows), against the headers that came with the target's Node.
 */
export function compilePty(ctx, ptyDir) {
  const addonApi = [join(ptyDir, 'node_modules', 'node-addon-api'), join(dirname(ptyDir), 'node-addon-api')].find(folder => existsSync(join(folder, 'napi.h')));
  if (!addonApi) throw new BuildError('node-addon-api, which node-pty compiles against, was not installed.');
  const headers = join(ctx.runtime.root, 'include', 'node');
  if (!existsSync(join(headers, 'node_api.h'))) throw new BuildError(`The ${ctx.target.id} Node archive has no headers to compile node-pty against.`);
  const release = join(ptyDir, 'build', 'Release');
  mkdirSync(release, { recursive: true });
  zig(ctx, [
    'c++', '-target', ctx.target.cross.zigTarget, '-shared', '-fPIC', '-O2', '-std=gnu++17', '-fexceptions', '-Wall',
    '-D_FORTIFY_SOURCE=2', '-DNAPI_CPP_EXCEPTIONS', '-DBUILDING_NODE_EXTENSION', '-DNODE_GYP_MODULE_NAME=pty', '-D_LARGEFILE_SOURCE', '-D_FILE_OFFSET_BITS=64',
    '-I', headers, '-I', addonApi,
    '-Wl,-soname=pty.node', '-s', '-o', join(release, 'pty.node'), join(ptyDir, 'src', 'unix', 'pty.cc'), '-lutil',
  ], { label: 'compile node-pty (zig)' });
}

/**
 * What a 64-bit ELF file asks of the system that loads it, and what it offers:
 * { needed: [library], imports: [{ name, version, weak }], exports: Set }.
 */
export function elfSymbols(path) {
  const file = readFileSync(path);
  if (file.length < 64 || file.readUInt32BE(0) !== 0x7f454c46 || file[4] !== 2 || file[5] !== 1) throw new Error(`${path} is not a 64-bit little-endian ELF file`);
  const tableAt = Number(file.readBigUInt64LE(0x28));
  const entrySize = file.readUInt16LE(0x3a);
  const sections = [];
  for (let i = 0; i < file.readUInt16LE(0x3c); i++) {
    const at = tableAt + i * entrySize;
    sections.push({ type: file.readUInt32LE(at + 4), offset: Number(file.readBigUInt64LE(at + 0x18)), size: Number(file.readBigUInt64LE(at + 0x20)), link: file.readUInt32LE(at + 0x28) });
  }
  const text = (table, at) => file.toString('latin1', table.offset + at, file.indexOf(0, table.offset + at));
  const result = { needed: [], imports: [], exports: new Set() };

  const dynamic = sections.find(section => section.type === 6);
  if (dynamic) {
    for (let at = dynamic.offset; at + 16 <= dynamic.offset + dynamic.size; at += 16) {
      const tag = Number(file.readBigInt64LE(at));
      if (tag === 0) break;
      if (tag === 1) result.needed.push(text(sections[dynamic.link], Number(file.readBigUInt64LE(at + 8))));
    }
  }
  const symbols = sections.find(section => section.type === 11);
  if (!symbols) return result;

  // The version each import is bound to: its index in .gnu.version, named in .gnu.version_r.
  const versions = new Map();
  const required = sections.find(section => section.type === 0x6ffffffe);
  for (let at = required ? required.offset : -1; at >= 0;) {
    let aux = at + file.readUInt32LE(at + 8);
    for (let i = 0; i < file.readUInt16LE(at + 2); i++) {
      versions.set(file.readUInt16LE(aux + 6) & 0x7fff, text(sections[required.link], file.readUInt32LE(aux + 8)));
      aux += file.readUInt32LE(aux + 12);
    }
    const next = file.readUInt32LE(at + 12);
    at = next ? at + next : -1;
  }
  const versionIndex = sections.find(section => section.type === 0x6fffffff);
  for (let i = 1; (i + 1) * 24 <= symbols.size; i++) {
    const at = symbols.offset + i * 24;
    const name = text(sections[symbols.link], file.readUInt32LE(at));
    if (!name) continue;
    if (file.readUInt16LE(at + 6) !== 0) { result.exports.add(name); continue; }
    const index = versionIndex ? file.readUInt16LE(versionIndex.offset + i * 2) & 0x7fff : 0;
    result.imports.push({ name, version: versions.get(index) || null, weak: (file[at + 4] >> 4) === 2 });
  }
  return result;
}

/** The libraries every glibc system has: what a binary compiled here may ask for by name. */
const GLIBC_LIBRARIES = new Set(['libc.so.6', 'libm.so.6', 'libpthread.so.0', 'libdl.so.2', 'libutil.so.1', 'librt.so.1', 'ld-linux-x86-64.so.2']);

/**
 * What a binary compiled here asks for that the target would not give it: a
 * library outside glibc, a glibc symbol newer than `glibc`, or a symbol that
 * neither glibc nor one of `providers` (the Node that loads it) has.
 */
export function unmetImports(binary, { glibc, providers = [] }) {
  const [major, minor] = glibc.split('.').map(Number);
  const problems = binary.needed.filter(name => !GLIBC_LIBRARIES.has(name)).map(name => `needs ${name}, which is not part of glibc`);
  for (const symbol of binary.imports) {
    const version = /^GLIBC_(\d+)\.(\d+)/.exec(symbol.version || '');
    if (version) {
      if (Number(version[1]) > major || (Number(version[1]) === major && Number(version[2]) > minor)) problems.push(`${symbol.name} needs ${symbol.version}, newer than glibc ${glibc}`);
    } else if (symbol.version) {
      problems.push(`${symbol.name} needs ${symbol.version}, which glibc does not provide`);
    } else if (!symbol.weak && !providers.some(provider => provider.exports.has(symbol.name))) {
      problems.push(`${symbol.name} is provided by nothing that will be loaded`);
    }
  }
  return problems;
}

/** The embedding model, straight from where the application's installer gets it, each file against its pin. */
export async function fetchEmbeddingModel(ctx, cacheRoot) {
  const pin = ctx.pins.embeddingModel;
  for (const [name, sha256] of Object.entries(pin.files || {})) {
    const cached = await fetchVerified({
      url: `https://huggingface.co/${pin.id}/resolve/main/${name}`,
      sha256,
      destination: join(ctx.cache, 'model', ...pin.id.split('/'), ...name.split('/')),
      label: `${pin.id} ${name}`,
    });
    const destination = join(cacheRoot, ...pin.id.split('/'), ...name.split('/'));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(cached, destination);
  }
}

/** Every `.bin` folder under a node_modules tree. */
function binFolders(folder, found = []) {
  let entries;
  try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '.bin') found.push(join(folder, entry.name));
    else binFolders(join(folder, entry.name), found);
  }
  return found;
}

/**
 * npm links a package's commands the way the machine it runs on wants them: on
 * macOS and Linux as symbolic links, which mean nothing on Windows. Replace
 * each one with the three files npm writes on Windows, made by npm's own
 * cmd-shim. Returns how many commands were rewritten.
 */
export async function writeWindowsShims(ctx, nodeModules) {
  const shimPath = join(dirname(dirname(ctx.tool.npmCli)), 'node_modules', 'cmd-shim', 'lib', 'index.js');
  const { default: cmdShim } = await import(pathToFileURL(shimPath).href);
  let written = 0;
  for (const folder of binFolders(nodeModules)) {
    for (const name of readdirSync(folder)) {
      const link = join(folder, name);
      if (!lstatSync(link).isSymbolicLink()) continue;
      // Where the link points, by its own text: resolving the folders above it
      // would put this machine's paths into the command files.
      const script = resolve(folder, readlinkSync(link));
      const toScript = relative(folder, script);
      if (isAbsolute(toScript) || !existsSync(script)) throw new BuildError(`The package command ${link} points outside the application.`);
      unlinkSync(link);
      await cmdShim(script, link);
      if (!readFileSync(`${link}.cmd`, 'utf8').includes(toScript.split(sep).join('\\'))) {
        throw new BuildError(`The Windows command file for ${name} does not run ${toScript}.`);
      }
      written++;
    }
  }
  return written;
}

/** Symbolic links left in a tree that is going to Windows, where they would not work. */
export function linksIn(root) {
  return [...walk(root)].filter(file => file.link).map(file => file.relative);
}

/** How many inodes a squashfs image of `root` has: every folder, link and file, a hard-linked file once. */
export function countEntries(root) {
  const files = new Set();
  let others = 1;
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { others++; visit(path); continue; }
      const info = lstatSync(path);
      if (info.isFile() && info.nlink > 1) files.add(`${info.dev}:${info.ino}`);
      else others++;
    }
  };
  visit(root);
  return others + files.size;
}

/** Read back an AppImage: the runtime's type 2 mark, and a squashfs image right behind it. */
export function checkAppImage(image, offset, entries) {
  const head = Buffer.alloc(16);
  const superblock = Buffer.alloc(32);
  const fd = openSync(image, 'r');
  try {
    readSync(fd, head, 0, head.length, 0);
    readSync(fd, superblock, 0, superblock.length, offset);
  } finally {
    closeSync(fd);
  }
  if (nativeFormat(image)?.format !== 'elf' || head[8] !== 0x41 || head[9] !== 0x49 || head[10] !== 2) {
    throw new BuildError('The AppImage does not start with a type 2 AppImage runtime.');
  }
  if (superblock.toString('latin1', 0, 4) !== 'hsqs') throw new BuildError('The AppImage has no squashfs image where its runtime ends.');
  const inodes = superblock.readUInt32LE(4);
  if (entries !== undefined && inodes !== entries) {
    throw new BuildError(`The AppImage holds ${inodes} files, folders and links; the application has ${entries}.`);
  }
  return { offset, inodes };
}

/**
 * An AppImage is its runtime followed by a squashfs image of the AppDir.
 * appimagetool, which puts the two together, only runs on Linux; mksquashfs
 * runs anywhere and does the same.
 */
export function writeAppImage(ctx, { appDir, runtime, image }) {
  const tool = process.env.MKSQUASHFS || which('mksquashfs');
  if (!tool) throw new BuildError('mksquashfs was not found: a cross-built AppImage is made with it.');
  const offset = statSync(runtime).size;
  // -root-owned and -no-xattrs: nothing of the build machine's user or file system goes in.
  run(tool, [appDir, image, '-offset', String(offset), '-comp', 'zstd', '-root-owned', '-no-xattrs', '-noappend', '-no-progress'], {
    capture: true, env: process.env, label: 'mksquashfs',
  });
  const fd = openSync(image, 'r+');
  try {
    const bytes = readFileSync(runtime);
    writeSync(fd, bytes, 0, bytes.length, 0);
  } finally {
    closeSync(fd);
  }
  return checkAppImage(image, offset, countEntries(appDir));
}

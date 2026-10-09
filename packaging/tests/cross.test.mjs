// A cross build cannot run what it makes. These are the checks that stand in
// for running it: whose packages npm installed, what a compiled binary asks of
// the target, and what the artifact is made of.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { nsisArguments } from '../lib/bundle.mjs';
import {
  checkAppImage, checkSelection, countEntries, crossNpmEnv, elfSymbols, linksIn, unmetImports, writeAppImage, writeWindowsShims,
} from '../lib/cross.mjs';
import { evaluateTarget, readLocks } from '../lib/preflight.mjs';
import { hostRuntimeFor, readPins, TARGETS } from '../lib/targets.mjs';
import { which } from '../lib/util.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'synabun-cross-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const mac = { platform: 'darwin', arch: 'arm64', libc: null, rosetta: true };
const zig = process.env.ZIG || which('zig');

test('npm is told the target\'s system, processor and libc', () => {
  assert.deepEqual(crossNpmEnv(TARGETS['linux-x64']), { npm_config_os: 'linux', npm_config_cpu: 'x64', npm_config_libc: 'glibc' });
  assert.deepEqual(crossNpmEnv(TARGETS['windows-x64']), { npm_config_os: 'win32', npm_config_cpu: 'x64' });
});

test('the Node that does the work is the pinned one for the build machine', () => {
  const pins = readPins();
  assert.equal(hostRuntimeFor(mac, pins).file, `node-v${pins.node.version}-darwin-arm64.tar.gz`);
  assert.equal(hostRuntimeFor({ platform: 'linux', arch: 'x64', libc: 'glibc' }, pins).sha256, pins.node.files[`node-v${pins.node.version}-linux-x64.tar.gz`]);
  // No pinned Node, no cross build: nothing unverified ever installs the dependencies.
  assert.equal(hostRuntimeFor({ platform: 'linux', arch: 'arm64', libc: 'glibc' }, pins), null);
  assert.equal(hostRuntimeFor({ platform: 'linux', arch: 'x64', libc: 'musl' }, pins), null);
  assert.equal(hostRuntimeFor({ platform: 'win32', arch: 'x64', libc: null }, pins), null);
});

test('a dependency tree holds the target\'s packages and nobody else\'s', () => {
  const packages = {
    '': { name: 'app' },
    'node_modules/plain': { version: '1.0.0' },
    'node_modules/@x/tool-linux-x64': { os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
    'node_modules/@x/tool-linux-x64-musl': { os: ['linux'], cpu: ['x64'], libc: ['musl'] },
    'node_modules/@x/tool-darwin-arm64': { os: ['darwin'], cpu: ['arm64'] },
    'node_modules/@x/tool-win32-x64': { os: ['win32'], cpu: ['x64'] },
    'node_modules/not-windows': { os: ['!win32'] },
    'node_modules/a/node_modules/fsevents': { os: ['darwin'] },
  };
  const tree = (...paths) => (path) => paths.includes(path);
  const linux = TARGETS['linux-x64'];
  assert.deepEqual(checkSelection(packages, linux, tree('node_modules/plain', 'node_modules/@x/tool-linux-x64', 'node_modules/not-windows')), { kept: 2, left: 4, wrong: [] });
  // What a Mac's own npm would have installed, and the wrong libc.
  assert.deepEqual(checkSelection(packages, linux, tree('node_modules/@x/tool-darwin-arm64', 'node_modules/a/node_modules/fsevents')).wrong,
    ['node_modules/@x/tool-darwin-arm64 (darwin arm64)', 'node_modules/a/node_modules/fsevents (darwin)']);
  assert.deepEqual(checkSelection(packages, linux, tree('node_modules/@x/tool-linux-x64-musl')).wrong, ['node_modules/@x/tool-linux-x64-musl (linux x64 musl)']);
  const windows = TARGETS['windows-x64'];
  assert.deepEqual(checkSelection(packages, windows, tree('node_modules/@x/tool-win32-x64')), { kept: 1, left: 5, wrong: [] });
  assert.deepEqual(checkSelection(packages, windows, tree('node_modules/not-windows')).wrong, ['node_modules/not-windows (!win32)']);
});

test('in the real lockfiles, each cross target has its own package for every native dependency', () => {
  const locks = readLocks();
  for (const id of ['linux-x64', 'windows-x64']) {
    const target = TARGETS[id];
    const verdict = evaluateTarget(target, { host: mac, tools: [], cross: true });
    // Everything installed at once: what is reported is exactly what does not belong to the target.
    const foreign = checkSelection(locks['neural-interface'], target, () => true).wrong.join('\n');
    const provided = verdict.natives.filter(item => item.provides);
    assert.ok(provided.length, 'a native dependency names the package it installs for the target');
    for (const native of provided) assert.ok(!foreign.includes(`node_modules/${native.provides} `), `${native.provides} belongs to ${id}`);
    assert.match(foreign, /node_modules\/@img\/sharp-darwin-arm64 /);
    assert.match(foreign, id === 'linux-x64' ? /sharp-win32-x64 / : /sharp-linux-x64 /);
  }
});

test('what a compiled binary asks of the target is judged against the oldest glibc it has to run on', () => {
  const node = { exports: new Set(['napi_create_function']) };
  const binary = {
    needed: ['libc.so.6', 'libutil.so.1'],
    imports: [
      { name: 'forkpty', version: 'GLIBC_2.2.5', weak: false },
      { name: 'memcpy', version: 'GLIBC_2.14', weak: false },
      { name: 'napi_create_function', version: null, weak: false },
      { name: '__gmon_start__', version: null, weak: true },
    ],
  };
  assert.deepEqual(unmetImports(binary, { glibc: '2.28', providers: [node] }), []);
  assert.deepEqual(unmetImports(binary, { glibc: '2.12', providers: [node] }), ['memcpy needs GLIBC_2.14, newer than glibc 2.12']);
  assert.deepEqual(unmetImports(binary, { glibc: '2.28' }), ['napi_create_function is provided by nothing that will be loaded']);
  assert.deepEqual(unmetImports({ needed: ['libstdc++.so.6'], imports: [{ name: '__cxa_throw', version: 'CXXABI_1.3', weak: false }] }, { glibc: '2.28' }),
    ['needs libstdc++.so.6, which is not part of glibc', '__cxa_throw needs CXXABI_1.3, which glibc does not provide']);
});

test('those requirements are read from a real ELF file', { skip: process.platform === 'linux' || zig ? false : 'needs Linux or zig' }, () => {
  if (process.platform === 'linux') {
    const node = elfSymbols(process.execPath);
    assert.ok(node.exports.has('napi_create_function'));
    assert.ok(node.needed.includes('libc.so.6'));
    assert.ok(node.imports.some(symbol => /^GLIBC_/.test(symbol.version || '')));
  }
  if (zig) {
    const source = join(scratch, 'ask.c');
    const output = join(scratch, 'ask');
    writeFileSync(source, '#include <stdio.h>\nextern int napi_probe(void);\nint main(void) { puts("x"); return napi_probe(); }\n');
    const env = { ...process.env, ZIG_GLOBAL_CACHE_DIR: join(scratch, 'zig-global'), ZIG_LOCAL_CACHE_DIR: join(scratch, 'zig-local') };
    const built = spawnSync(zig, ['cc', '-target', TARGETS['linux-x64'].cross.zigTarget, '-shared', '-fPIC', '-o', output, source], { env, encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    const made = elfSymbols(output);
    assert.ok(made.imports.some(symbol => symbol.name === 'puts' && /^GLIBC_2\./.test(symbol.version)), JSON.stringify(made.imports));
    assert.ok(made.exports.has('main'));
    assert.deepEqual(unmetImports(made, { glibc: TARGETS['linux-x64'].cross.glibc }), ['napi_probe is provided by nothing that will be loaded']);
    assert.deepEqual(unmetImports(made, { glibc: TARGETS['linux-x64'].cross.glibc, providers: [{ exports: new Set(['napi_probe']) }] }), []);
  }
  assert.throws(() => elfSymbols(new URL(import.meta.url).pathname), /not a 64-bit little-endian ELF/);
});

function tree(name) {
  const root = join(scratch, name);
  mkdirSync(join(root, 'usr', 'lib'), { recursive: true });
  writeFileSync(join(root, 'AppRun'), 'entry');
  writeFileSync(join(root, 'usr', 'lib', 'one.js'), '1');
  linkSync(join(root, 'usr', 'lib', 'one.js'), join(root, 'usr', 'lib', 'same.js'));
  symlinkSync('AppRun', join(root, 'synabun'));
  return root;
}

test('an AppImage is read back: the runtime\'s mark, the image behind it, and how much it holds', () => {
  // root, usr, usr/lib, AppRun, the link, and one file behind two names.
  assert.equal(countEntries(tree('counted')), 6);

  const runtime = Buffer.alloc(128);
  runtime.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02]);
  runtime.writeUInt16LE(62, 18);
  const image = Buffer.alloc(64);
  image.write('hsqs', 0, 'latin1');
  image.writeUInt32LE(6, 4);
  const write = (name, ...parts) => { const path = join(scratch, name); writeFileSync(path, Buffer.concat(parts)); return path; };

  assert.deepEqual(checkAppImage(write('good.AppImage', runtime, image), runtime.length, 6), { offset: 128, inodes: 6 });
  assert.throws(() => checkAppImage(write('short.AppImage', runtime, image), runtime.length, 7), /holds 6 .* has 7/);
  assert.throws(() => checkAppImage(write('gap.AppImage', runtime, Buffer.alloc(16), image), runtime.length, 6), /no squashfs image/);
  const plain = Buffer.from(runtime);
  plain.fill(0, 8, 11);
  assert.throws(() => checkAppImage(write('plain.AppImage', plain, image), plain.length, 6), /type 2 AppImage runtime/);
});

test('mksquashfs and a runtime make that AppImage', { skip: process.env.MKSQUASHFS || which('mksquashfs') ? false : 'needs mksquashfs' }, () => {
  const appDir = tree('packed');
  const runtime = join(scratch, 'runtime');
  const bytes = Buffer.alloc(4096, 0x90);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02]);
  bytes.writeUInt16LE(62, 18);
  writeFileSync(runtime, bytes);
  const image = join(scratch, 'packed.AppImage');
  assert.deepEqual(writeAppImage({}, { appDir, runtime, image }), { offset: 4096, inodes: 6 });
  assert.deepEqual(readFileSync(image).subarray(0, 4096), bytes);
});

test('makensis takes dashes away from Windows, slashes on it', () => {
  const input = { version: '2.0.0', appDir: '/work/SynaBun', installer: '/out/setup.exe', icon: '/work/synabun.ico', script: '/repo/installer.nsi' };
  assert.deepEqual(nsisArguments(input, 'darwin'), [
    '-V2', '-INPUTCHARSET', 'UTF8', '-DAPP_VERSION=2.0.0', '-DAPP_VERSION_QUAD=2.0.0.0', '-DAPP_DIR=/work/SynaBun', '-DOUT_FILE=/out/setup.exe', '-DAPP_ICON=/work/synabun.ico', '/repo/installer.nsi',
  ]);
  const windows = nsisArguments({ ...input, icon: null }, 'win32');
  assert.deepEqual(windows.slice(0, 4), ['/V2', '/INPUTCHARSET', 'UTF8', '/DAPP_VERSION=2.0.0']);
  assert.ok(!windows.some(item => item.includes('APP_ICON')));
});

const npmCli = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');

test('package commands linked for this machine become Windows command files', { skip: process.platform === 'win32' || !existsSync(npmCli) ? 'needs a POSIX Node with its npm' : false }, async () => {
  const modules = join(scratch, 'shims', 'node_modules');
  mkdirSync(join(modules, 'tool', 'bin'), { recursive: true });
  mkdirSync(join(modules, '.bin'));
  writeFileSync(join(modules, 'tool', 'bin', 'cli.js'), '#!/usr/bin/env node\nconsole.log(1)\n');
  symlinkSync('../tool/bin/cli.js', join(modules, '.bin', 'tool'));
  assert.deepEqual(linksIn(join(scratch, 'shims')), ['node_modules/.bin/tool']);

  assert.equal(await writeWindowsShims({ tool: { npmCli } }, modules), 1);
  assert.deepEqual(linksIn(join(scratch, 'shims')), []);
  for (const name of ['tool', 'tool.cmd', 'tool.ps1']) assert.ok(lstatSync(join(modules, '.bin', name)).isFile(), name);
  const command = readFileSync(join(modules, '.bin', 'tool.cmd'), 'utf8');
  assert.match(command, /"%dp0%\\\.\.\\tool\\bin\\cli\.js"/);
  assert.match(command, /node/);
  // Relative to the application, wherever it was staged: no path of this machine in any of the three.
  for (const name of ['tool', 'tool.cmd', 'tool.ps1']) {
    const text = readFileSync(join(modules, '.bin', name), 'utf8');
    for (const here of [scratch, tmpdir(), 'private']) assert.ok(!text.includes(here), `${name} names ${here}`);
  }
});

// The builder's decisions: which targets exist, when a build is refused, what
// may never be packaged, and that nothing unverified is ever used.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { pngToIco } from '../lib/bundle.mjs';
import { evaluateTarget, readLocks } from '../lib/preflight.mjs';
import { findPrivatePaths, publicPackageSelection } from '../lib/stage.mjs';
import { nodeRuntimeFor, PACKAGING_ROOT, readPins, REPO_ROOT, TARGETS } from '../lib/targets.mjs';
import { EXIT, fetchVerified, isolatedEnv, nativeFormat } from '../lib/util.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'synabun-builder-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const host = (platform, arch, extra = {}) => ({ platform, arch, libc: platform === 'linux' ? 'glibc' : null, rosetta: false, ...extra });
const builder = (args, options = {}) => spawnSync(process.execPath, [join(PACKAGING_ROOT, 'build.mjs'), ...args], { encoding: 'utf8', ...options });

test('five targets, each with its own npm command and a pinned Node', () => {
  assert.deepEqual(Object.keys(TARGETS).sort(), ['linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64', 'windows-x86']);
  const scripts = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts;
  const pins = readPins();
  // The runtime that is bundled is the one the test suites run on in CI.
  assert.match(readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'), new RegExp(`node-version: ${pins.node.version.replace(/\./g, '\\.')}\\b`));
  for (const target of Object.values(TARGETS)) {
    assert.equal(scripts[target.npmScript], `node packaging/build.mjs build --target ${target.id}`);
    const runtime = nodeRuntimeFor(target, pins);
    assert.match(runtime.sha256, /^[0-9a-f]{64}$/);
    assert.ok(runtime.url.startsWith(`https://nodejs.org/dist/v${pins.node.version}/`), runtime.url);
  }
  assert.equal(TARGETS['windows-x86'].arch, 'ia32');
  assert.equal(nodeRuntimeFor(TARGETS['windows-x86'], pins).file, `node-v${pins.node.version}-win-x86.zip`);
});

test('32-bit Windows is refused while a dependency has no 32-bit build', () => {
  const verdict = evaluateTarget(TARGETS['windows-x86'], { host: host('win32', 'x64'), tools: [] });
  assert.equal(verdict.status, 'blocked');
  assert.equal(verdict.exitCode, EXIT.blocked);
  const text = verdict.blockers.join('\n');
  for (const name of ['onnxruntime-node', 'playwright-core']) assert.ok(text.includes(name), name);
  assert.match(text, /win32-x64/);
  // Claude Code and Codex are the user's own installations: no target waits for a build of them.
  for (const native of verdict.natives) assert.doesNotMatch(native.package, /claude|codex/);
  // And by decision: SynaBun for Windows is 64-bit only.
  assert.match(verdict.blockers[0], /not a supported target: .*64-bit only/);
  // The 64-bit target, same host, same lockfiles: nothing in its way.
  assert.equal(evaluateTarget(TARGETS['windows-x64'], { host: host('win32', 'x64'), tools: [] }).status, 'ready');
});

test('that refusal is read from the lockfiles, not from a list of targets', () => {
  const locks = structuredClone(readLocks());
  const neural = locks['neural-interface'];
  // The image library does publish a 32-bit Windows build. Without that entry it would be in the way too.
  assert.doesNotMatch(evaluateTarget(TARGETS['windows-x86'], { host: host('win32', 'x64'), tools: [] }).blockers.join('\n'), /sharp/);
  delete neural['node_modules/sharp'].optionalDependencies['@img/sharp-win32-ia32'];
  delete neural['node_modules/@img/sharp-win32-ia32'];
  assert.match(evaluateTarget(TARGETS['windows-x86'], { host: host('win32', 'x64'), locks, tools: [] }).blockers.join('\n'), /sharp .*no build for win32-ia32/);

  const pins = structuredClone(readPins());
  for (const table of Object.values(pins.nativeModules['onnxruntime-node'])) table.win32.push('ia32');
  const verdict = evaluateTarget(TARGETS['windows-x86'], { host: host('win32', 'x64'), pins, tools: [] });
  const text = verdict.blockers.join('\n');
  assert.ok(!text.includes('onnxruntime-node'), 'onnxruntime-node should no longer block');
  // The browser library still has no 32-bit Windows: the target stays refused.
  assert.equal(verdict.status, 'blocked');
  assert.match(text, /playwright-core/);
});

test('32-bit Windows stays refused even when nothing upstream is in its way', () => {
  // The decision is on the target, so a lockfile that lists a 32-bit build of everything changes nothing.
  const everything = { ...TARGETS['windows-x86'], id: 'windows-x86', platform: 'win32', arch: 'x64', nodeDist: 'win-x64' };
  const verdict = evaluateTarget(everything, { host: host('win32', 'x64'), tools: [] });
  assert.equal(verdict.status, 'blocked');
  assert.deepEqual(verdict.blockers, [`not a supported target: ${TARGETS['windows-x86'].unsupported}.`]);
  assert.equal(evaluateTarget(TARGETS['windows-x86'], { host: host('darwin', 'arm64', { rosetta: true }), tools: [], cross: true }).status, 'blocked');
  for (const id of ['macos-arm64', 'macos-x64', 'linux-x64', 'windows-x64']) assert.equal(TARGETS[id].unsupported, undefined, id);
});

test('a target is built on its own operating system and processor', () => {
  const linuxOnMac = evaluateTarget(TARGETS['linux-x64'], { host: host('darwin', 'arm64'), tools: [] });
  assert.equal(linuxOnMac.status, 'host-mismatch');
  assert.equal(linuxOnMac.exitCode, EXIT.hostMismatch);
  assert.equal(linuxOnMac.mode, null);
  assert.match(linuxOnMac.hostProblem, /ubuntu-22\.04/);
  assert.match(linuxOnMac.hostProblem, /--cross/);
  assert.equal(evaluateTarget(TARGETS['windows-x64'], { host: host('darwin', 'arm64'), tools: [] }).status, 'host-mismatch');
  assert.equal(evaluateTarget(TARGETS['linux-x64'], { host: host('linux', 'x64', { libc: 'musl' }), tools: [] }).status, 'host-mismatch');
  assert.equal(evaluateTarget(TARGETS['macos-arm64'], { host: host('darwin', 'x64'), tools: [] }).status, 'host-mismatch');
  // Intel macOS on Apple Silicon: only where the x64 Node really runs.
  assert.equal(evaluateTarget(TARGETS['macos-x64'], { host: host('darwin', 'arm64'), tools: [] }).status, 'host-mismatch');
  assert.equal(evaluateTarget(TARGETS['macos-x64'], { host: host('darwin', 'arm64', { rosetta: true }), tools: [] }).status, 'ready');
  assert.equal(evaluateTarget(TARGETS['linux-x64'], { host: host('linux', 'x64'), tools: [] }).status, 'ready');
});

test('a cross build has to be asked for, and exists only for Linux and Windows', () => {
  const mac = host('darwin', 'arm64', { rosetta: true });
  for (const id of ['linux-x64', 'windows-x64']) {
    const crossed = evaluateTarget(TARGETS[id], { host: mac, tools: [], cross: true });
    assert.equal(crossed.status, 'ready', id);
    assert.equal(crossed.mode, 'cross', id);
    assert.equal(evaluateTarget(TARGETS[id], { host: host('linux', 'x64'), tools: [], cross: true }).mode, id === 'linux-x64' ? 'native' : 'cross', id);
  }
  // A machine that builds the target for real does so, flag or no flag.
  assert.equal(evaluateTarget(TARGETS['macos-x64'], { host: mac, tools: [], cross: true }).mode, 'native');
  assert.equal(evaluateTarget(TARGETS['windows-x64'], { host: host('win32', 'x64'), tools: [], cross: true }).mode, 'native');
  // No cross build of a macOS application, and none from a machine the pins have no Node for.
  const macOnLinux = evaluateTarget(TARGETS['macos-arm64'], { host: host('linux', 'x64'), tools: [], cross: true });
  assert.equal(macOnLinux.status, 'host-mismatch');
  assert.match(macOnLinux.hostProblem, /has no cross build/);
  for (const other of [host('linux', 'arm64'), host('linux', 'x64', { libc: 'musl' }), host('win32', 'arm64')]) {
    assert.equal(evaluateTarget(TARGETS['linux-x64'], { host: other, tools: [], cross: true }).status, 'host-mismatch', `${other.platform}-${other.arch}`);
  }
  // zig is what it cannot do without; the artifact tools only decide which artifact comes out.
  const tools = evaluateTarget(TARGETS['linux-x64'], { host: mac, cross: true, env: { PATH: scratch } });
  assert.equal(tools.status, 'missing-tools');
  assert.ok(tools.missingTools.some(item => item.startsWith('zig: ')), tools.missingTools.join('; '));
  assert.ok(!tools.missingTools.some(item => item.startsWith('mksquashfs')));
  assert.deepEqual(tools.tools.filter(item => !item.required).map(item => item.name), ['mksquashfs']);
  assert.deepEqual(evaluateTarget(TARGETS['windows-x64'], { host: mac, cross: true, env: { PATH: scratch } }).tools.filter(item => !item.required).map(item => item.name), ['makensis', 'sips']);
});

test('a missing tool is reported before anything is staged', () => {
  const verdict = evaluateTarget(TARGETS['macos-arm64'], {
    host: host('darwin', 'arm64'),
    tools: [{ name: 'clang', path: null, required: true, purpose: 'compiles the native entry' }, { name: 'sips', path: null, required: false, purpose: 'icon' }],
  });
  assert.equal(verdict.status, 'missing-tools');
  assert.equal(verdict.exitCode, EXIT.missingTools);
  assert.deepEqual(verdict.missingTools, ['clang: compiles the native entry']);
});

test('a refused build downloads, stages and removes nothing', () => {
  const work = join(scratch, 'work');
  const out = join(scratch, 'out');
  const cache = join(scratch, 'cache');
  writeFileSync(join(scratch, 'keep.txt'), 'still here');
  const refused = builder(['build', '--target', 'windows-x86', '--work', work, '--out', out, '--cache', cache]);
  assert.equal(refused.status, EXIT.blocked);
  assert.match(refused.stderr, /ships no binary for win32-ia32/);
  assert.equal(refused.stdout, '');
  for (const folder of [work, out, cache]) assert.equal(existsSync(folder), false, folder);
  assert.equal(readFileSync(join(scratch, 'keep.txt'), 'utf8'), 'still here');

  assert.equal(builder(['preflight', '--target', 'windows-x86']).status, EXIT.blocked);
  assert.equal(builder(['preflight', '--target', 'windows-x86', '--cross']).status, EXIT.blocked);
  if (process.platform === 'darwin') {
    // A Mac runs neither target, and without zig it does not cross-build them either.
    const env = { PATH: '/usr/bin:/bin' };
    assert.equal(builder(['build', '--target', 'linux-x64', '--work', work, '--out', out, '--cache', cache], { env }).status, EXIT.hostMismatch);
    const noZig = builder(['build', '--target', 'windows-x64', '--cross', '--work', work, '--out', out, '--cache', cache], { env });
    assert.equal(noZig.status, EXIT.missingTools);
    assert.match(noZig.stderr, /missing {2}zig: /);
    for (const folder of [work, out, cache]) assert.equal(existsSync(folder), false, folder);
  }
  assert.equal(builder(['build', '--target', 'solaris-sparc']).status, EXIT.usage);
  assert.equal(builder(['build']).status, EXIT.usage);

  const listed = builder(['targets', '--json']);
  assert.equal(listed.status, 0);
  const verdicts = JSON.parse(listed.stdout);
  assert.equal(verdicts.length, 5);
  assert.equal(verdicts.find(item => item.target === 'windows-x86').status, 'blocked');
});

test('private files are recognised whatever the file list says', () => {
  const secret = [
    '.env', 'neural-interface/.env.local', 'data/memory.db', 'mcp-data/memory.db-wal', 'neural-interface/data/ui-state.json',
    '.claude/settings.json', 'CLAUDE.md', 'docs/AGENTS.md', 'connections.json', 'mcp-server/.npmrc', 'changelog/v.2026.09.01-RAW.md',
    'keys/server.pem', 'memory-seed/a.json', 'synabun-2.0.0.tgz',
  ];
  assert.deepEqual(findPrivatePaths(secret).map(item => item.path), secret);
  assert.deepEqual(findPrivatePaths([
    '.env.example', 'neural-interface/lib/whatsapp/connector/.npmrc', 'neural-interface/templates/rulesets/claude.md',
    'lib/data-home-migration.js', 'neural-interface/lib/db.js', 'docs/judgments.md', 'README.md',
  ]), []);
});

test('the published file list is clean and carries what the packaged runtime imports', () => {
  const home = join(scratch, 'npm-home');
  const env = isolatedEnv({ home, tmp: join(home, 'tmp'), npmCache: join(home, 'cache'), pathEntries: [dirname(process.execPath)] });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: REPO_ROOT, env, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map(file => file.path);
  assert.deepEqual(publicPackageSelection(files).blocked, []);
  assert.deepEqual(findPrivatePaths(publicPackageSelection(files).files), []);
  // setup.js, the launcher and the server import it: it has to ship with them.
  assert.ok(files.includes('lib/packaged-runtime.js'));
  // The builder itself is a development tool: none of it goes to npm.
  assert.deepEqual(files.filter(file => file.startsWith('packaging/') || file.startsWith('build/')), []);
});

test('native binaries are told apart by their headers', () => {
  const write = (name, bytes) => { const path = join(scratch, name); writeFileSync(path, Buffer.concat([Buffer.from(bytes), Buffer.alloc(256)])); return path; };
  const le32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return [...b]; };
  const be32 = (value) => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return [...b]; };
  assert.deepEqual(nativeFormat(write('macho-arm64', [0xcf, 0xfa, 0xed, 0xfe, ...le32(0x0100000c)])), { format: 'macho', archs: ['arm64'] });
  assert.deepEqual(nativeFormat(write('macho-x64', [0xcf, 0xfa, 0xed, 0xfe, ...le32(0x01000007)])), { format: 'macho', archs: ['x64'] });
  const fat = [0xca, 0xfe, 0xba, 0xbe, ...be32(2), ...be32(0x01000007), ...Array(16).fill(0), ...be32(0x0100000c)];
  assert.deepEqual(nativeFormat(write('macho-universal', fat)), { format: 'macho', archs: ['x64', 'arm64'] });
  const elf = Buffer.alloc(64); elf.set([0x7f, 0x45, 0x4c, 0x46]); elf.writeUInt16LE(62, 18);
  assert.deepEqual(nativeFormat(write('elf-x64', elf)), { format: 'elf', archs: ['x64'] });
  const pe = Buffer.alloc(0x90); pe.set([0x4d, 0x5a]); pe.writeUInt32LE(0x80, 0x3c); pe.writeUInt32LE(0x00004550, 0x80); pe.writeUInt16LE(0x014c, 0x84);
  assert.deepEqual(nativeFormat(write('pe-ia32', pe)), { format: 'pe', archs: ['ia32'] });
  // A Java class file starts with the same four bytes as a universal Mach-O.
  assert.equal(nativeFormat(write('java.class', [0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34])), null);
  assert.equal(nativeFormat(write('script.js', [...Buffer.from('#!/usr/bin/env node\nconsole.log(1)\n')])), null);
});

test('a download that does not match its pin is discarded', async () => {
  const body = Buffer.from('a runtime, supposedly');
  const server = createServer((req, res) => res.end(body));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/file`;
  try {
    const destination = join(scratch, 'downloads', 'file');
    await assert.rejects(fetchVerified({ url, sha256: 'a'.repeat(64), destination, label: 'file' }), /Checksum mismatch/);
    assert.equal(existsSync(destination), false);
    assert.deepEqual(readdirSync(dirname(destination)), [], 'no partial download is left behind');
    await assert.rejects(fetchVerified({ url, sha256: '', destination, label: 'file' }), /No pinned SHA-256/);
    const sha256 = createHash('sha256').update(body).digest('hex');
    assert.equal(await fetchVerified({ url, sha256, destination, label: 'file' }), destination);
    assert.deepEqual(readFileSync(destination), body);
  } finally {
    server.close();
  }
});

test('build steps run in an environment that carries no secrets over', () => {
  const home = join(scratch, 'iso-home');
  const env = isolatedEnv({
    home, tmp: join(home, 'tmp'), npmCache: join(home, 'cache'), pathEntries: ['/runtime/bin'],
    source: { PATH: '/somewhere/else', HOME: '/real/home', NPM_TOKEN: 's3cret', GITHUB_TOKEN: 't0ken', TYPESAFE_API_KEY: 'k', SYNABUN_ASSISTANT_SESSION: '1', SYNABUN_DATA_HOME: '/real/data', HTTPS_PROXY: 'http://proxy:8080' },
  });
  for (const name of ['NPM_TOKEN', 'GITHUB_TOKEN', 'TYPESAFE_API_KEY', 'SYNABUN_ASSISTANT_SESSION', 'SYNABUN_DATA_HOME']) assert.equal(name in env, false, name);
  assert.equal(env.HOME, home);
  assert.ok(env.PATH.startsWith('/runtime/bin'));
  assert.ok(!env.PATH.includes('/somewhere/else'));
  assert.equal(env.HTTPS_PROXY, 'http://proxy:8080');
  assert.notEqual(env.npm_config_userconfig, env.npm_config_globalconfig);
  assert.equal(readFileSync(env.npm_config_userconfig, 'utf8'), '');
});

test('the icon container around a PNG', () => {
  const png = Buffer.alloc(64);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(256, 16);
  png.writeUInt32BE(256, 20);
  const ico = pngToIco(png);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 1);
  assert.equal(ico[6], 0);
  assert.equal(ico.readUInt32LE(14), png.length);
  assert.deepEqual(ico.subarray(22), png);
  png.writeUInt32BE(512, 16);
  assert.throws(() => pngToIco(png), /256/);
});

test('the workflow builds exactly the targets that can be built, by hand, and publishes nothing', () => {
  const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'build-apps.yml'), 'utf8');
  const buildable = Object.values(TARGETS)
    .filter(target => !evaluateTarget(target, { host: host(target.platform, target.hosts[0].arch), tools: [] }).blockers.length)
    .map(target => target.id);
  const defaults = /default: ((?:[a-z0-9-]+ ?)+)\n/.exec(workflow)[1].trim().split(' ');
  assert.deepEqual(defaults.sort(), buildable.sort());
  const triggers = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));
  assert.match(triggers, /workflow_dispatch:/);
  assert.doesNotMatch(triggers, /\b(push|pull_request|release|schedule):/);
  assert.match(workflow, /permissions:\n {2}contents: read\n/);
  assert.doesNotMatch(workflow, /gh release|npm publish|softprops|action-gh-release|contents: write/);
});

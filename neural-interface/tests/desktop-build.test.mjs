// Desktop helper build: hashing, toolchain detection, command composition,
// atomic install + GC, the build lock, and binary resolution. Every process
// call is injected — nothing here runs xcrun or swiftc.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HELPER_SOURCE_PATH, compileFlags, compileHelper, detectToolchain, hashFromBinaryPath, helperBinaryPath, installToolchain,
  resolveHelperBinary, sourceHash, swiftArch,
} from '../lib/desktop/build.js';
import { PROTOCOL_VERSION } from '../lib/desktop/protocol.js';

const DEV_DIR = '/Library/Developer/CommandLineTools';
const SWIFTC = `${DEV_DIR}/usr/bin/swiftc`;
const VERSION_LINE = 'swift-driver version: 1.168.6 Apple Swift version 6.4 (swiftlang-6.4.0.34.1 clang-2100.3.34.1)';
const HOST = { platform: 'darwin', arch: 'arm64', existsImpl: () => true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'synabun-desktop-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function execError(message, extra = {}) {
  return Object.assign(new Error(message), { code: 1, stdout: '', stderr: message, ...extra });
}

/** A scripted xcode-select / xcrun. The compile step writes a fake binary to -o. */
function fakeExec({ selectFails = false, findFails = false, compileFails = false, compileDelayMs = 0, installOutput } = {}) {
  const calls = [];
  const impl = async (file, args, options = {}) => {
    calls.push({ file, args: [...args], options });
    if (file === 'xcode-select' && args[0] === '-p') {
      if (selectFails) throw execError('xcode-select: error: unable to get active developer directory');
      return { stdout: `${DEV_DIR}\n`, stderr: '' };
    }
    if (file === 'xcode-select' && args[0] === '--install') {
      if (installOutput === 'installed') {
        throw execError('xcode-select: error: command line tools are already installed, use "Software Update" in System Settings to install updates');
      }
      if (installOutput === 'fail') throw execError('xcode-select: error: something else');
      return { stdout: 'xcode-select: note: install requested for command line developer tools\n', stderr: '' };
    }
    if (file === 'xcrun' && args[0] === '--find') {
      if (findFails) throw execError('xcrun: error: unable to find utility "swiftc", not a developer tool or in PATH');
      return { stdout: `${SWIFTC}\n`, stderr: '' };
    }
    if (file === 'xcrun' && args[0] === 'swiftc' && args[1] === '--version') {
      return { stdout: `${VERSION_LINE}\nTarget: arm64-apple-macosx26.0\n`, stderr: '' };
    }
    if (file === 'xcrun' && args[0] === '--show-sdk-version') return { stdout: '27.0\n', stderr: '' };
    if (file === 'xcrun' && args[0] === 'swiftc') {
      if (compileDelayMs) await sleep(compileDelayMs);
      if (compileFails) throw execError('SynabunDesktop.swift:12:5: error: cannot find \'boom\' in scope');
      writeFileSync(args[args.indexOf('-o') + 1], '#!/bin/sh\necho fake-helper\n', { mode: 0o644 });
      return { stdout: '', stderr: 'SynabunDesktop.swift:1:1: warning: harmless\n' };
    }
    throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
  };
  const compiles = () => calls.filter((c) => c.file === 'xcrun' && c.args[0] === 'swiftc' && c.args[1] !== '--version');
  return { impl, calls, compiles };
}

function expectedHash(arch = 'arm64') {
  return sourceHash({
    source: readFileSync(HELPER_SOURCE_PATH, 'utf8'),
    flags: compileFlags(arch),
    compilerVersion: VERSION_LINE,
    arch: swiftArch(arch),
    protocolVersion: PROTOCOL_VERSION,
  });
}

test('sourceHash is stable and sensitive to every input', () => {
  const base = { source: 'print(1)', flags: ['-O'], compilerVersion: 'Swift 6.4', arch: 'arm64', protocolVersion: 1 };
  const h = sourceHash(base);
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.equal(sourceHash({ ...base }), h);
  const variants = [
    { source: 'print(2)' }, { flags: ['-Onone'] }, { flags: [] }, { compilerVersion: 'Swift 6.5' }, { arch: 'x86_64' }, { protocolVersion: 2 },
  ];
  const seen = new Set([h]);
  for (const v of variants) {
    const other = sourceHash({ ...base, ...v });
    assert.notEqual(other, h, JSON.stringify(v));
    seen.add(other);
  }
  assert.equal(seen.size, variants.length + 1);
});

test('paths, flags and hash-from-name helpers', () => {
  assert.equal(helperBinaryPath({ dataHome: '/d', hash: '0123456789abcdef' }), '/d/bin/synabun-desktop-0123456789abcdef');
  assert.throws(() => helperBinaryPath({ dataHome: '/d', hash: '../../evil' }), TypeError);
  assert.equal(hashFromBinaryPath('/x/bin/synabun-desktop-0123456789abcdef'), '0123456789abcdef');
  assert.equal(hashFromBinaryPath('/usr/local/bin/my-helper'), null);
  assert.deepEqual(compileFlags('arm64'), ['-O', '-swift-version', '5', '-target', 'arm64-apple-macos14.0']);
  assert.deepEqual(compileFlags('x64'), ['-O', '-swift-version', '5', '-target', 'x86_64-apple-macos14.0']);
});

test('detectToolchain parses the tool versions', async () => {
  const exec = fakeExec();
  const tc = await detectToolchain({ execFileImpl: exec.impl, ...HOST });
  assert.deepEqual(tc, {
    swiftc: true, path: SWIFTC, version: '6.4', compilerVersion: VERSION_LINE, arch: 'arm64', sdkVersion: '27.0', developerDir: DEV_DIR,
  });
  assert.deepEqual(exec.calls.map((c) => [c.file, ...c.args].join(' ')), [
    'xcode-select -p', 'xcrun --find swiftc', 'xcrun swiftc --version', 'xcrun --show-sdk-version',
  ]);
});

test('detectToolchain reports "needs toolchain" without ever prompting', async () => {
  const find = fakeExec({ findFails: true });
  const a = await detectToolchain({ execFileImpl: find.impl, ...HOST });
  assert.equal(a.swiftc, false);
  assert.equal(a.needsToolchain, true);
  assert.match(a.error, /unable to find utility "swiftc"/);

  // No developer directory: xcrun (which would pop Apple's install dialog) is never run.
  const select = fakeExec({ selectFails: true });
  const b = await detectToolchain({ execFileImpl: select.impl, ...HOST });
  assert.equal(b.needsToolchain, true);
  assert.deepEqual(select.calls.map((c) => c.file), ['xcode-select']);

  const missing = fakeExec();
  const c = await detectToolchain({ execFileImpl: missing.impl, ...HOST, existsImpl: () => false });
  assert.equal(c.needsToolchain, true);
  assert.deepEqual(missing.calls.map((x) => x.file), ['xcode-select']);

  const linux = fakeExec();
  const d = await detectToolchain({ execFileImpl: linux.impl, platform: 'linux', arch: 'x64' });
  assert.equal(d.swiftc, false);
  assert.equal(linux.calls.length, 0);
});

test('compileHelper composes the swiftc command and installs atomically', async (t) => {
  const dataHome = tempHome(t);
  const exec = fakeExec();
  const stages = [];
  const res = await compileHelper({ dataHome, execFileImpl: exec.impl, ...HOST, onProgress: (p) => stages.push(p.stage) });
  const hash = expectedHash();
  assert.equal(res.hash, hash);
  assert.equal(res.path, join(dataHome, 'bin', `synabun-desktop-${hash}`));
  assert.equal(res.compilerVersion, VERSION_LINE);
  assert.ok(res.durationMs >= 0);
  assert.match(res.logTail, /warning: harmless/);
  assert.deepEqual(stages, ['toolchain', 'lock', 'compile', 'install', 'done']);

  const [compile] = exec.compiles();
  const tmp = compile.args[compile.args.indexOf('-o') + 1];
  assert.deepEqual(compile.args, [
    'swiftc', '-O', '-swift-version', '5', '-target', 'arm64-apple-macos14.0',
    '-module-cache-path', join(dataHome, 'cache', 'swift'), '-o', tmp, HELPER_SOURCE_PATH,
  ]);
  assert.equal(compile.file, 'xcrun');
  assert.equal(compile.options.timeout, 180000);
  assert.ok(tmp.startsWith(join(dataHome, 'bin', `.synabun-desktop-${hash}.`)) && tmp.endsWith('.tmp'));
  assert.equal(existsSync(tmp), false, 'temp file renamed away');
  assert.equal(statSync(res.path).mode & 0o777, 0o755);
  assert.ok(existsSync(join(dataHome, 'cache', 'swift')));
  assert.deepEqual(readdirSync(join(dataHome, 'bin')), [`synabun-desktop-${hash}`], 'lock released, nothing left over');
  const log = readFileSync(join(dataHome, 'data', 'desktop', 'build.log'), 'utf8');
  assert.match(log, new RegExp(`ok hash=${hash}`));
  assert.match(log, /\$ xcrun swiftc -O -swift-version 5 -target arm64-apple-macos14\.0/);

  // Same hash already installed → no second compile.
  const again = await compileHelper({ dataHome, execFileImpl: exec.impl, ...HOST });
  assert.equal(again.cached, true);
  assert.equal(again.path, res.path);
  assert.equal(exec.compiles().length, 1);
});

test('compileHelper keeps only the two newest binaries and sweeps stale temp files', async (t) => {
  const dataHome = tempHome(t);
  const bin = join(dataHome, 'bin');
  mkdirSync(bin, { recursive: true });
  const old = ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc'];
  const nowS = Date.now() / 1000;
  old.forEach((h, i) => {
    const p = join(bin, `synabun-desktop-${h}`);
    writeFileSync(p, 'old', { mode: 0o755 });
    utimesSync(p, nowS - 3600 * (3 - i), nowS - 3600 * (3 - i)); // c newest of the three
  });
  const staleTmp = join(bin, '.synabun-desktop-dddddddddddddddd.1.abcd.tmp');
  writeFileSync(staleTmp, 'partial');
  utimesSync(staleTmp, nowS - 7200, nowS - 7200);
  writeFileSync(join(bin, 'unrelated-file'), 'keep me');

  const res = await compileHelper({ dataHome, execFileImpl: fakeExec().impl, ...HOST });
  assert.deepEqual(readdirSync(bin).sort(), [`synabun-desktop-${res.hash}`, 'synabun-desktop-cccccccccccccccc', 'unrelated-file'].sort());
});

test('a failed compile surfaces the log tail and leaves nothing behind', async (t) => {
  const dataHome = tempHome(t);
  await assert.rejects(
    compileHelper({ dataHome, execFileImpl: fakeExec({ compileFails: true }).impl, ...HOST }),
    (err) => {
      assert.equal(err.code, 'HELPER_UNAVAILABLE');
      assert.equal(err.details.stage, 'compile');
      assert.match(err.details.logTail, /cannot find 'boom' in scope/);
      assert.equal(err.details.exitCode, 1);
      return true;
    },
  );
  assert.deepEqual(readdirSync(join(dataHome, 'bin')), []);
  assert.match(readFileSync(join(dataHome, 'data', 'desktop', 'build.log'), 'utf8'), /FAILED hash=/);
});

test('compileHelper refuses without a toolchain and says so', async (t) => {
  const dataHome = tempHome(t);
  const exec = fakeExec({ findFails: true });
  await assert.rejects(compileHelper({ dataHome, execFileImpl: exec.impl, ...HOST }), (err) => {
    assert.equal(err.code, 'HELPER_UNAVAILABLE');
    assert.equal(err.details.needsToolchain, true);
    assert.equal(err.details.toolchain.swiftc, false);
    return true;
  });
  assert.equal(exec.compiles().length, 0);
});

test('build lock: waits for a live owner, breaks stale and dead ones', async (t) => {
  const dataHome = tempHome(t);
  const bin = join(dataHome, 'bin');
  mkdirSync(bin, { recursive: true });
  const lock = join(bin, '.build.lock');

  // Live owner (this very process) holding a fresh lock: we wait for it.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const started = Date.now();
  setTimeout(() => rmSync(lock, { force: true }), 300);
  const first = await compileHelper({ dataHome, execFileImpl: fakeExec().impl, ...HOST, lockPollMs: 20 });
  assert.ok(Date.now() - started >= 250, 'waited for the owner');
  assert.equal(existsSync(lock), false);
  rmSync(first.path);

  // Stale by age (older than the build timeout): broken immediately.
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const past = Date.now() / 1000 - 3600;
  utimesSync(lock, past, past);
  const t1 = Date.now();
  const second = await compileHelper({ dataHome, execFileImpl: fakeExec().impl, ...HOST, lockPollMs: 20 });
  assert.ok(Date.now() - t1 < 1000);
  rmSync(second.path);

  // Owner process is gone: broken immediately.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(lock, JSON.stringify({ pid: dead }));
  const t2 = Date.now();
  await compileHelper({ dataHome, execFileImpl: fakeExec().impl, ...HOST, lockPollMs: 20 });
  assert.ok(Date.now() - t2 < 1000);

  // A live lock goes stale once it outlives the build timeout.
  rmSync(helperBinaryPath({ dataHome, hash: expectedHash() }));
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const t3 = Date.now();
  await compileHelper({ dataHome, execFileImpl: fakeExec().impl, ...HOST, timeoutMs: 300, lockPollMs: 20 });
  assert.ok(Date.now() - t3 >= 250, 'waited until the lock aged past timeoutMs');
});

test('concurrent builds compile once; the waiter reuses the result', async (t) => {
  const dataHome = tempHome(t);
  const exec = fakeExec({ compileDelayMs: 200 });
  const [a, b] = await Promise.all([
    compileHelper({ dataHome, execFileImpl: exec.impl, ...HOST, lockPollMs: 20 }),
    compileHelper({ dataHome, execFileImpl: exec.impl, ...HOST, lockPollMs: 20 }),
  ]);
  assert.equal(a.path, b.path);
  assert.equal(exec.compiles().length, 1);
  assert.equal([a, b].filter((r) => r.cached).length, 1);
});

test('resolveHelperBinary: env override, cache, compile-on-demand, needs-compile', async (t) => {
  const dataHome = tempHome(t);

  const custom = join(dataHome, 'my-helper');
  writeFileSync(custom, '#!/bin/sh\n', { mode: 0o755 });
  const envExec = fakeExec();
  const viaEnv = await resolveHelperBinary({
    dataHome, env: { SYNABUN_DESKTOP_HELPER_PATH: custom }, execFileImpl: envExec.impl, ...HOST, existsImpl: existsSync,
  });
  assert.deepEqual(viaEnv, { path: custom, hash: null, source: 'env' });
  assert.equal(envExec.calls.length, 0, 'the override never touches the toolchain');
  await assert.rejects(
    resolveHelperBinary({
      dataHome, env: { SYNABUN_DESKTOP_HELPER_PATH: join(dataHome, 'missing') }, execFileImpl: envExec.impl, ...HOST, existsImpl: existsSync,
    }),
    (err) => err.code === 'HELPER_UNAVAILABLE' && /missing/.test(err.message),
  );
  assert.equal(envExec.calls.length, 0);

  const exec = fakeExec();
  await assert.rejects(resolveHelperBinary({ dataHome, env: {}, execFileImpl: exec.impl, ...HOST }), (err) => {
    assert.equal(err.code, 'HELPER_UNAVAILABLE');
    assert.equal(err.details.needsCompile, true);
    assert.equal(err.details.hash, expectedHash());
    return true;
  });
  assert.equal(exec.compiles().length, 0);

  const built = await resolveHelperBinary({ dataHome, env: {}, compile: true, execFileImpl: exec.impl, ...HOST });
  assert.equal(built.source, 'compiled');
  assert.equal(built.hash, expectedHash());
  assert.equal(exec.compiles().length, 1);

  const cached = await resolveHelperBinary({ dataHome, env: {}, compile: true, execFileImpl: exec.impl, ...HOST });
  assert.equal(cached.source, 'cache');
  assert.equal(cached.path, built.path);
  assert.equal(exec.compiles().length, 1);
});

test('resolveHelperBinary: needs toolchain / unsupported platform', async (t) => {
  const dataHome = tempHome(t);
  await assert.rejects(
    resolveHelperBinary({ dataHome, env: {}, compile: true, execFileImpl: fakeExec({ findFails: true }).impl, ...HOST }),
    (err) => err.code === 'HELPER_UNAVAILABLE' && err.details.needsToolchain === true,
  );
  await assert.rejects(
    resolveHelperBinary({ dataHome, env: {}, platform: 'linux', execFileImpl: fakeExec().impl }),
    (err) => err.code === 'UNSUPPORTED',
  );
});

test('installToolchain opens the installer or reports why not', async () => {
  const ok = fakeExec();
  assert.deepEqual(await installToolchain({ execFileImpl: ok.impl }), { started: true });
  assert.deepEqual(ok.calls.map((c) => [c.file, ...c.args].join(' ')), ['xcode-select --install']);
  const already = await installToolchain({ execFileImpl: fakeExec({ installOutput: 'installed' }).impl });
  assert.equal(already.started, false);
  assert.equal(already.alreadyInstalled, true);
  const failed = await installToolchain({ execFileImpl: fakeExec({ installOutput: 'fail' }).impl });
  assert.equal(failed.started, false);
  assert.match(failed.error, /something else/);
});

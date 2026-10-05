// WhatsApp connector installer: npm resolution per OS layout, the exact npm
// argv, error codes from npm's stderr, verification, atomic activation with
// rollback, the single-install lock — and the committed connector artifacts
// (pinned version, lockfile hygiene, no Baileys in any SynaBun manifest).
// Every process is scripted; nothing here touches the network.
process.env.SYNABUN_TYPESAFE = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONNECTOR_FILES, CONNECTOR_LOCK, CONNECTOR_NPMRC, NPM_CI_ARGS, STAGED_NAMES, createWhatsAppInstaller, lockDigest, mapNpmError, resolveNpmCli,
} from '../lib/whatsapp/installer.js';
import { RUNTIME_EXPORTS } from '../lib/whatsapp/baileys-adapter.js';

const CONNECTOR = fileURLToPath(new URL('../lib/whatsapp/connector/', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(CONNECTOR, 'manifest.json'), 'utf8'));
const POSIX_NOT_ROOT = process.platform !== 'win32' && process.getuid?.() !== 0;

function tempHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'synabun-wa-install-'));
  t.after(() => {
    try { chmodSync(join(dir, 'runtime'), 0o755); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * A scripted spawn: `npm` writes node_modules/baileys/package.json into its cwd
 * (unless told otherwise), the probe prints its JSON line.
 */
function scriptedSpawn({ npm = 'ok', probe = 'ok', npmStderr = '', npmExit = 1, beforeProbe } = {}) {
  const calls = [];
  const impl = (command, args, options) => {
    const call = { command, args: [...args], options };
    calls.push(call);
    const child = new EventEmitter();
    call.child = child;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kills = [];
    let closed = false;
    const close = (code, signal = null) => {
      if (closed) return;
      closed = true;
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, signal));
    };
    child.kill = (sig) => {
      child.kills.push(sig);
      close(null, sig);
      return true;
    };
    setImmediate(() => {
      if (args.includes('--probe')) {
        beforeProbe?.(call);
        if (probe === 'ok') child.stdout.write(`${JSON.stringify({ ok: true, version: MANIFEST.version })}\n`);
        else if (probe === 'wrong-version') child.stdout.write(`${JSON.stringify({ ok: true, version: '6.0.0' })}\n`);
        else child.stdout.write(`${JSON.stringify({ ok: false, error: 'makeWASocket missing for 15551234567' })}\n`);
        close(probe === 'ok' || probe === 'wrong-version' ? 0 : 1);
        return;
      }
      if (npm === 'hang') return;
      if (npm === 'ok' || npm === 'wrong-version') {
        const dir = join(options.cwd, 'node_modules', 'baileys');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'baileys', version: npm === 'ok' ? MANIFEST.version : '6.0.0' }));
        child.stdout.write('added 64 packages in 2s\n');
        child.stderr.write('npm warn deprecated something for +55 11 99999-8888\n');
        close(0);
        return;
      }
      child.stderr.write(npmStderr);
      close(npmExit);
    });
    return child;
  };
  return { impl, calls };
}

function installer(t, opts = {}) {
  const dataHome = opts.dataHome || tempHome(t);
  const npmCli = '/opt/node/lib/node_modules/npm/bin/npm-cli.js';
  const inst = createWhatsAppInstaller({
    dataHome,
    platform: 'darwin',
    execPath: '/opt/node/bin/node',
    env: { PATH: '/usr/bin', HOME: '/Users/ana', ANTHROPIC_API_KEY: 'sk-ant-secretsecretsecretsecret', npm_config_prefix: '/evil' },
    exists: (p) => p === npmCli,
    realpath: (p) => p,
    augmentedPath: () => '/opt/homebrew/bin:/usr/bin',
    hostPath: '/synabun/lib/whatsapp/host.js',
    ...opts,
  });
  return { inst, dataHome, npmCli };
}

test('committed connector: exact pin, clean lockfile, npmrc, manifest, entry exports', () => {
  const pkg = JSON.parse(readFileSync(join(CONNECTOR, 'package.json'), 'utf8'));
  assert.deepEqual(pkg, { name: 'synabun-whatsapp-connector', private: true, type: 'module', dependencies: { baileys: MANIFEST.version } });
  assert.match(MANIFEST.version, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/, 'an exact version, no range');
  assert.equal(MANIFEST.package, 'baileys');
  const lockText = readFileSync(join(CONNECTOR, CONNECTOR_LOCK), 'utf8');
  assert.equal(lockDigest(lockText), MANIFEST.lockSha256, 'manifest.lockSha256 matches the lockfile');
  assert.equal(lockDigest(lockText.replace(/\n/g, '\r\n')), MANIFEST.lockSha256, 'a CRLF checkout hashes the same');
  const lock = JSON.parse(lockText);
  assert.equal(lock.packages[''].dependencies.baileys, MANIFEST.version);
  assert.equal(lock.packages['node_modules/baileys'].version, MANIFEST.version);
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key) continue;
    assert.doesNotMatch(key, /(?:^|\/)(?:sharp|jimp|link-preview-js|qrcode-terminal|audio-decode)$/, `${key} must not be installed`);
    assert.ok(entry.integrity?.startsWith('sha512-'), `${key} has an integrity hash`);
    assert.ok(entry.resolved?.startsWith('https://registry.npmjs.org/'), `${key} comes from the registry (no git/URL deps)`);
  }
  assert.equal(readFileSync(join(CONNECTOR, '.npmrc'), 'utf8'), CONNECTOR_NPMRC);
  const entry = readFileSync(join(CONNECTOR, 'entry.mjs'), 'utf8');
  for (const name of RUNTIME_EXPORTS) assert.match(entry, new RegExp(`\\b${name},`), `entry.mjs exports ${name}`);
  assert.match(entry, /from 'baileys'/);
  // npm never publishes a package-lock.json (or .npmrc) inside a package: the lock ships as
  // npm-shrinkwrap.json and becomes package-lock.json in staging, where `npm ci` reads it.
  assert.equal(CONNECTOR_LOCK, 'npm-shrinkwrap.json');
  assert.deepEqual([...CONNECTOR_FILES], ['package.json', 'npm-shrinkwrap.json', 'entry.mjs', 'manifest.json']);
  assert.deepEqual({ ...STAGED_NAMES }, { 'npm-shrinkwrap.json': 'package-lock.json' });
  assert.equal(existsSync(join(CONNECTOR, 'package-lock.json')), false, 'no package-lock.json in the connector folder (npm would not ship it)');
});

test('no SynaBun package.json depends on baileys or libsignal', () => {
  for (const rel of ['package.json', 'neural-interface/package.json', 'mcp-server/package.json']) {
    const pkg = JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) {
      const deps = pkg[field] || {};
      const names = Array.isArray(deps) ? deps : Object.keys(deps);
      for (const bad of ['baileys', '@whiskeysockets/baileys', 'libsignal']) assert.ok(!names.includes(bad), `${rel} ${field} must not list ${bad}`);
    }
  }
});

test('resolveNpmCli: npm_execpath, Unix prefix layout, Windows layout (path.win32), PATH last', () => {
  const homebrew = resolveNpmCli({
    platform: 'darwin',
    execPath: '/opt/homebrew/bin/node',
    env: {},
    realpath: () => '/opt/homebrew/Cellar/node/24.1.0/bin/node',
    exists: (p) => p === '/opt/homebrew/Cellar/node/24.1.0/lib/node_modules/npm/bin/npm-cli.js',
    augmentedPath: () => '',
  });
  assert.deepEqual(homebrew, { command: '/opt/homebrew/bin/node', args: ['/opt/homebrew/Cellar/node/24.1.0/lib/node_modules/npm/bin/npm-cli.js'], shell: false, source: 'node-prefix' });

  const nvm = resolveNpmCli({
    platform: 'linux',
    execPath: '/home/ana/.nvm/versions/node/v22.5.1/bin/node',
    env: { npm_execpath: '/home/ana/.local/share/pnpm/pnpm.cjs' },
    realpath: (p) => p,
    exists: (p) => p === '/home/ana/.nvm/versions/node/v22.5.1/lib/node_modules/npm/bin/npm-cli.js',
    augmentedPath: () => '',
  });
  assert.deepEqual(nvm.args, ['/home/ana/.nvm/versions/node/v22.5.1/lib/node_modules/npm/bin/npm-cli.js'], 'a pnpm npm_execpath is ignored');

  const viaEnv = resolveNpmCli({
    platform: 'linux', execPath: '/usr/bin/node', env: { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' },
    realpath: (p) => p, exists: () => true, augmentedPath: () => '',
  });
  assert.equal(viaEnv.source, 'npm_execpath');

  const win = resolveNpmCli({
    platform: 'win32',
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    env: {},
    realpath: (p) => p,
    exists: (p) => p === 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
    augmentedPath: () => '',
  });
  assert.deepEqual(win, { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'], shell: false, source: 'node-dir' });

  const winPath = resolveNpmCli({
    platform: 'win32', execPath: 'D:\\tools\\node.exe', env: {}, realpath: (p) => p,
    exists: (p) => p === 'C:\\Users\\Ana\\AppData\\Roaming\\npm\\npm.cmd',
    augmentedPath: () => 'C:\\Windows;C:\\Users\\Ana\\AppData\\Roaming\\npm',
  });
  assert.deepEqual(winPath, { command: 'npm.cmd', args: [], shell: true, source: 'path' }, 'shell only on Windows');

  const posixPath = resolveNpmCli({
    platform: 'linux', execPath: '/snap/bin/node', env: {}, realpath: (p) => p,
    exists: (p) => p === '/usr/local/bin/npm', augmentedPath: () => '/usr/local/bin:/usr/bin',
  });
  assert.deepEqual(posixPath, { command: '/usr/local/bin/npm', args: [], shell: false, source: 'path' });

  assert.equal(resolveNpmCli({ platform: 'linux', execPath: '/x/node', env: {}, realpath: (p) => p, exists: () => false, augmentedPath: () => '/usr/bin' }), null);
});

test('mapNpmError: stderr → install codes', () => {
  const cases = [
    ['npm ERR! code ENOTFOUND\nnpm ERR! getaddrinfo ENOTFOUND registry.npmjs.org', 'OFFLINE'],
    ['npm error code ECONNRESET', 'OFFLINE'],
    ['npm error network request to https://registry.npmjs.org/baileys failed, reason: connect ETIMEDOUT', 'OFFLINE'],
    ['npm error code E403\nnpm error 403 Forbidden - GET https://registry.npmjs.org/baileys', 'REGISTRY_REFUSED'],
    ['npm error code E404 Not Found', 'REGISTRY_REFUSED'],
    ['npm error code SELF_SIGNED_CERT_IN_CHAIN', 'REGISTRY_REFUSED'],
    ['npm error code UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'REGISTRY_REFUSED'],
    ['npm error code ENOSPC\nnpm error syscall write', 'DISK_FULL'],
    ['npm error code EACCES\nnpm error syscall mkdir', 'NO_PERMISSION'],
    ['npm error code EPERM\nnpm error syscall open', 'NO_PERMISSION'],
    ["npm error EPERM: operation not permitted, rename 'C:\\x\\node_modules\\.staging'", 'FILE_IN_USE'],
    ['npm error code EBUSY resource busy or locked', 'FILE_IN_USE'],
    ['npm error code EINTEGRITY sha512-abc integrity checksum failed', 'VERIFY_FAILED'],
    ["Error: Cannot find module '/usr/lib/node_modules/npm/bin/npm-cli.js'", 'NPM_NOT_FOUND'],
    ['something else entirely', 'UNKNOWN'],
  ];
  for (const [stderr, code] of cases) assert.equal(mapNpmError(stderr), code, stderr);
});

test('install: exact npm argv, minimal env, staging → verify → activate; writes only runtime, log and npm cache', async (t) => {
  const spawn = scriptedSpawn();
  const { inst, dataHome, npmCli } = installer(t, { spawnImpl: spawn.impl });
  const progress = [];
  assert.equal(inst.status().installed, false);
  const res = await inst.install({ onProgress: (p) => progress.push(p) });
  assert.deepEqual(res, { ok: true, version: MANIFEST.version });
  const [npm, probe] = spawn.calls;
  assert.equal(npm.command, '/opt/node/bin/node');
  assert.deepEqual(npm.args, [npmCli, ...NPM_CI_ARGS]);
  assert.deepEqual(NPM_CI_ARGS, ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund']);
  assert.equal(npm.options.cwd, join(dataHome, 'runtime', 'whatsapp.staging'));
  assert.equal(npm.options.shell, false);
  assert.equal(npm.options.windowsHide, true);
  assert.equal(npm.options.env.npm_config_cache, join(dataHome, 'cache', 'npm'));
  assert.equal(npm.options.env.PATH, '/opt/homebrew/bin:/usr/bin');
  assert.equal(npm.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(npm.options.env.npm_config_prefix, undefined, 'parent npm config does not leak in');
  assert.deepEqual(probe.args, ['--disable-warning=ExperimentalWarning', '/synabun/lib/whatsapp/host.js', '--probe', '--runtime', join(dataHome, 'runtime', 'whatsapp.staging')]);
  assert.deepEqual([...new Set(progress.map((p) => p.stage))], ['checking', 'downloading', 'verifying', 'activating']);
  assert.ok(progress.some((p) => p.line === 'added 64 packages in 2s'));
  assert.ok(!progress.some((p) => /99999/.test(p.line || '')), 'lines are redacted');

  const runtime = join(dataHome, 'runtime', 'whatsapp');
  assert.equal(readFileSync(join(runtime, '.npmrc'), 'utf8'), CONNECTOR_NPMRC);
  assert.equal(readFileSync(join(runtime, 'package-lock.json'), 'utf8'), readFileSync(join(CONNECTOR, CONNECTOR_LOCK), 'utf8'), 'the lock is staged as package-lock.json for npm ci');
  assert.equal(existsSync(join(runtime, CONNECTOR_LOCK)), false, 'and only under that name');
  const installed = JSON.parse(readFileSync(join(runtime, '.installed.json'), 'utf8'));
  assert.equal(installed.version, MANIFEST.version);
  assert.equal(installed.lockSha256, MANIFEST.lockSha256);
  assert.ok(installed.entrySha256 && installed.installedAt);
  const st = inst.status();
  assert.deepEqual({ ...st, installedAt: !!st.installedAt }, {
    installed: true, version: MANIFEST.version, pinned: MANIFEST.version, outdated: false, path: runtime, installedAt: true, approxSizeMB: MANIFEST.approxSizeMB,
  });
  const files = listFiles(dataHome);
  const allowed = (f) => f.startsWith('runtime/whatsapp/') || f === 'data/whatsapp/install.log';
  assert.deepEqual(files.filter((f) => !allowed(f)), [], 'nothing outside the runtime folder and the install log');
  assert.ok(existsSync(join(dataHome, 'cache', 'npm')), 'the npm cache folder is ours');
  assert.deepEqual(readdirSync(join(dataHome, 'runtime')).sort(), ['whatsapp'], 'no staging or lock left behind');
  const tail = inst.logTail(20);
  assert.ok(tail.some((l) => l.includes('[downloading] added 64 packages')));
  assert.ok(tail.every((l) => !/99999/.test(l)));
});

test('install on Windows: node.exe + npm-cli.js beside it, no shell', async (t) => {
  const spawn = scriptedSpawn();
  const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  const { inst } = installer(t, {
    spawnImpl: spawn.impl,
    platform: 'win32',
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    env: { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', PATHEXT: '.COM;.EXE;.CMD', OPENAI_API_KEY: 'x' },
    exists: (p) => p === cli,
    augmentedPath: () => 'C:\\Users\\Ana\\AppData\\Roaming\\npm;C:\\Windows',
  });
  const res = await inst.install();
  assert.equal(res.ok, true, JSON.stringify(res));
  const [npm] = spawn.calls;
  assert.equal(npm.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(npm.args, [cli, ...NPM_CI_ARGS]);
  assert.equal(npm.options.shell, false);
  assert.equal(npm.options.env.SystemRoot, 'C:\\Windows');
  assert.equal(npm.options.env.PATHEXT, '.COM;.EXE;.CMD');
  assert.equal(npm.options.env.OPENAI_API_KEY, undefined);
});

test('install failures map to codes and keep the old install; staging is removed', async (t) => {
  const dataHome = tempHome(t);
  const runtime = join(dataHome, 'runtime', 'whatsapp');
  mkdirSync(join(runtime, 'node_modules', 'baileys'), { recursive: true });
  writeFileSync(join(runtime, 'entry.mjs'), '// old');
  writeFileSync(join(runtime, 'node_modules', 'baileys', 'package.json'), '{"version":"7.0.0-rc13"}');
  writeFileSync(join(runtime, '.installed.json'), JSON.stringify({ version: '7.0.0-rc13', lockSha256: 'old', installedAt: 'then' }));
  const before = inst0(t, dataHome).status();
  assert.deepEqual([before.installed, before.version, before.outdated], [true, '7.0.0-rc13', true], 'an older pin reads as outdated');

  const scenarios = [
    [{ npm: 'fail', npmStderr: 'npm error code ENOTFOUND\nnpm error getaddrinfo ENOTFOUND registry.npmjs.org\n' }, 'OFFLINE'],
    [{ npm: 'fail', npmStderr: 'npm error code E403\n403 Forbidden\n' }, 'REGISTRY_REFUSED'],
    [{ npm: 'fail', npmStderr: 'npm error code ENOSPC\n' }, 'DISK_FULL'],
    [{ npm: 'fail', npmStderr: 'npm error code EACCES\n' }, 'NO_PERMISSION'],
    [{ npm: 'fail', npmStderr: 'npm error code EBUSY resource busy or locked\n' }, 'FILE_IN_USE'],
    [{ npm: 'fail', npmStderr: 'weird\n' }, 'UNKNOWN'],
    [{ npm: 'wrong-version' }, 'VERIFY_FAILED'],
    [{ probe: 'fail' }, 'VERIFY_FAILED'],
    [{ probe: 'wrong-version' }, 'VERIFY_FAILED'],
  ];
  for (const [script, code] of scenarios) {
    const spawn = scriptedSpawn(script);
    const { inst } = installer(t, { dataHome, spawnImpl: spawn.impl });
    const res = await inst.install();
    assert.deepEqual([res.ok, res.code], [false, code], JSON.stringify(script));
    assert.ok(res.message);
    assert.doesNotMatch(res.message, /15551234567/);
    assert.equal(readFileSync(join(runtime, 'entry.mjs'), 'utf8'), '// old', 'the old install is untouched');
    assert.equal(existsSync(join(dataHome, 'runtime', 'whatsapp.staging')), false, 'staging removed');
    assert.equal(existsSync(join(dataHome, 'runtime', 'whatsapp.install.lock')), false, 'lock released');
  }
});

function inst0(t, dataHome) {
  return installer(t, { dataHome, spawnImpl: () => { throw new Error('no spawn expected'); } }).inst;
}

test('activation failure puts the old install back', { skip: !POSIX_NOT_ROOT && 'needs POSIX permissions as a non-root user' }, async (t) => {
  const dataHome = tempHome(t);
  const runtimeRoot = join(dataHome, 'runtime');
  const runtime = join(runtimeRoot, 'whatsapp');
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, 'entry.mjs'), '// old');
  const spawn = scriptedSpawn({ beforeProbe: () => chmodSync(runtimeRoot, 0o555) });
  const { inst } = installer(t, { dataHome, spawnImpl: spawn.impl });
  const res = await inst.install();
  chmodSync(runtimeRoot, 0o755);
  assert.deepEqual([res.ok, res.code], [false, 'NO_PERMISSION']);
  assert.equal(readFileSync(join(runtime, 'entry.mjs'), 'utf8'), '// old');
});

test('timeout, abort, busy lock, stale lock, missing npm, tampered lockfile', async (t) => {
  const hang = scriptedSpawn({ npm: 'hang' });
  const slow = installer(t, { spawnImpl: hang.impl, timeoutMs: 150 });
  const timedOut = await slow.inst.install();
  assert.deepEqual([timedOut.ok, timedOut.code], [false, 'TIMEOUT']);
  assert.deepEqual(hang.calls[0].child.kills, ['SIGTERM'], 'the hung npm is terminated');

  const hang2 = scriptedSpawn({ npm: 'hang' });
  const ab = installer(t, { spawnImpl: hang2.impl });
  const ctrl = new AbortController();
  const pending = ab.inst.install({ signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 50);
  const aborted = await pending;
  assert.deepEqual([aborted.ok, aborted.code], [false, 'ABORTED']);

  const busyHome = tempHome(t);
  mkdirSync(join(busyHome, 'runtime'), { recursive: true });
  writeFileSync(join(busyHome, 'runtime', 'whatsapp.install.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const busy = await installer(t, { dataHome: busyHome, spawnImpl: scriptedSpawn().impl }).inst.install();
  assert.deepEqual([busy.ok, busy.code], [false, 'INSTALL_BUSY']);
  assert.ok(existsSync(join(busyHome, 'runtime', 'whatsapp.install.lock')), 'a live lock is never broken');

  writeFileSync(join(busyHome, 'runtime', 'whatsapp.install.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: 'x' }));
  const stale = await installer(t, { dataHome: busyHome, spawnImpl: scriptedSpawn().impl }).inst.install();
  assert.equal(stale.ok, true, 'a lock whose owner is dead is broken');

  const noNpm = await installer(t, { spawnImpl: scriptedSpawn().impl, exists: () => false, augmentedPath: () => '' }).inst.install();
  assert.deepEqual([noNpm.ok, noNpm.code], [false, 'NPM_NOT_FOUND']);

  const tampered = mkdtempSync(join(tmpdir(), 'synabun-wa-connector-'));
  t.after(() => rmSync(tampered, { recursive: true, force: true }));
  cpSync(CONNECTOR, tampered, { recursive: true });
  writeFileSync(join(tampered, CONNECTOR_LOCK), readFileSync(join(CONNECTOR, CONNECTOR_LOCK), 'utf8').replace('"lockfileVersion": 3', '"lockfileVersion": 3, "x": 1'));
  const spawn = scriptedSpawn();
  const bad = await installer(t, { connectorDir: tampered, spawnImpl: spawn.impl }).inst.install();
  assert.deepEqual([bad.ok, bad.code], [false, 'VERIFY_FAILED']);
  assert.equal(spawn.calls.length, 0, 'nothing is downloaded for a lockfile that does not match its manifest');
});

test('fake mode reports installed without touching npm; uninstall removes only the runtime folders', async (t) => {
  const dataHome = tempHome(t);
  const fakeInst = createWhatsAppInstaller({ dataHome, env: { SYNABUN_WHATSAPP_FAKE: '1' }, spawnImpl: () => { throw new Error('no spawn'); } });
  assert.deepEqual(fakeInst.status(), { installed: true, version: 'fake', pinned: MANIFEST.version, outdated: false, path: null, installedAt: null, approxSizeMB: MANIFEST.approxSizeMB });
  assert.deepEqual(await fakeInst.install(), { ok: true, version: 'fake' });
  assert.deepEqual(await fakeInst.verify(), { ok: true, version: 'fake' });

  const spawn = scriptedSpawn();
  const { inst } = installer(t, { dataHome, spawnImpl: spawn.impl });
  assert.equal((await inst.install()).ok, true);
  mkdirSync(join(dataHome, 'data', 'keep'), { recursive: true });
  writeFileSync(join(dataHome, 'data', 'keep', 'memory.db'), 'x');
  assert.deepEqual(await inst.uninstall(), { ok: true });
  assert.equal(existsSync(join(dataHome, 'runtime', 'whatsapp')), false);
  assert.equal(readFileSync(join(dataHome, 'data', 'keep', 'memory.db'), 'utf8'), 'x');
  assert.equal(inst.status().installed, false);
  const v = await inst.verify();
  assert.deepEqual([v.ok, v.code], [false, 'VERIFY_FAILED']);
});

test('the real host.js --probe fails cleanly on a folder without a connector', async (t) => {
  const dataHome = tempHome(t);
  const empty = join(dataHome, 'runtime', 'whatsapp');
  mkdirSync(join(empty, 'node_modules', 'baileys'), { recursive: true });
  writeFileSync(join(empty, 'entry.mjs'), 'export const nothing = 1;\n');
  writeFileSync(join(empty, 'node_modules', 'baileys', 'package.json'), '{}');
  writeFileSync(join(empty, '.installed.json'), JSON.stringify({ version: MANIFEST.version, lockSha256: MANIFEST.lockSha256 }));
  const inst = createWhatsAppInstaller({ dataHome, env: { PATH: process.env.PATH } });
  const res = await inst.verify();
  assert.deepEqual([res.ok, res.code], [false, 'VERIFY_FAILED']);
  assert.match(res.message, /lacks makeWASocket/);
});

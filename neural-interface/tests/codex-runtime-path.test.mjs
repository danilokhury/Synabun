import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  codexPlatformTarget,
  resolveTrustedWindowsCodexBinary,
  selectWindowsCodexLauncher,
  windowsCodexPackageJsonCandidates,
} from '../lib/codex-runtime-path.js';

function fakeExists(paths) {
  const normalized = new Set(paths.map((value) => value.toLowerCase()));
  return (value) => normalized.has(String(value).toLowerCase());
}

test('Windows target mapping supports x64 and arm64 only', () => {
  assert.deepEqual(codexPlatformTarget('win32', 'x64'), {
    targetTriple: 'x86_64-pc-windows-msvc',
    platformPackage: '@openai/codex-win32-x64',
    binaryName: 'codex.exe',
  });
  assert.deepEqual(codexPlatformTarget('win32', 'arm64'), {
    targetTriple: 'aarch64-pc-windows-msvc',
    platformPackage: '@openai/codex-win32-arm64',
    binaryName: 'codex.exe',
  });
  assert.equal(codexPlatformTarget('win32', 'ia32'), null);
});

test('Windows package candidates do not depend on the inherited PATH', () => {
  assert.deepEqual(windowsCodexPackageJsonCandidates({
    npmRoots: [String.raw`D:\npm-global\node_modules`],
    appData: String.raw`C:\Users\Lukas\AppData\Roaming`,
    npmConfigPrefix: String.raw`E:\custom npm`,
    synabunPackageRoot: String.raw`C:\Users\Lukas\AppData\Roaming\npm\node_modules\synabun`,
    nodeExecutable: String.raw`C:\Program Files\nodejs\node.exe`,
  }), [
    String.raw`D:\npm-global\node_modules\@openai\codex\package.json`,
    String.raw`C:\Users\Lukas\AppData\Roaming\npm\node_modules\@openai\codex\package.json`,
    String.raw`E:\custom npm\node_modules\@openai\codex\package.json`,
    String.raw`C:\Program Files\nodejs\node_modules\@openai\codex\package.json`,
  ]);
});

test('resolver prefers a direct executable over npm launchers', () => {
  const exe = String.raw`C:\Tools\Codex\codex.exe`;
  const result = resolveTrustedWindowsCodexBinary({
    launchers: [
      String.raw`C:\Users\Lukas\AppData\Roaming\npm\codex`,
      String.raw`C:\Users\Lukas\AppData\Roaming\npm\codex.cmd`,
      exe,
    ],
    arch: 'x64',
    exists: fakeExists([exe]),
  });
  assert.equal(result.path, exe);
  assert.equal(result.source, 'path-exe');
});

test('sidepanel launcher selection prefers the cmd launcher over the extensionless npm shim', () => {
  const bare = String.raw`C:\Users\Lukas\AppData\Roaming\npm\codex`;
  const cmd = `${bare}.cmd`;
  assert.equal(selectWindowsCodexLauncher([bare, cmd]), cmd);
});

test('sidepanel launcher selection applies trust filtering before choosing a launcher', () => {
  const bundled = String.raw`C:\SynaBun\node_modules\.bin\codex.cmd`;
  const globalBare = String.raw`C:\Users\Lukas\AppData\Roaming\npm\codex`;
  const globalCmd = `${globalBare}.cmd`;
  assert.equal(
    selectWindowsCodexLauncher(
      [bundled, globalBare, globalCmd],
      (candidate) => !candidate.startsWith(String.raw`C:\SynaBun`),
    ),
    globalCmd,
  );
});

test('resolver follows a global npm cmd launcher to the current platform package exe layout', () => {
  const launcher = String.raw`C:\Users\Lukas\AppData\Roaming\npm\codex.cmd`;
  const codexPackage = String.raw`C:\Users\Lukas\AppData\Roaming\npm\node_modules\@openai\codex\package.json`;
  const platformPackage = String.raw`C:\Users\Lukas\AppData\Roaming\npm\node_modules\@openai\codex-win32-x64\package.json`;
  const binary = String.raw`C:\Users\Lukas\AppData\Roaming\npm\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`;
  const result = resolveTrustedWindowsCodexBinary({
    launchers: [String.raw`C:\Users\Lukas\AppData\Roaming\npm\codex`, launcher],
    arch: 'x64',
    exists: fakeExists([launcher, codexPackage, platformPackage, binary]),
    resolvePlatformPackage(packageJsonPath, packageName) {
      assert.equal(packageJsonPath, codexPackage);
      assert.equal(packageName, '@openai/codex-win32-x64');
      return platformPackage;
    },
  });
  assert.equal(result.path, binary);
  assert.equal(result.source, 'global-platform-package');
});

test('resolver still supports the legacy codex vendor directory', () => {
  const codexPackage = String.raw`C:\Users\Lukas\AppData\Roaming\npm\node_modules\@openai\codex\package.json`;
  const platformPackage = String.raw`C:\Users\Lukas\AppData\Roaming\npm\node_modules\@openai\codex-win32-x64\package.json`;
  const binary = String.raw`C:\Users\Lukas\AppData\Roaming\npm\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\codex\codex.exe`;
  const result = resolveTrustedWindowsCodexBinary({
    codexPackageJsonPaths: [codexPackage],
    arch: 'x64',
    exists: fakeExists([codexPackage, platformPackage, binary]),
    resolvePlatformPackage() {
      throw new Error('package exports blocked resolution');
    },
  });
  assert.equal(result.path, binary);
  assert.equal(result.source, 'global-platform-package');
});

test('resolver prefers the current bin vendor directory when both layouts exist', () => {
  const codexPackage = String.raw`C:\Users\Lukas\AppData\Roaming\npm\node_modules\@openai\codex\package.json`;
  const currentBinary = String.raw`C:\Users\Lukas\AppData\Roaming\npm\node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\bin\codex.exe`;
  const legacyBinary = String.raw`C:\Users\Lukas\AppData\Roaming\npm\node_modules\@openai\codex\vendor\x86_64-pc-windows-msvc\codex\codex.exe`;
  const result = resolveTrustedWindowsCodexBinary({
    codexPackageJsonPaths: [codexPackage],
    arch: 'x64',
    exists: fakeExists([codexPackage, currentBinary, legacyBinary]),
  });
  assert.equal(result.path, currentBinary);
  assert.equal(result.source, 'global-package-vendor');
});

test('resolver skips a rejected bundled exe and continues to the global package', () => {
  const bundled = String.raw`C:\Synabun\node_modules\@openai\codex-win32-x64\codex.exe`;
  const launcher = String.raw`C:\Users\Lukas\AppData\Roaming\npm\codex.cmd`;
  const codexPackage = String.raw`C:\Users\Lukas\AppData\Roaming\npm\node_modules\@openai\codex\package.json`;
  const platformPackage = String.raw`C:\Users\Lukas\AppData\Roaming\npm\node_modules\@openai\codex-win32-x64\package.json`;
  const globalBinary = String.raw`C:\Users\Lukas\AppData\Roaming\npm\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\codex\codex.exe`;
  const result = resolveTrustedWindowsCodexBinary({
    launchers: [bundled, launcher],
    arch: 'x64',
    exists: fakeExists([bundled, launcher, codexPackage, platformPackage, globalBinary]),
    acceptBinary: (candidate) => !candidate.startsWith(String.raw`C:\Synabun`),
    resolvePlatformPackage: () => platformPackage,
  });
  assert.equal(result.path, globalBinary);
  assert.equal(result.source, 'global-platform-package');
});

test('resolver supports a package-local vendor payload and paths with spaces', () => {
  const packageJson = String.raw`C:\Users\Lukas\App Data\npm\node_modules\@openai\codex\package.json`;
  const binary = String.raw`C:\Users\Lukas\App Data\npm\node_modules\@openai\codex\vendor\aarch64-pc-windows-msvc\codex\codex.exe`;
  const result = resolveTrustedWindowsCodexBinary({
    codexPackageJsonPaths: [packageJson],
    arch: 'arm64',
    exists: fakeExists([packageJson, binary]),
    resolvePlatformPackage() {
      throw new Error('optional package is not hoisted');
    },
  });
  assert.equal(result.path, binary);
  assert.equal(result.source, 'global-package-vendor');
});

test('resolver never treats extensionless or cmd launchers as spawnable binaries', () => {
  const launcher = String.raw`C:\Users\Lukas\AppData\Roaming\npm\codex.cmd`;
  const result = resolveTrustedWindowsCodexBinary({
    launchers: [launcher, launcher.slice(0, -4)],
    arch: 'x64',
    exists: fakeExists([launcher]),
  });
  assert.equal(result.path, null);
  assert.match(result.reason, /No spawnable codex\.exe/);
  assert.ok(result.checked.some((value) => /@openai\\codex\\package\.json$/i.test(value)));
});

test('installed Windows global Codex resolves to a runnable native executable', {
  skip: process.platform !== 'win32' || process.env.SYNABUN_WINDOWS_CODEX_SMOKE !== '1',
}, () => {
  const lookup = spawnSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true });
  assert.equal(lookup.status, 0, lookup.stderr);
  const launchers = String(lookup.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const npmRootProbe = spawnSync(process.env.ComSpec || process.env.COMSPEC || 'cmd.exe', [
    '/d', '/s', '/c', 'npm root -g',
  ], { encoding: 'utf8', windowsHide: true });
  assert.equal(npmRootProbe.status, 0, npmRootProbe.stderr);
  const npmRoots = String(npmRootProbe.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const codexPackageJsonPaths = windowsCodexPackageJsonCandidates({
    npmRoots,
    appData: process.env.APPDATA,
    npmConfigPrefix: process.env.NPM_CONFIG_PREFIX || process.env.npm_config_prefix,
    nodeExecutable: process.execPath,
  });
  const resolved = resolveTrustedWindowsCodexBinary({
    launchers,
    codexPackageJsonPaths,
    arch: process.arch,
  });
  assert.match(resolved.path || '', /codex\.exe$/i, resolved.reason);
  const withoutPath = resolveTrustedWindowsCodexBinary({
    codexPackageJsonPaths,
    arch: process.arch,
  });
  assert.equal(withoutPath.path, resolved.path);
  const version = spawnSync(resolved.path, ['--version'], { encoding: 'utf8', windowsHide: true });
  assert.equal(version.status, 0, version.stderr);
  assert.match(`${version.stdout}\n${version.stderr}`, /codex/i);
});

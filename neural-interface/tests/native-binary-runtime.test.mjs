import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  SDK_PKG,
  ensureExecutable,
  resolveClaudeExecutableOverride,
  vendoredBinaryTargets,
  ensureVendoredExecutables,
  isNativeBinaryLaunchFailure,
  diagnoseLaunchFailure,
} from '../lib/native-binary-runtime.js';
import * as runtime from '../lib/native-binary-runtime.js';

// ── helpers ─────────────────────────────────────────────────────────────────

function fakeExists(paths) {
  const set = new Set(paths.map((v) => String(v).toLowerCase()));
  return (v) => set.has(String(v).toLowerCase());
}

// resolve() that maps a request specifier to a fake absolute path, and throws
// MODULE_NOT_FOUND for anything not listed (like a missing optional dep).
function fakeResolve(installed) {
  return (specifier) => {
    if (!installed.includes(specifier)) {
      const err = new Error(`Cannot find module '${specifier}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return `/nm/${specifier}`;
  };
}

function fakeStat(mode, { isFile = true } = {}) {
  return () => ({ mode, isFile: () => isFile });
}

function statThrows(code) {
  return () => { const e = new Error(code); e.code = code; throw e; };
}

function recordChmod() {
  const calls = [];
  const fn = (p, mode) => calls.push({ path: p, mode });
  fn.calls = calls;
  return fn;
}

function chmodThrows(code) {
  const fn = () => { const e = new Error(`${code}: permission denied`); e.code = code; throw e; };
  fn.calls = [];
  return fn;
}

const accessOk = () => {};
const accessThrows = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };

// ── nothing embedded ────────────────────────────────────────────────────────

test('this module no longer resolves, repairs or falls back to an executable inside the SDK', () => {
  // Claude Code is the user's own installation (lib/claude-executable.js). The
  // functions that found and repaired the copy the SDK used to bring are gone,
  // so nothing can quietly run one again.
  for (const name of ['claudeRuntime', 'resolveSdkBinary', 'sdkBinaryCandidates', 'planRuntimeRecovery', 'clearNativeBinaryCache', 'SDK_PLATFORM_PACKAGES', 'detectMusl']) {
    assert.equal(runtime[name], undefined, name);
  }
});

test('the installed Agent SDK carries no Claude Code executable, and says so itself', () => {
  const require = createRequire(import.meta.url);
  const sdkDir = dirname(require.resolve(SDK_PKG));
  const scope = dirname(sdkDir);
  // The SDK names the packages that would hold its executable; none is installed.
  const sdkPkg = JSON.parse(require('node:fs').readFileSync(join(sdkDir, 'package.json'), 'utf8'));
  const platformPackages = Object.keys(sdkPkg.optionalDependencies || {});
  assert.ok(platformPackages.length >= 6, 'the SDK still declares its per-platform packages');
  for (const name of platformPackages) {
    assert.equal(existsSync(join(scope, name.split('/')[1])), false, `${name} is installed: SynaBun must not carry Claude Code`);
    assert.throws(() => require.resolve(`${name}/package.json`), /Cannot find module/, name);
  }
});

// ── ensureExecutable ────────────────────────────────────────────────────────

test('a 0644 binary is repaired to 0755 and reported as repaired', () => {
  const chmod = recordChmod();
  const r = ensureExecutable('/nm/claude', {
    platform: 'darwin', stat: fakeStat(0o100644), chmod, access: accessOk,
  });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'repaired');
  assert.equal(r.repaired, true);
  assert.equal(chmod.calls.length, 1);
  assert.equal(chmod.calls[0].mode, 0o100644 | 0o755);
  assert.equal(r.repairCommand, 'chmod +x "/nm/claude"');
});

test('an already-executable binary is left alone', () => {
  const chmod = recordChmod();
  const r = ensureExecutable('/nm/claude', {
    platform: 'darwin', stat: fakeStat(0o100755), chmod, access: accessOk,
  });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'ok');
  assert.equal(r.repaired, false);
  assert.equal(chmod.calls.length, 0);
});

test('a missing binary reports missing and never throws', () => {
  const r = ensureExecutable('/nm/claude', {
    platform: 'darwin', stat: statThrows('ENOENT'), chmod: recordChmod(), access: accessOk,
  });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'missing');
});

test('a directory is rejected as not-a-file', () => {
  const r = ensureExecutable('/nm/claude', {
    platform: 'darwin', stat: fakeStat(0o040755, { isFile: false }), chmod: recordChmod(), access: accessOk,
  });
  assert.equal(r.state, 'not-a-file');
});

test('a read-only install reports chmod-failed with a sudo-able repair command', () => {
  const r = ensureExecutable('/nm/claude', {
    platform: 'linux', stat: fakeStat(0o100644), chmod: chmodThrows('EROFS'), access: accessOk,
  });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'chmod-failed');
  assert.equal(r.repairCommand, 'chmod +x "/nm/claude"');
  assert.match(r.error, /EROFS/);
});

test('X_OK failure is caught even when the mode mask looked fine', () => {
  // Root-owned 0711: `mode & 0o111` passes, but we still cannot execute it.
  const chmod = recordChmod();
  const r = ensureExecutable('/nm/claude', {
    platform: 'linux', stat: fakeStat(0o100711), chmod, access: accessThrows,
  });
  assert.equal(r.ok, false);
  assert.equal(r.state, 'access-denied');
  assert.equal(chmod.calls.length, 0, 'must not chmod when the mask already passes');
});

test('windows never chmods and judges launchability by name', () => {
  const chmod = recordChmod();
  const opts = { platform: 'win32', stat: fakeStat(0o100644), chmod, access: accessOk };

  assert.equal(ensureExecutable('C:\\p\\claude.exe', opts).state, 'ok');
  assert.equal(ensureExecutable('C:\\p\\cli.js', opts).state, 'script');

  const cmd = ensureExecutable('C:\\npm\\claude.cmd', opts);
  assert.equal(cmd.ok, false);
  assert.equal(cmd.state, 'windows-bad-name');
  assert.match(cmd.reason, /shell:false/);

  assert.equal(ensureExecutable('C:\\npm\\claude', opts).state, 'windows-bad-name');
  assert.equal(chmod.calls.length, 0, 'chmod is meaningless on win32');
});

// ── override contract ───────────────────────────────────────────────────────

test('no override is not an error: the installed Claude Code is used instead', () => {
  const r = resolveClaudeExecutableOverride(null);
  assert.deepEqual(r, { path: null, kind: null, ok: true, reason: null });
  assert.deepEqual(resolveClaudeExecutableOverride('   '), { path: null, kind: null, ok: true, reason: null });
});

test('a .js override is accepted without an execute-bit check', () => {
  const chmod = recordChmod();
  const r = resolveClaudeExecutableOverride('/opt/claude/cli.js', {
    platform: 'linux', exists: fakeExists(['/opt/claude/cli.js']), chmod,
  });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'script');
  assert.equal(chmod.calls.length, 0, 'scripts are launched via node, no +x needed');
});

test('a .cjs override is native and DOES get the execute-bit check', () => {
  // Regression: the previous bridge gate /\.[cm]?js$/i treated .cjs as a script,
  // but the SDK's isNativeBinary list omits .cjs — it is spawned directly.
  const chmod = recordChmod();
  const r = resolveClaudeExecutableOverride('/opt/claude/cli.cjs', {
    platform: 'linux', stat: fakeStat(0o100644), chmod, access: accessOk,
  });
  assert.equal(r.kind, 'native');
  assert.equal(r.ok, true);
  assert.equal(chmod.calls.length, 1, '.cjs is spawned directly and must be executable');
});

test('a native override is repaired and accepted', () => {
  const chmod = recordChmod();
  const r = resolveClaudeExecutableOverride('/usr/local/bin/claude', {
    platform: 'darwin', stat: fakeStat(0o100644), chmod, access: accessOk,
  });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'native');
  assert.equal(r.repaired, true);
  assert.equal(r.path, '/usr/local/bin/claude');
});

test('a bare command name is rejected', () => {
  // getClaudeBin()'s last resort is the literal string 'claude'. Handing that to
  // pathToClaudeCodeExecutable under spawn(shell:false) is a guaranteed ENOENT —
  // a worse failure than the one being recovered from.
  const r = resolveClaudeExecutableOverride('claude', { platform: 'darwin' });
  assert.equal(r.ok, false);
  assert.equal(r.path, null);
  assert.match(r.reason, /bare command name/i);
});

test('a windows .cmd shim override is rejected', () => {
  const r = resolveClaudeExecutableOverride('C:\\npm\\claude.cmd', {
    platform: 'win32', stat: fakeStat(0o100644), chmod: recordChmod(), access: accessOk,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /shell:false/);
});

test('a missing script override is rejected rather than passed through', () => {
  const r = resolveClaudeExecutableOverride('/gone/cli.js', {
    platform: 'linux', exists: fakeExists([]),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not found/i);
});

// ── vendored sweep ──────────────────────────────────────────────────────────

function sweepFixture() {
  const tree = {
    '/app/node_modules/node-pty/prebuilds': ['darwin-arm64', 'darwin-x64', 'linux-arm', 'win32-x64'],
    // What an install that predates the rule could still hold: never swept.
    '/app/node_modules/@anthropic-ai': ['claude-agent-sdk', 'claude-agent-sdk-darwin-arm64'],
    '/app/node_modules/@openai': ['codex-darwin-arm64', 'codex-sdk'],
    '/app/node_modules/@openai/codex-darwin-arm64/vendor': ['aarch64-apple-darwin'],
  };
  const files = [
    '/app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    '/app/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
    '/app/node_modules/node-pty/prebuilds/linux-arm/spawn-helper',
    '/app/node_modules/node-pty/build/Release/spawn-helper',
    '/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    '/app/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
    '/app/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/path/rg',
  ];
  return {
    files,
    readdir: (dir) => tree[String(dir)] || [],
    exists: fakeExists(files),
  };
}

test('the sweep enumerates SynaBun\'s own helpers, including dirs a hardcoded list would miss', () => {
  const { readdir, exists } = sweepFixture();
  const targets = vendoredBinaryTargets({ root: '/app', platform: 'linux', exists, readdir });
  const paths = targets.map((t) => t.path);

  // The old hardcoded list in rebuild-pty.js knew only darwin-{arm64,x64} and
  // linux-{x64,arm64} — linux-arm would have been skipped.
  assert.deepEqual(paths.sort(), [
    '/app/node_modules/node-pty/build/Release/spawn-helper',
    '/app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    '/app/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
    '/app/node_modules/node-pty/prebuilds/linux-arm/spawn-helper',
  ]);
  assert.ok(targets.every((t) => t.kind === 'pty-spawn-helper'));
});

test('the sweep never touches an agent tool, even one an older install left behind', () => {
  const { readdir, exists } = sweepFixture();
  const chmod = recordChmod();
  const r = ensureVendoredExecutables({
    root: '/app', platform: 'darwin', exists, readdir, stat: fakeStat(0o100644), chmod, access: accessOk,
  });
  assert.equal(r.checked, 4);
  for (const call of chmod.calls) assert.doesNotMatch(call.path, /claude|codex|\/rg$/, call.path);
  assert.equal(chmod.calls.length, 4);
});

test('the sweep repairs only the binaries that need it', () => {
  const { readdir, exists } = sweepFixture();
  const needsRepair = new Set([
    '/app/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
    '/app/node_modules/node-pty/build/Release/spawn-helper',
  ]);
  const chmod = recordChmod();
  const r = ensureVendoredExecutables({
    root: '/app',
    platform: 'darwin',
    exists,
    readdir,
    stat: (p) => ({ mode: needsRepair.has(String(p)) ? 0o100644 : 0o100755, isFile: () => true }),
    chmod,
    access: accessOk,
  });

  assert.equal(r.repaired.length, 2);
  assert.deepEqual(new Set(r.repaired), needsRepair);
  assert.equal(r.failed.length, 0);
  assert.equal(chmod.calls.length, 2);
});

test('the sweep is a no-op on windows but still enumerates', () => {
  const { readdir, exists } = sweepFixture();
  const chmod = recordChmod();
  const r = ensureVendoredExecutables({
    root: '/app', platform: 'win32', exists, readdir, stat: fakeStat(0o100644), chmod, access: accessOk,
  });
  assert.equal(r.skipped, 'win32');
  assert.equal(chmod.calls.length, 0);
  assert.ok(r.checked > 0);
});

test('one unrepairable target does not abort the rest of the sweep', () => {
  const { readdir, exists } = sweepFixture();
  const blocked = '/app/node_modules/node-pty/prebuilds/linux-arm/spawn-helper';
  const r = ensureVendoredExecutables({
    root: '/app',
    platform: 'linux',
    exists,
    readdir,
    stat: fakeStat(0o100644),
    chmod: (p) => { if (String(p) === blocked) { const e = new Error('EROFS'); e.code = 'EROFS'; throw e; } },
    access: accessOk,
  });
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].path, blocked);
  assert.equal(r.repaired.length, 3, 'every other binary is still repaired');
});

test('the sweep tolerates a missing node_modules tree', () => {
  const r = ensureVendoredExecutables({
    root: '/nope', platform: 'linux', exists: fakeExists([]), readdir: () => { throw new Error('ENOENT'); },
  });
  assert.equal(r.checked, 0);
  assert.equal(r.repaired.length, 0);
  assert.equal(r.failed.length, 0);
});

// ── failure detection ───────────────────────────────────────────────────────

test('the SDK ReferenceError is recognised as a launch failure', () => {
  const err = ReferenceError(
    'Claude Code native binary at /nm/claude exists but failed to launch. This usually means the '
    + "binary does not match this system's libc — e.g. spawning a musl-linked binary on a glibc "
    + 'Linux host fails because the musl dynamic loader (/lib/ld-musl-*) is missing. Specify a '
    + 'matching binary with options.pathToClaudeCodeExecutable.',
  );
  assert.equal(isNativeBinaryLaunchFailure(err), true);
});

test('raw spawn errors are recognised by code and by message', () => {
  const withCode = new Error('spawn failed'); withCode.code = 'EACCES';
  assert.equal(isNativeBinaryLaunchFailure(withCode), true);
  assert.equal(isNativeBinaryLaunchFailure(new Error('spawn /nm/claude EACCES')), true);
  assert.equal(isNativeBinaryLaunchFailure(new Error('Native CLI binary for linux-x64 not found.')), true);
  assert.equal(isNativeBinaryLaunchFailure(new Error('spawn ENOEXEC')), true);
});

test('session-recovery errors are NOT treated as launch failures', () => {
  // This path belongs to the bridge's _recoverLostSession; stealing it would
  // break resume handling.
  assert.equal(isNativeBinaryLaunchFailure(new Error('No conversation found with session ID abc')), false);
  assert.equal(isNativeBinaryLaunchFailure(new Error('API rate limit exceeded')), false);
  assert.equal(isNativeBinaryLaunchFailure(null), false);
});

// ── diagnosis ───────────────────────────────────────────────────────────────
// What is diagnosed is the user's Claude Code, at the path the SDK was given.

const libcError = ReferenceError('Claude Code native binary at /home/u/.local/bin/claude exists but failed to launch. This usually means the binary does not match this system\'s libc');

test('no executable, or one that is gone, keeps the panel install phrase', () => {
  const none = diagnoseLaunchFailure({ err: new Error('Native CLI binary for linux-x64 not found.'), executable: null, platform: 'linux' });
  assert.equal(none.kind, 'missing');
  // ui-claude-panel.js shows its install help on this exact phrase.
  assert.match(none.message, /Claude CLI not found/);
  assert.match(none.message, /installed separately from SynaBun/);

  const gone = diagnoseLaunchFailure({ err: new Error('spawn ENOENT'), executable: '/home/u/.local/bin/claude', platform: 'linux', stat: statThrows('ENOENT') });
  assert.equal(gone.kind, 'missing');
  assert.match(gone.message, /Claude CLI not found at \/home\/u\/\.local\/bin\/claude/);
  assert.doesNotMatch(gone.message, /bundled|--include=optional|libc/i);

  const folder = diagnoseLaunchFailure({ err: new Error('EACCES'), executable: '/opt/claude', platform: 'darwin', stat: fakeStat(0o40755, { isFile: false }) });
  assert.equal(folder.kind, 'missing');
  assert.match(folder.message, /is not a file/);
});

test('a missing execute bit is a permission problem, with the command that fixes it', () => {
  const dx = diagnoseLaunchFailure({ err: libcError, executable: '/home/u/my tools/claude', platform: 'darwin', stat: fakeStat(0o100644), access: accessThrows });
  assert.equal(dx.kind, 'exec-bit');
  assert.equal(dx.repairCommand, 'chmod +x "/home/u/my tools/claude"');
  assert.match(dx.message, /not a libc mismatch/);
  assert.match(dx.message, /chmod \+x "\/home\/u\/my tools\/claude"/);
});

test('an executable-but-failing Claude Code blames Gatekeeper on macOS and libc on Linux', () => {
  const mac = diagnoseLaunchFailure({ err: libcError, executable: '/opt/homebrew/bin/claude', platform: 'darwin', arch: 'arm64', stat: fakeStat(0o100755), access: accessOk });
  assert.equal(mac.kind, 'gatekeeper');
  assert.match(mac.repairCommand, /^xattr -d com\.apple\.quarantine "\/opt\/homebrew\/bin\/claude"$/);
  assert.match(mac.message, /arm64/);

  const linux = diagnoseLaunchFailure({ err: libcError, executable: '/home/u/.local/bin/claude', platform: 'linux', stat: fakeStat(0o100755), access: accessOk });
  assert.equal(linux.kind, 'libc');
  assert.match(linux.message, /musl/);
  assert.match(linux.message, /Reinstall Claude Code/);
});

test('a windows command file is diagnosed as one the SDK cannot start', () => {
  const dx = diagnoseLaunchFailure({ err: new Error('spawn EINVAL'), executable: 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\claude.cmd', platform: 'win32', stat: fakeStat(0o100666) });
  assert.equal(dx.kind, 'shim');
  assert.match(dx.message, /sdkExecutable/);
  // A real executable that still failed keeps the SDK's own words.
  const exe = diagnoseLaunchFailure({ err: new Error('spawn UNKNOWN'), executable: 'C:\\Users\\u\\.local\\bin\\claude.exe', platform: 'win32', stat: fakeStat(0o100666) });
  assert.equal(exe.kind, 'unknown');
  assert.equal(exe.message, 'spawn UNKNOWN');
});

test('a script is never asked for an execute bit', () => {
  const dx = diagnoseLaunchFailure({ err: new Error('spawn node ENOENT'), executable: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', platform: 'linux', stat: fakeStat(0o100644), access: accessThrows });
  assert.equal(dx.kind, 'libc');
});

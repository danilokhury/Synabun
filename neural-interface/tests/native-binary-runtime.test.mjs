import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  SDK_PKG,
  SDK_PLATFORM_PACKAGES,
  detectMusl,
  sdkBinaryCandidates,
  resolveSdkBinary,
  ensureExecutable,
  claudeRuntime,
  clearNativeBinaryCache,
  resolveClaudeExecutableOverride,
  vendoredBinaryTargets,
  ensureVendoredExecutables,
  isNativeBinaryLaunchFailure,
  diagnoseLaunchFailure,
  planRuntimeRecovery,
} from '../lib/native-binary-runtime.js';

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

// ── resolution ──────────────────────────────────────────────────────────────

test('darwin and win32 get a single candidate with no fallback', () => {
  assert.deepEqual(sdkBinaryCandidates({ platform: 'darwin', arch: 'arm64' }),
    [`${SDK_PKG}-darwin-arm64/claude`]);
  assert.deepEqual(sdkBinaryCandidates({ platform: 'darwin', arch: 'x64' }),
    [`${SDK_PKG}-darwin-x64/claude`]);
  assert.deepEqual(sdkBinaryCandidates({ platform: 'win32', arch: 'x64' }),
    [`${SDK_PKG}-win32-x64/claude.exe`]);
  assert.deepEqual(sdkBinaryCandidates({ platform: 'win32', arch: 'arm64' }),
    [`${SDK_PKG}-win32-arm64/claude.exe`]);
});

test('only win32 gets the .exe suffix', () => {
  for (const platform of ['darwin', 'linux', 'android']) {
    for (const c of sdkBinaryCandidates({ platform, arch: 'x64' })) {
      assert.ok(c.endsWith('/claude'), `${platform} candidate should be extensionless: ${c}`);
    }
  }
});

test('android resolves to the linux-<arch>-android package', () => {
  assert.deepEqual(sdkBinaryCandidates({ platform: 'android', arch: 'arm64' }),
    [`${SDK_PKG}-linux-arm64-android/claude`]);
});

test('linux glibc tries the plain package first, musl tries musl first', () => {
  assert.deepEqual(sdkBinaryCandidates({ platform: 'linux', arch: 'x64', preferMusl: false }), [
    `${SDK_PKG}-linux-x64/claude`,
    `${SDK_PKG}-linux-x64-musl/claude`,
  ]);
  assert.deepEqual(sdkBinaryCandidates({ platform: 'linux', arch: 'x64', preferMusl: true }), [
    `${SDK_PKG}-linux-x64-musl/claude`,
    `${SDK_PKG}-linux-x64/claude`,
  ]);
  assert.deepEqual(sdkBinaryCandidates({ platform: 'linux', arch: 'arm64', preferMusl: true }), [
    `${SDK_PKG}-linux-arm64-musl/claude`,
    `${SDK_PKG}-linux-arm64/claude`,
  ]);
});

test('detectMusl is linux-only and fails safe to glibc', () => {
  const muslReport = { getReport: () => ({ header: {} }) };
  const glibcReport = { getReport: () => ({ header: { glibcVersionRuntime: '2.39' } }) };

  assert.equal(detectMusl({ platform: 'linux', report: muslReport }), true);
  assert.equal(detectMusl({ platform: 'linux', report: glibcReport }), false);

  // Non-linux never reports musl, whatever the report says.
  assert.equal(detectMusl({ platform: 'darwin', report: muslReport }), false);
  assert.equal(detectMusl({ platform: 'win32', report: muslReport }), false);

  // Unreadable report → glibc ordering, matching the SDK. (`null`, not
  // `undefined` — an undefined argument would fall back to the real
  // process.report via the default parameter.)
  assert.equal(detectMusl({ platform: 'linux', report: null }), false);
  assert.equal(detectMusl({ platform: 'linux', report: {} }), false);
  assert.equal(detectMusl({ platform: 'linux', report: { getReport: () => { throw new Error('nope'); } } }), false);
});

test('resolveSdkBinary picks the first candidate that exists', () => {
  // musl host where only the glibc build is installed → falls through to it.
  const specs = [`${SDK_PKG}-linux-x64-musl/claude`, `${SDK_PKG}-linux-x64/claude`];
  const r = resolveSdkBinary({
    platform: 'linux',
    arch: 'x64',
    preferMusl: true,
    resolve: fakeResolve(specs),
    exists: fakeExists([`/nm/${SDK_PKG}-linux-x64/claude`]),
  });
  assert.equal(r.path, `/nm/${SDK_PKG}-linux-x64/claude`);
  assert.equal(r.specifier, `${SDK_PKG}-linux-x64/claude`);
  assert.equal(r.checked.length, 2);
});

test('resolveSdkBinary skips a candidate whose resolve throws MODULE_NOT_FOUND', () => {
  const r = resolveSdkBinary({
    platform: 'linux',
    arch: 'x64',
    preferMusl: true,
    resolve: fakeResolve([`${SDK_PKG}-linux-x64/claude`]), // musl package not installed
    exists: fakeExists([`/nm/${SDK_PKG}-linux-x64/claude`]),
  });
  assert.equal(r.path, `/nm/${SDK_PKG}-linux-x64/claude`);
  assert.match(r.checked[0].error, /Cannot find module/);
});

test('resolveSdkBinary returns null with a populated trail when nothing exists', () => {
  const r = resolveSdkBinary({
    platform: 'darwin',
    arch: 'arm64',
    resolve: fakeResolve([]),
    exists: fakeExists([]),
  });
  assert.equal(r.path, null);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.checked.length, 1);
});

test('our platform package table still matches the installed SDK optionalDependencies', () => {
  // Drift guard: if the SDK adds or renames a platform target, this fails loudly
  // rather than letting our resolution silently diverge.
  const req = createRequire(import.meta.url);
  let pkg;
  try {
    pkg = req(`${SDK_PKG}/package.json`);
  } catch {
    const fs = req('node:fs');
    pkg = JSON.parse(fs.readFileSync(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf-8'));
  }
  assert.deepEqual(Object.keys(pkg.optionalDependencies || {}).sort(), [...SDK_PLATFORM_PACKAGES].sort());
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

test('no override means let the SDK resolve for itself', () => {
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
    '/app/node_modules/@anthropic-ai': ['claude-agent-sdk', 'claude-agent-sdk-darwin-arm64', 'claude-agent-sdk-linux-x64'],
    '/app/node_modules/node-pty/prebuilds': ['darwin-arm64', 'darwin-x64', 'linux-arm'],
    '/app/node_modules/@openai': ['codex-darwin-arm64', 'codex-sdk'],
    '/app/node_modules/@openai/codex-darwin-arm64/vendor': ['aarch64-apple-darwin'],
    '/app/node_modules/@openai/codex-sdk/vendor': [],
  };
  const files = [
    '/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    '/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude',
    '/app/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    '/app/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
    '/app/node_modules/node-pty/prebuilds/linux-arm/spawn-helper',
    '/app/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex',
    '/app/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/path/rg',
  ];
  return {
    files,
    readdir: (dir) => tree[String(dir)] || [],
    exists: fakeExists(files),
  };
}

test('the sweep enumerates every vendored binary, including dirs a hardcoded list would miss', () => {
  const { readdir, exists } = sweepFixture();
  const targets = vendoredBinaryTargets({ root: '/app', platform: 'linux', exists, readdir });
  const paths = targets.map((t) => t.path);

  assert.ok(paths.includes('/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'));
  assert.ok(paths.includes('/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'));
  assert.ok(paths.includes('/app/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex'));
  assert.ok(paths.includes('/app/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/path/rg'));
  // The old hardcoded list in rebuild-pty.js knew only darwin-{arm64,x64} and
  // linux-{x64,arm64} — linux-arm would have been skipped.
  assert.ok(paths.includes('/app/node_modules/node-pty/prebuilds/linux-arm/spawn-helper'));
  // The SDK wrapper package itself carries no binary.
  assert.ok(!paths.some((p) => p.includes('claude-agent-sdk/claude')));
});

test('the sweep repairs only the binaries that need it', () => {
  const { readdir, exists } = sweepFixture();
  const needsRepair = new Set([
    '/app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    '/app/node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
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
  const blocked = '/app/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/path/rg';
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
  assert.ok(r.repaired.length >= 5, 'every other binary is still repaired');
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

test('a repaired exec bit yields a retryable, non-libc explanation', () => {
  const dx = diagnoseLaunchFailure({
    err: new Error('spawn EACCES'),
    runtime: { path: '/nm/claude', state: 'repaired', mode: 0o100644, repaired: true, repairCommand: 'chmod +x "/nm/claude"' },
    platform: 'darwin',
    arch: 'arm64',
  });
  assert.equal(dx.kind, 'exec-bit');
  assert.equal(dx.canRetryAfterRepair, true);
  assert.match(dx.message, /permission/i);
  assert.doesNotMatch(dx.message, /musl/i, 'must not repeat the SDK\'s wrong libc story on macOS');
  assert.doesNotMatch(dx.message, /glibc/i);
});

test('an unrepairable exec bit is not retried and suggests sudo', () => {
  const dx = diagnoseLaunchFailure({
    err: new Error('spawn EACCES'),
    runtime: { path: '/nm/claude', state: 'chmod-failed', error: 'EROFS', repairCommand: 'chmod +x "/nm/claude"' },
    platform: 'linux',
  });
  assert.equal(dx.canRetryAfterRepair, false);
  assert.match(dx.message, /sudo chmod \+x/);
});

test('a missing binary keeps the panel install-CTA phrase', () => {
  // ui-claude-panel.js gates its "install Claude" CTA on /Claude CLI not found|ENOENT/i.
  const dx = diagnoseLaunchFailure({
    err: new Error('Native CLI binary for linux-x64 not found.'),
    runtime: { state: 'not-installed' },
    platform: 'linux',
    arch: 'x64',
  });
  assert.equal(dx.kind, 'missing');
  assert.match(dx.message, /Claude CLI not found/);
  assert.match(dx.message, /optional/);
});

test('an executable-but-failing binary blames Gatekeeper on macOS and libc on Linux', () => {
  const mac = diagnoseLaunchFailure({
    err: new Error('spawn EPERM'), runtime: { path: '/nm/claude', state: 'ok' }, platform: 'darwin', arch: 'arm64',
  });
  assert.equal(mac.kind, 'gatekeeper');
  assert.match(mac.repairCommand, /xattr -d com\.apple\.quarantine/);

  const linux = diagnoseLaunchFailure({
    err: new Error('spawn ENOEXEC'), runtime: { path: '/nm/claude', state: 'ok' }, platform: 'linux', arch: 'x64',
  });
  assert.equal(linux.kind, 'libc');
  assert.match(linux.message, /musl|glibc/);
});

test('a windows shim is diagnosed as a shim problem', () => {
  const dx = diagnoseLaunchFailure({
    err: new Error('spawn EINVAL'),
    runtime: { path: 'C:\\npm\\claude.cmd', state: 'windows-bad-name' },
    platform: 'win32',
  });
  assert.equal(dx.kind, 'shim');
  assert.equal(dx.canRetryAfterRepair, false);
});

// ── recovery planning ───────────────────────────────────────────────────────

test('recovery retries once after a successful repair, then falls back', () => {
  const runtime = { path: '/nm/claude', state: 'repaired', mode: 0o100644, repairCommand: 'chmod +x "/nm/claude"' };

  const first = planRuntimeRecovery({ err: new Error('EACCES'), runtime, fallbackBin: '/usr/local/bin/claude', platform: 'darwin' });
  assert.equal(first.action, 'retry');

  const second = planRuntimeRecovery({ err: new Error('EACCES'), runtime, fallbackBin: '/usr/local/bin/claude', alreadyTried: true, platform: 'darwin' });
  assert.equal(second.action, 'fallback');
  assert.match(second.message, /Falling back/);
  assert.match(second.message, /\/usr\/local\/bin\/claude/);
});

test('recovery falls back immediately when repair cannot help', () => {
  const r = planRuntimeRecovery({
    err: new Error('EACCES'),
    runtime: { path: '/nm/claude', state: 'chmod-failed', repairCommand: 'chmod +x "/nm/claude"' },
    fallbackBin: '/usr/local/bin/claude',
    platform: 'linux',
  });
  assert.equal(r.action, 'fallback');
  assert.match(r.message, /sudo chmod \+x/);
});

test('recovery fails with a diagnosis when there is no fallback', () => {
  const r = planRuntimeRecovery({
    err: new Error('EACCES'),
    runtime: { state: 'not-installed' },
    fallbackBin: null,
    platform: 'linux',
    arch: 'x64',
  });
  assert.equal(r.action, 'fail');
  assert.match(r.message, /Claude CLI not found/);
});

// ── live runtime (this host) ────────────────────────────────────────────────

test('claudeRuntime resolves and repairs the real installed binary', () => {
  clearNativeBinaryCache();
  const rt = claudeRuntime();
  // On a host where the platform package is installed we expect a launchable
  // binary; where it is not, we expect a clean not-installed verdict.
  if (rt.state === 'not-installed') {
    assert.equal(rt.ok, false);
    assert.ok(Array.isArray(rt.candidates) && rt.candidates.length > 0);
  } else {
    assert.equal(rt.ok, true, `runtime not launchable: ${rt.state} ${rt.reason || ''}`);
    assert.ok(rt.path.includes('claude-agent-sdk-'));
  }
});

test('claudeRuntime memoizes until the cache is cleared', () => {
  clearNativeBinaryCache();
  let resolveCalls = 0;
  const opts = {
    platform: 'darwin',
    arch: 'arm64',
    resolve: (s) => { resolveCalls++; return `/nm/${s}`; },
    exists: () => true,
    stat: fakeStat(0o100755),
    chmod: recordChmod(),
    access: accessOk,
  };
  claudeRuntime(opts);
  claudeRuntime(opts);
  assert.equal(resolveCalls, 1, 'second call should be served from cache');
  clearNativeBinaryCache();
  claudeRuntime(opts);
  assert.equal(resolveCalls, 2);
  clearNativeBinaryCache();
});

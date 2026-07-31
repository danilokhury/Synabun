// ── Cross-platform native binary runtime (resolve → verify → repair → diagnose) ──
//
// The Claude Agent SDK resolves its bundled native CLI with `require.resolve` +
// `existsSync` and nothing else — no stat, no X_OK probe, no spawn test. When the
// binary is present but not executable, `spawn` fails EACCES and the SDK reports:
//
//   "Claude Code native binary at <p> exists but failed to launch. This usually
//    means the binary does not match this system's libc — e.g. spawning a
//    musl-linked binary on a glibc Linux host…"
//
// That wording is hardcoded and wrong everywhere except Linux: the SDK buckets
// ENOENT/EACCES/EPERM/ENOTDIR/ELOOP/ENAMETOOLONG/EROFS together and picks the
// message using only `existsSync`. It also throws a ReferenceError, not an Error.
//
// SynaBun hits this constantly because `node_modules` is committed with
// core.filemode=false, so every vendored binary checks out mode 0644.
//
// This module supplies what the SDK lacks:
//   - a faithful reimplementation of the SDK's candidate resolution, so we know
//     WHICH file it will pick and can stat/chmod exactly that one
//   - exec-bit verification and repair (POSIX), plus an X_OK probe that catches
//     modes the `& 0o111` mask misses (e.g. root-owned 0711)
//   - a sweep over every vendored binary (Claude SDK, Codex, node-pty), built by
//     enumeration rather than a hardcoded list
//   - platform-accurate diagnosis + a recovery plan (repair-and-retry, then fall
//     back to the user's global CLI)
//
// Resolution logic below mirrors @anthropic-ai/claude-agent-sdk@0.3.220. We never
// hand the resolved path back to the SDK on the happy path — it re-resolves for
// itself, and our copy exists only to know what to repair and how to explain a
// failure. A drift between the two therefore degrades to "we chmod'd a file
// nobody uses", never to launching the wrong binary.
//
// Every dependency is injectable (platform, arch, exists, stat, chmod, access,
// readdir, report) so all eight platform targets are testable from one host.
// Nothing here throws.

import { existsSync, statSync, chmodSync, accessSync, readdirSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const SDK_PKG = '@anthropic-ai/claude-agent-sdk';

// Platform packages the SDK declares as optionalDependencies. Kept here so a
// test can assert we still match the installed SDK's own list (see the drift
// guard in tests/native-binary-runtime.test.mjs).
export const SDK_PLATFORM_PACKAGES = [
  `${SDK_PKG}-darwin-arm64`,
  `${SDK_PKG}-darwin-x64`,
  `${SDK_PKG}-linux-arm64`,
  `${SDK_PKG}-linux-arm64-musl`,
  `${SDK_PKG}-linux-x64`,
  `${SDK_PKG}-linux-x64-musl`,
  `${SDK_PKG}-win32-arm64`,
  `${SDK_PKG}-win32-x64`,
];

// The SDK's isNativeBinary(): a path NOT ending in one of these is spawned
// directly and needs +x. Note `.cjs` is absent — it IS spawned directly.
const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.tsx', '.ts', '.jsx'];

// The SDK's own spawn-error bucket, plus ENOEXEC (wrong-arch / bad Mach-O),
// which surfaces the same way.
const LAUNCH_ERROR_CODES = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG', 'EROFS', 'ENOEXEC',
]);

export const SDK_LIBC_MESSAGE_RE = /native binary at .+ exists but failed to launch/i;

// ─────────────────────────────────────────────────────────────────────────────
// Resolution (faithful to the SDK)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * musl detection, exactly as the SDK does it: linux-only, and an ABSENT
 * `glibcVersionRuntime` in the diagnostic report means musl. Anything we cannot
 * read falls back to the glibc ordering, matching the SDK.
 */
export function detectMusl({ platform = process.platform, report = process.report } = {}) {
  if (platform !== 'linux') return false;
  try {
    if (typeof report?.getReport !== 'function') return false;
    const r = report.getReport();
    return r != null && r.header?.glibcVersionRuntime === undefined;
  } catch {
    return false;
  }
}

/**
 * The request specifiers the SDK tries, in order. Each is `<pkg>/claude`, or
 * `<pkg>/claude.exe` on Windows. darwin and win32 get a SINGLE candidate with no
 * fallback; only linux has a two-entry list, ordered by libc.
 */
export function sdkBinaryCandidates({
  platform = process.platform,
  arch = process.arch,
  preferMusl,
} = {}) {
  const musl = preferMusl === undefined ? detectMusl({ platform }) : !!preferMusl;
  const binary = platform === 'win32' ? 'claude.exe' : 'claude';

  let packages;
  if (platform === 'android') {
    packages = [`${SDK_PKG}-linux-${arch}-android`];
  } else if (platform === 'linux') {
    packages = musl
      ? [`${SDK_PKG}-linux-${arch}-musl`, `${SDK_PKG}-linux-${arch}`]
      : [`${SDK_PKG}-linux-${arch}`, `${SDK_PKG}-linux-${arch}-musl`];
  } else {
    packages = [`${SDK_PKG}-${platform}-${arch}`];
  }
  return packages.map((p) => `${p}/${binary}`);
}

// Anchor resolution at the SDK's own entry file, NOT at this module. The SDK
// calls createRequire(fileURLToPath(import.meta.url)) from inside sdk.mjs, so a
// nested or pnpm-style layout resolves from that directory's ancestry — not
// ours. Resolving from here would find a different (or no) platform package.
const _selfRequire = createRequire(import.meta.url);
function defaultSdkResolve(specifier) {
  const sdkRequire = createRequire(_selfRequire.resolve(SDK_PKG));
  return sdkRequire.resolve(specifier);
}

/**
 * Resolve the native binary the SDK would pick.
 * @returns {{path: string|null, specifier: string|null, candidates: string[], checked: object[]}}
 */
export function resolveSdkBinary({
  platform = process.platform,
  arch = process.arch,
  preferMusl,
  resolve = defaultSdkResolve,
  exists = existsSync,
} = {}) {
  const candidates = sdkBinaryCandidates({ platform, arch, preferMusl });
  const checked = [];

  for (const specifier of candidates) {
    try {
      const resolved = resolve(specifier);
      const found = exists(resolved);
      checked.push({ specifier, path: resolved, exists: found });
      if (found) return { path: resolved, specifier, candidates, checked };
    } catch (error) {
      // MODULE_NOT_FOUND on an uninstalled optional dep — the SDK swallows this
      // per-candidate too and moves on.
      checked.push({ specifier, error: error?.message || String(error) });
    }
  }
  return { path: null, specifier: null, candidates, checked };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exec-bit verification and repair
// ─────────────────────────────────────────────────────────────────────────────

function isScriptPath(p) {
  const lower = String(p).toLowerCase();
  return SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function quoteForShell(p) {
  return `"${String(p).replace(/"/g, '\\"')}"`;
}

/**
 * Verify a binary is launchable, repairing the execute bit where we can.
 *
 * states: ok | repaired | missing | not-a-file | chmod-failed | access-denied
 *         | windows-bad-name | script
 */
export function ensureExecutable(binPath, {
  platform = process.platform,
  stat = statSync,
  chmod = chmodSync,
  access = accessSync,
} = {}) {
  const base = { path: binPath, ok: false, state: 'missing', repaired: false, repairCommand: null };
  if (!binPath) return { ...base, reason: 'No path given' };

  let st;
  try {
    st = stat(binPath);
  } catch (error) {
    return { ...base, state: 'missing', error: error?.message || String(error), reason: `Not found: ${binPath}` };
  }
  if (typeof st?.isFile === 'function' && !st.isFile()) {
    return { ...base, state: 'not-a-file', reason: `Not a regular file: ${binPath}` };
  }

  const mode = st?.mode ?? 0;

  if (platform === 'win32') {
    // Windows has no execute bit. What matters is whether the SDK's
    // spawn(shell:false) can launch this name at all.
    if (isScriptPath(binPath)) {
      return { ...base, ok: true, state: 'script', mode };
    }
    if (/\.exe$/i.test(binPath)) {
      return { ...base, ok: true, state: 'ok', mode };
    }
    return {
      ...base,
      state: 'windows-bad-name',
      mode,
      reason: `${binPath} is not a .exe — the SDK spawns with shell:false, which cannot launch .cmd/.bat/.ps1 shims`,
    };
  }

  // POSIX: repair the execute bit if it is missing anywhere.
  const repairCommand = `chmod +x ${quoteForShell(binPath)}`;
  let repaired = false;
  if (!(mode & 0o111)) {
    try {
      chmod(binPath, mode | 0o755);
      repaired = true;
    } catch (error) {
      return {
        ...base,
        state: 'chmod-failed',
        mode,
        repairCommand,
        error: error?.message || String(error),
        reason: `Cannot add the execute bit to ${binPath} (read-only or not owned by this user)`,
      };
    }
  }

  // Always probe X_OK: the `& 0o111` mask passes on modes we still cannot run,
  // e.g. a root-owned 0711 when we are neither the owner nor in its group.
  try {
    access(binPath, constants.X_OK);
  } catch (error) {
    return {
      ...base,
      state: 'access-denied',
      mode,
      repaired,
      repairCommand,
      error: error?.message || String(error),
      reason: `${binPath} is still not executable by this user`,
    };
  }

  return {
    ...base,
    ok: true,
    state: repaired ? 'repaired' : 'ok',
    mode,
    repaired,
    repairCommand,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude runtime (resolution + repair, memoized)
// ─────────────────────────────────────────────────────────────────────────────

const _runtimeCache = new Map();

export function clearNativeBinaryCache() {
  _runtimeCache.clear();
}

/**
 * Resolve and repair the SDK's bundled Claude binary.
 *
 * The returned `path` is informational: callers should NOT pass it to the SDK as
 * `pathToClaudeCodeExecutable` on the happy path. Calling this for its chmod
 * side effect and letting the SDK resolve for itself keeps us immune to future
 * changes in the SDK's resolution.
 */
export function claudeRuntime({
  platform = process.platform,
  arch = process.arch,
  preferMusl,
  resolve,
  exists,
  stat,
  chmod,
  access,
  cache = true,
} = {}) {
  const musl = preferMusl === undefined ? detectMusl({ platform }) : !!preferMusl;
  const key = `${platform}:${arch}:${musl}`;
  if (cache && _runtimeCache.has(key)) return _runtimeCache.get(key);

  const resolved = resolveSdkBinary({ platform, arch, preferMusl: musl, resolve, exists });

  let result;
  if (!resolved.path) {
    result = {
      path: null,
      specifier: null,
      ok: false,
      state: 'not-installed',
      repaired: false,
      repairCommand: null,
      candidates: resolved.candidates,
      checked: resolved.checked,
      reason: `No Claude native binary is installed for ${platform}-${arch}`,
    };
  } else {
    const verdict = ensureExecutable(resolved.path, { platform, stat, chmod, access });
    result = {
      ...verdict,
      specifier: resolved.specifier,
      candidates: resolved.candidates,
      checked: resolved.checked,
    };
  }

  if (cache) _runtimeCache.set(key, result);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Executable override contract (one contract for every SDK caller)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a user-supplied `pathToClaudeCodeExecutable`.
 *
 * The SDK uses that value verbatim with zero validation, so a bad one produces a
 * worse failure than the one we are fixing. In particular a BARE COMMAND NAME
 * (e.g. the string 'claude', which getClaudeBin() returns as its last resort)
 * is a guaranteed ENOENT under spawn(shell:false) — it must be rejected here.
 *
 * @returns {{path: string|null, kind: 'script'|'native'|null, ok: boolean, reason: string|null, repaired?: boolean, state?: string}}
 */
export function resolveClaudeExecutableOverride(spec, {
  platform = process.platform,
  exists = existsSync,
  stat,
  chmod,
  access,
} = {}) {
  const value = typeof spec === 'string' ? spec.trim() : '';
  if (!value) return { path: null, kind: null, ok: true, reason: null };

  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const hasSeparator = value.includes('/') || (platform === 'win32' && value.includes('\\'));
  if (!hasSeparator) {
    return {
      path: null,
      kind: null,
      ok: false,
      reason: `"${value}" is a bare command name; the SDK spawns with shell:false and cannot resolve it from PATH`,
    };
  }

  if (isScriptPath(value)) {
    // Launched via node/bun — needs to exist, but not to be executable.
    if (!exists(value)) {
      return { path: null, kind: 'script', ok: false, reason: `Script not found: ${value}` };
    }
    return { path: pathImpl.normalize(value), kind: 'script', ok: true, reason: null };
  }

  // Everything else — including .cjs, which the SDK spawns DIRECTLY — must be
  // executable in its own right.
  const verdict = ensureExecutable(value, { platform, stat, chmod, access });
  if (!verdict.ok) {
    return { path: null, kind: 'native', ok: false, state: verdict.state, reason: verdict.reason || `Not launchable: ${value}` };
  }
  return {
    path: pathImpl.normalize(value),
    kind: 'native',
    ok: true,
    reason: null,
    repaired: verdict.repaired,
    state: verdict.state,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Vendored binary sweep
// ─────────────────────────────────────────────────────────────────────────────

const CODEX_VENDOR_BIN_DIRS = ['bin', 'codex', 'path'];
const CODEX_VENDOR_BIN_NAMES = ['codex', 'codex.exe', 'rg', 'rg.exe'];

function safeReaddir(readdir, dir) {
  try {
    return readdir(dir, { withFileTypes: false }) || [];
  } catch {
    return [];
  }
}

/**
 * Enumerate every vendored binary that must be executable, by walking the tree
 * rather than hardcoding names. This is what keeps the sweep correct as
 * platform packages and node-pty prebuild directories come and go — the old
 * hardcoded list in scripts/rebuild-pty.js named linux dirs that do not exist
 * here while missing ones that do.
 *
 * Every target is optional: a given checkout has only a subset installed.
 */
export function vendoredBinaryTargets({
  root,
  platform = process.platform,
  exists = existsSync,
  readdir = readdirSync,
} = {}) {
  if (!root) return [];
  const nm = path.join(root, 'node_modules');
  const targets = [];
  const add = (id, p, kind) => { if (exists(p)) targets.push({ id, path: p, kind }); };

  // 1. Claude Agent SDK platform packages (all of them, not just this host's —
  //    a vendored checkout can carry several).
  const anthropicDir = path.join(nm, '@anthropic-ai');
  for (const entry of safeReaddir(readdir, anthropicDir)) {
    const name = String(entry);
    if (!name.startsWith('claude-agent-sdk-')) continue;
    const pkgDir = path.join(anthropicDir, name);
    add(`sdk:${name}`, path.join(pkgDir, 'claude'), 'sdk-claude');
    add(`sdk:${name}:exe`, path.join(pkgDir, 'claude.exe'), 'sdk-claude');
  }

  // 2. node-pty spawn-helper, for every prebuild directory present.
  const ptyDir = path.join(nm, 'node-pty');
  const prebuildsDir = path.join(ptyDir, 'prebuilds');
  for (const entry of safeReaddir(readdir, prebuildsDir)) {
    add(`pty:${entry}`, path.join(prebuildsDir, String(entry), 'spawn-helper'), 'pty-spawn-helper');
  }
  add('pty:build', path.join(ptyDir, 'build', 'Release', 'spawn-helper'), 'pty-spawn-helper');

  // 3. Codex platform packages: vendor/<triple>/{bin,codex,path}/{codex,rg}.
  //    Hygiene only — server.js deliberately never falls back to the bundled
  //    Codex binary (macOS quarantine); repairing the bit must not be read as
  //    enabling that fallback.
  const openaiDir = path.join(nm, '@openai');
  for (const entry of safeReaddir(readdir, openaiDir)) {
    const name = String(entry);
    if (!name.startsWith('codex')) continue;
    const vendorDir = path.join(openaiDir, name, 'vendor');
    for (const triple of safeReaddir(readdir, vendorDir)) {
      for (const binDir of CODEX_VENDOR_BIN_DIRS) {
        for (const binName of CODEX_VENDOR_BIN_NAMES) {
          const p = path.join(vendorDir, String(triple), binDir, binName);
          add(`codex:${name}:${triple}:${binDir}:${binName}`, p, binName.startsWith('rg') ? 'ripgrep' : 'codex');
        }
      }
    }
    add(`codex:${name}:bin-rg`, path.join(openaiDir, name, 'bin', 'rg'), 'ripgrep');
  }

  return targets;
}

/**
 * Repair the execute bit on every vendored binary that needs it.
 * No-op on Windows (no execute bit), but still enumerates for diagnostics.
 */
export function ensureVendoredExecutables({
  root,
  platform = process.platform,
  exists,
  readdir,
  stat,
  chmod,
  access,
  log = null,
} = {}) {
  const targets = vendoredBinaryTargets({ root, platform, exists, readdir });
  const result = { repaired: [], failed: [], checked: targets.length, skipped: null };

  if (platform === 'win32') {
    result.skipped = 'win32';
    return result;
  }

  for (const target of targets) {
    const verdict = ensureExecutable(target.path, { platform, stat, chmod, access });
    if (verdict.repaired) {
      result.repaired.push(target.path);
      if (log) log(`[binaries] restored execute permission on ${target.path}`);
    } else if (!verdict.ok) {
      result.failed.push({ path: target.path, state: verdict.state, error: verdict.error, repairCommand: verdict.repairCommand });
      if (log) log(`[binaries] ${target.path} is not launchable (${verdict.state})`);
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure diagnosis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does this error mean the native binary could not be launched?
 *
 * The SDK signals it two ways: a ReferenceError (not Error — it literally does
 * `this.exitError = ReferenceError(msg)`) carrying the libc text, or a raw spawn
 * error whose code is in its bucket. "No conversation found" must NOT match —
 * that path belongs to the bridge's session-recovery logic.
 */
export function isNativeBinaryLaunchFailure(err) {
  if (!err) return false;
  const message = typeof err === 'string' ? err : (err.message || '');
  if (/No conversation found/i.test(message)) return false;
  if (SDK_LIBC_MESSAGE_RE.test(message)) return true;
  if (/executable (?:at .+ )?(?:exists but failed to launch|not found)/i.test(message)) return true;
  if (/Native CLI binary for .+ not found/i.test(message)) return true;
  if (err.code && LAUNCH_ERROR_CODES.has(err.code)) return true;
  for (const code of LAUNCH_ERROR_CODES) {
    if (message.includes(code)) return true;
  }
  return false;
}

/**
 * Turn a launch failure into a platform-accurate explanation, replacing the
 * SDK's hardcoded musl/glibc story (which is only correct on Linux).
 *
 * @returns {{kind: string, message: string, repairCommand: string|null, canRetryAfterRepair: boolean}}
 */
export function diagnoseLaunchFailure({
  err,
  runtime,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const rt = runtime || {};
  const p = rt.path || '(unresolved)';
  const raw = (typeof err === 'string' ? err : err?.message) || '';

  switch (rt.state) {
    case 'repaired':
      return {
        kind: 'exec-bit',
        repairCommand: rt.repairCommand,
        canRetryAfterRepair: true,
        message: [
          `The bundled Claude binary was not executable (mode ${(rt.mode & 0o777).toString(8).padStart(3, '0')}).`,
          'This is a file permission problem, not a libc mismatch — the SDK always blames libc here.',
          'Execute permission has been restored; retrying.',
        ].join(' '),
      };

    case 'chmod-failed':
    case 'access-denied':
      return {
        kind: 'exec-bit',
        repairCommand: rt.repairCommand,
        canRetryAfterRepair: false,
        message: [
          `The bundled Claude binary at ${p} is not executable and the permission could not be repaired`,
          `(${rt.error || rt.state}).`,
          'This is a file permission problem, not a libc mismatch.',
          `The install may be read-only or owned by another user. Fix it with: sudo ${rt.repairCommand || `chmod +x ${quoteForShell(p)}`}`,
        ].join(' '),
      };

    case 'windows-bad-name':
      return {
        kind: 'shim',
        repairCommand: null,
        canRetryAfterRepair: false,
        message: [
          `${p} cannot be launched: the Claude Agent SDK spawns with shell:false,`,
          'so npm .cmd/.bat/.ps1 shims will not run. Point the override at the real claude.exe instead.',
        ].join(' '),
      };

    case 'not-installed':
    case 'missing':
    case 'not-a-file':
      return {
        kind: 'missing',
        repairCommand: null,
        canRetryAfterRepair: false,
        // The literal "Claude CLI not found" keeps the panel's existing
        // install-CTA regex (ui-claude-panel.js) firing without a frontend change.
        message: [
          `Claude CLI not found for ${platform}-${arch}.`,
          'The SDK ships its native binary as a per-platform optional dependency.',
          'Reinstall without --omit=optional (npm install --include=optional), or install Claude Code globally.',
        ].join(' '),
      };

    default:
      break;
  }

  // Resolved, executable, and it still would not launch.
  if (platform === 'darwin') {
    return {
      kind: 'gatekeeper',
      repairCommand: `xattr -d com.apple.quarantine ${quoteForShell(p)}`,
      canRetryAfterRepair: false,
      message: [
        `The Claude binary at ${p} is executable but macOS refused to launch it.`,
        `Usually Gatekeeper quarantine, or a binary built for another architecture (this host is ${arch}).`,
        `Try: xattr -d com.apple.quarantine ${quoteForShell(p)}`,
      ].join(' '),
    };
  }
  if (platform === 'linux') {
    return {
      kind: 'libc',
      repairCommand: null,
      canRetryAfterRepair: false,
      message: [
        `The Claude binary at ${p} is executable but failed to launch.`,
        `This host looks like ${detectMusl({ platform }) ? 'musl' : 'glibc'}.`,
        'A musl-linked binary on a glibc host (or the reverse) fails because the matching dynamic loader is missing.',
        'Reinstall so the correct linux variant is selected.',
      ].join(' '),
    };
  }
  return {
    kind: 'unknown',
    repairCommand: null,
    canRetryAfterRepair: false,
    message: raw || `The Claude binary at ${p} failed to launch.`,
  };
}

/**
 * Decide what to do about a launch failure. Pure, so the bridge's recovery
 * behaviour is unit-testable without a live WebSocket.
 *
 * @returns {{action: 'retry'|'fallback'|'fail', message: string, kind: string, repairCommand: string|null}}
 */
export function planRuntimeRecovery({
  err,
  runtime,
  fallbackBin = null,
  alreadyTried = false,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const dx = diagnoseLaunchFailure({ err, runtime, platform, arch });
  const base = { message: dx.message, kind: dx.kind, repairCommand: dx.repairCommand };

  if (dx.canRetryAfterRepair && !alreadyTried) return { ...base, action: 'retry' };
  if (fallbackBin) {
    return {
      ...base,
      action: 'fallback',
      message: `${dx.message}\nFalling back to your installed Claude CLI: ${fallbackBin}`,
    };
  }
  return { ...base, action: 'fail' };
}

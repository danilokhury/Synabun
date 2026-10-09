// ── Executables SynaBun starts: verify → repair → diagnose ──
//
// Two kinds of executable pass through here.
//
// The user's Claude Code. SynaBun ships none (lib/external-tools.js at the
// package root): every Agent SDK call is given the user's own installation as
// `pathToClaudeCodeExecutable` (lib/claude-executable.js). The SDK uses that
// value verbatim, with no stat, no X_OK probe and no spawn test, and when the
// launch fails it buckets ENOENT/EACCES/EPERM/ENOTDIR/ELOOP/ENAMETOOLONG/EROFS
// together and reports a musl/glibc mismatch, which is only ever right on
// Linux. It also throws a ReferenceError, not an Error. So this module:
//   - validates a path before the SDK gets it (a bare command name and a
//     Windows command file cannot be spawned with shell:false)
//   - recognises a launch failure, whatever shape the SDK gave it
//   - explains it for the platform it happened on
//
// SynaBun's own native helpers. node-pty's spawn-helper has to be executable
// and npm does not preserve the bit, so a sweep restores it, built by
// enumeration rather than a hardcoded list.
//
// Every dependency is injectable (platform, exists, stat, chmod, access,
// readdir), so every platform is testable from one host. Nothing here throws.

import { existsSync, statSync, chmodSync, accessSync, readdirSync, constants } from 'node:fs';
import path from 'node:path';

export const SDK_PKG = '@anthropic-ai/claude-agent-sdk';

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
// Executable override contract (one contract for every SDK caller)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a path before it becomes `pathToClaudeCodeExecutable`: the explicit
 * override, or the installation lib/claude-executable.js found.
 *
 * The SDK uses that value verbatim with zero validation, so a bad one fails
 * late and with the wrong explanation. In particular a BARE COMMAND NAME
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

function safeReaddir(readdir, dir) {
  try {
    return readdir(dir, { withFileTypes: false }) || [];
  } catch {
    return [];
  }
}

/**
 * Enumerate every native helper of SynaBun's own that must be executable, by
 * walking the tree rather than hardcoding names: node-pty's spawn-helper, for
 * every prebuild directory present and for a build from source. The old
 * hardcoded list in scripts/rebuild-pty.js named linux dirs that do not exist
 * here while missing ones that do.
 *
 * The agent tools are not in this list: Claude Code and Codex are the user's
 * installations, outside this tree, and nothing of theirs is repaired here.
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

  const ptyDir = path.join(nm, 'node-pty');
  const prebuildsDir = path.join(ptyDir, 'prebuilds');
  for (const entry of safeReaddir(readdir, prebuildsDir)) {
    add(`pty:${entry}`, path.join(prebuildsDir, String(entry), 'spawn-helper'), 'pty-spawn-helper');
  }
  add('pty:build', path.join(ptyDir, 'build', 'Release', 'spawn-helper'), 'pty-spawn-helper');

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
 * Turn a launch failure of the user's Claude Code into an explanation for the
 * platform it happened on, replacing the SDK's hardcoded musl/glibc story
 * (which is only correct on Linux). `executable` is the path the SDK was given.
 *
 * @returns {{kind: string, message: string, repairCommand: string|null}}
 */
export function diagnoseLaunchFailure({
  err,
  executable,
  platform = process.platform,
  arch = process.arch,
  stat = statSync,
  access = accessSync,
} = {}) {
  const p = executable || '';
  const raw = (typeof err === 'string' ? err : err?.message) || '';

  // The literal "Claude CLI not found" keeps the panel's install help
  // (ui-claude-panel.js) appearing without a frontend change.
  const missing = {
    kind: 'missing',
    repairCommand: null,
    message: p
      ? `Claude CLI not found at ${p}. Claude Code is installed separately from SynaBun: install it again, or correct its path in Settings > Terminal.`
      : 'Claude CLI not found. Claude Code is installed separately from SynaBun: install it, then send your message again.',
  };
  if (!p) return missing;

  let info = null;
  try { info = stat(p); } catch { return missing; }
  if (typeof info?.isFile === 'function' && !info.isFile()) return { ...missing, message: `Claude CLI not found: ${p} is not a file. Correct its path in Settings > Terminal.` };

  if (platform === 'win32') {
    if (!/\.exe$/i.test(p) && !isScriptPath(p)) {
      return {
        kind: 'shim',
        repairCommand: null,
        message: `${p} cannot be started: the Claude Agent SDK spawns without a shell, so a .cmd, .bat or .ps1 launcher will not run. Name the real claude.exe in cli-config.json ("claude-skin": { "sdkExecutable": "…" }).`,
      };
    }
    return { kind: 'unknown', repairCommand: null, message: raw || `Claude Code at ${p} could not be started.` };
  }

  if (!isScriptPath(p)) {
    try {
      access(p, constants.X_OK);
    } catch {
      const repairCommand = `chmod +x ${quoteForShell(p)}`;
      return {
        kind: 'exec-bit',
        repairCommand,
        message: `Claude Code at ${p} is not executable by this user. This is a file permission problem, not a libc mismatch. Fix it with: ${repairCommand}`,
      };
    }
  }

  if (platform === 'darwin') {
    const repairCommand = `xattr -d com.apple.quarantine ${quoteForShell(p)}`;
    return {
      kind: 'gatekeeper',
      repairCommand,
      message: `Claude Code at ${p} is executable but macOS refused to start it. Usually Gatekeeper quarantine, or a build for another processor (this one is ${arch}). Try: ${repairCommand}`,
    };
  }
  if (platform === 'linux') {
    return {
      kind: 'libc',
      repairCommand: null,
      message: `Claude Code at ${p} is executable but could not be started. A musl-linked build on a glibc system (or the reverse) fails because its dynamic loader is missing. Reinstall Claude Code so that the build for this system is selected.`,
    };
  }
  return { kind: 'unknown', repairCommand: null, message: raw || `Claude Code at ${p} could not be started.` };
}

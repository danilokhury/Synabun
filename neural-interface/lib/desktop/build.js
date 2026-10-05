// Builds the native desktop helper (helper/SynabunDesktop.swift) on the user's
// Mac with the Xcode Command Line Tools and caches the binary by content hash:
//   <dataHome>/bin/synabun-desktop-<hash>   hash = source + flags + compiler + arch + protocol
//   <dataHome>/bin/.build.lock              one build at a time (stale after the build timeout)
//   <dataHome>/cache/swift                  swiftc module cache
//   <dataHome>/data/desktop/build.log       every compile's output
//
// Nothing here runs `xcrun` unless a developer directory exists: on a Mac
// without the tools, /usr/bin/xcrun pops the "install developer tools" dialog.
// installToolchain() is the one entry point that opens that installer on purpose.
//
// All process execution goes through `execFileImpl(file, args, options)` →
// Promise<{stdout, stderr}> (rejecting with err.code / err.stdout / err.stderr),
// so tests never touch the real toolchain.

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import { access, appendFile, chmod, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataHome } from '../../../lib/paths.js';
import { ERROR_CODES, PROTOCOL_VERSION, helperError } from './protocol.js';

export const HELPER_SOURCE_PATH = fileURLToPath(new URL('./helper/SynabunDesktop.swift', import.meta.url));
export const HELPER_BINARY_PREFIX = 'synabun-desktop-';
export const MIN_MACOS_VERSION = '14.0';
export const DEFAULT_COMPILE_TIMEOUT_MS = 180000;

const BASE_FLAGS = Object.freeze(['-O', '-swift-version', '5']);
const KEEP_BINARIES = 2;
const LOG_TAIL_CHARS = 8 * 1024;
const BUILD_LOG_MAX_BYTES = 1024 * 1024;
const BUILD_LOG_KEEP_BYTES = 256 * 1024;
const HASH_RE = /^[0-9a-f]{16}$/;
const BINARY_NAME_RE = /^synabun-desktop-([0-9a-f]{16})$/;

export function defaultExecFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** Node's arch → the Swift target triple's arch. */
export function swiftArch(arch = process.arch) {
  return arch === 'x64' ? 'x86_64' : arch;
}

/** Flags that shape the binary (and therefore the hash). Paths are excluded. */
export function compileFlags(arch = process.arch) {
  return [...BASE_FLAGS, '-target', `${swiftArch(arch)}-apple-macos${MIN_MACOS_VERSION}`];
}

function firstLine(text) {
  return String(text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
}

function errorText(err) {
  return [err?.stderr, err?.stdout, err?.message].filter(Boolean).join('\n').trim();
}

/**
 * → { swiftc, path, version, compilerVersion, arch, sdkVersion, developerDir, needsToolchain?, error? }
 * `arch` is the Swift arch (arm64 / x86_64); `version` is the short Swift
 * version ("6.4"); `compilerVersion` is the full version line used for hashing.
 */
export async function detectToolchain({
  execFileImpl = defaultExecFile,
  existsImpl = existsSync,
  arch = process.arch,
  platform = process.platform,
} = {}) {
  const base = { swiftc: false, path: null, version: null, compilerVersion: null, arch: swiftArch(arch), sdkVersion: null, developerDir: null };
  if (platform !== 'darwin') return { ...base, error: 'the desktop helper is macOS-only' };

  let developerDir = '';
  try {
    developerDir = (await execFileImpl('xcode-select', ['-p'], { timeout: 10000 })).stdout.trim();
  } catch (err) {
    return { ...base, needsToolchain: true, error: firstLine(errorText(err)) || 'xcode-select -p failed' };
  }
  if (!developerDir || !existsImpl(developerDir)) {
    return { ...base, developerDir: developerDir || null, needsToolchain: true, error: `developer directory ${developerDir || '(none)'} is missing` };
  }

  let path = '';
  try {
    path = (await execFileImpl('xcrun', ['--find', 'swiftc'], { timeout: 30000 })).stdout.trim();
  } catch (err) {
    return { ...base, developerDir, needsToolchain: true, error: `xcrun --find swiftc failed: ${firstLine(errorText(err))}` };
  }
  if (!path) return { ...base, developerDir, needsToolchain: true, error: 'xcrun found no swiftc' };

  let versionText = '';
  try {
    const r = await execFileImpl('xcrun', ['swiftc', '--version'], { timeout: 30000 });
    versionText = `${r.stdout || ''}\n${r.stderr || ''}`;
  } catch (err) {
    return { ...base, developerDir, path, needsToolchain: true, error: `swiftc --version failed: ${firstLine(errorText(err))}` };
  }
  const lines = versionText.split('\n').map((s) => s.trim()).filter(Boolean);
  const compilerVersion = lines.find((l) => /Swift version/i.test(l)) || lines[0] || null;
  const version = compilerVersion?.match(/Swift version ([\d.]+)/i)?.[1] || null;

  let sdkVersion = null;
  try {
    sdkVersion = (await execFileImpl('xcrun', ['--show-sdk-version'], { timeout: 30000 })).stdout.trim() || null;
  } catch {}

  return { swiftc: true, path, version, compilerVersion, arch: swiftArch(arch), sdkVersion, developerDir };
}

/** First 16 hex chars of sha256 over everything that shapes the binary. */
export function sourceHash({ source, flags, compilerVersion, arch, protocolVersion = PROTOCOL_VERSION }) {
  return createHash('sha256')
    .update(JSON.stringify({
      v: 1,
      source: String(source ?? ''),
      flags: Array.isArray(flags) ? flags.map(String) : [],
      compilerVersion: String(compilerVersion ?? ''),
      arch: String(arch ?? ''),
      protocolVersion,
    }))
    .digest('hex')
    .slice(0, 16);
}

export function helperBinaryPath({ dataHome = getDataHome(), hash }) {
  if (!HASH_RE.test(String(hash))) throw new TypeError(`helperBinaryPath: invalid hash '${hash}'`);
  return join(dataHome, 'bin', `${HELPER_BINARY_PREFIX}${hash}`);
}

/** The hash embedded in a cached binary's file name, or null. */
export function hashFromBinaryPath(path) {
  return basename(String(path || '')).match(BINARY_NAME_RE)?.[1] || null;
}

async function isExecutable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function lockIsStale(lockPath, staleMs) {
  let st;
  try {
    st = await stat(lockPath);
  } catch {
    return false; // vanished — the next attempt takes it
  }
  if (Date.now() - st.mtimeMs > staleMs) return true;
  try {
    const { pid } = JSON.parse(await readFile(lockPath, 'utf8'));
    if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) return true;
  } catch {} // being written right now: not stale
  return false;
}

/**
 * O_EXCL lock file holding {pid, startedAt}. A lock older than staleMs, or whose
 * owner is dead, is broken. Waits up to waitMs for a live owner to finish.
 */
async function acquireBuildLock(lockPath, { staleMs, waitMs, pollMs, log }) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx');
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      } finally {
        await fh.close();
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await unlink(lockPath).catch(() => {});
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    if (await lockIsStale(lockPath, staleMs)) {
      log(`[desktop-build] breaking a stale build lock: ${lockPath}`);
      await unlink(lockPath).catch(() => {});
      continue;
    }
    if (Date.now() >= deadline) {
      throw helperError(ERROR_CODES.HELPER_UNAVAILABLE, 'another desktop helper build is still running', { stage: 'lock', lockPath });
    }
    await sleep(pollMs);
  }
}

/** Keep the newest `keep` binaries (always including `protect`); drop stale temp files. */
async function collectGarbage(binDir, { keep, protect, staleTmpMs }) {
  let names = [];
  try {
    names = await readdir(binDir);
  } catch {
    return [];
  }
  const bins = [];
  for (const name of names) {
    const p = join(binDir, name);
    if (BINARY_NAME_RE.test(name)) {
      try { bins.push({ p, mtimeMs: (await stat(p)).mtimeMs }); } catch {}
    } else if (name.startsWith(`.${HELPER_BINARY_PREFIX}`) && name.endsWith('.tmp')) {
      try {
        if (Date.now() - (await stat(p)).mtimeMs > staleTmpMs) await unlink(p);
      } catch {}
    }
  }
  bins.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const survivors = new Set([protect, ...bins.filter((b) => b.p !== protect).slice(0, Math.max(0, keep - 1)).map((b) => b.p)]);
  const removed = [];
  for (const b of bins) {
    if (survivors.has(b.p)) continue;
    try {
      await unlink(b.p); // a running helper keeps its inode; unlinking is safe
      removed.push(b.p);
    } catch {}
  }
  return removed;
}

async function appendBuildLog(dataHome, text) {
  try {
    const dir = join(dataHome, 'data', 'desktop');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'build.log');
    await appendFile(file, text);
    const st = await stat(file);
    if (st.size > BUILD_LOG_MAX_BYTES) {
      const buf = await readFile(file);
      await writeFile(file, buf.subarray(buf.length - BUILD_LOG_KEEP_BYTES));
    }
  } catch {}
}

/**
 * Compiles the helper for the current hash:
 *   xcrun swiftc -O -swift-version 5 -target <arch>-apple-macos14.0
 *     -module-cache-path <dataHome>/cache/swift -o <tmp> <src>
 * then chmod 0755 + atomic rename into place and GC of older binaries.
 * → { path, hash, durationMs, logTail, compilerVersion, cached? }
 * Throws helperError('HELPER_UNAVAILABLE', …, { needsToolchain } | { stage, logTail }).
 */
export async function compileHelper({
  dataHome = getDataHome(),
  log = () => {},
  execFileImpl = defaultExecFile,
  existsImpl = existsSync,
  timeoutMs = DEFAULT_COMPILE_TIMEOUT_MS,
  onProgress = () => {},
  sourcePath = HELPER_SOURCE_PATH,
  arch = process.arch,
  platform = process.platform,
  toolchain: knownToolchain = null,
  lockPollMs = 250,
} = {}) {
  const started = Date.now();
  const progress = (stage, extra = {}) => {
    try { onProgress({ stage, ...extra }); } catch {}
  };

  progress('toolchain');
  const toolchain = knownToolchain?.swiftc ? knownToolchain : await detectToolchain({ execFileImpl, existsImpl, arch, platform });
  if (!toolchain.swiftc) {
    throw helperError(ERROR_CODES.HELPER_UNAVAILABLE, 'the Xcode Command Line Tools are required to build the desktop helper', {
      needsToolchain: platform === 'darwin', toolchain,
    });
  }

  const source = await readFile(sourcePath, 'utf8');
  const flags = compileFlags(arch);
  const hash = sourceHash({ source, flags, compilerVersion: toolchain.compilerVersion, arch: swiftArch(arch), protocolVersion: PROTOCOL_VERSION });
  const binDir = join(dataHome, 'bin');
  const finalPath = helperBinaryPath({ dataHome, hash });
  await mkdir(binDir, { recursive: true });

  progress('lock');
  const release = await acquireBuildLock(join(binDir, '.build.lock'), {
    staleMs: timeoutMs, waitMs: timeoutMs + 5000, pollMs: lockPollMs, log,
  });
  try {
    // Another process may have finished this exact build while we waited.
    if (await isExecutable(finalPath)) {
      return { path: finalPath, hash, durationMs: Date.now() - started, logTail: '', compilerVersion: toolchain.compilerVersion, cached: true };
    }
    const cacheDir = join(dataHome, 'cache', 'swift');
    await mkdir(cacheDir, { recursive: true });
    const tmpPath = join(binDir, `.${HELPER_BINARY_PREFIX}${hash}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    const args = ['swiftc', ...flags, '-module-cache-path', cacheDir, '-o', tmpPath, sourcePath];

    progress('compile', { hash });
    log(`[desktop-build] compiling the desktop helper (${hash})`);
    const compileStarted = Date.now();
    let output = '';
    let failure = null;
    try {
      const r = await execFileImpl('xcrun', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
      output = [r.stdout, r.stderr].filter(Boolean).join('\n');
    } catch (err) {
      failure = err;
      output = errorText(err);
    }
    const compileMs = Date.now() - compileStarted;
    const logTail = output.length > LOG_TAIL_CHARS ? output.slice(-LOG_TAIL_CHARS) : output;
    await appendBuildLog(dataHome, [
      `[${new Date().toISOString()}] ${failure ? 'FAILED' : 'ok'} hash=${hash} ${compileMs}ms ${toolchain.compilerVersion || ''}`,
      `$ xcrun ${args.join(' ')}`,
      output.trimEnd(),
      '',
      '',
    ].join('\n'));

    if (failure) {
      await unlink(tmpPath).catch(() => {});
      const timedOut = failure.killed || failure.signal === 'SIGTERM';
      throw helperError(ERROR_CODES.HELPER_UNAVAILABLE, `the desktop helper failed to compile${timedOut ? ` (timed out after ${timeoutMs} ms)` : ''}`, {
        stage: 'compile', hash, exitCode: typeof failure.code === 'number' ? failure.code : null, timedOut: !!timedOut, logTail,
      });
    }
    if (!(await stat(tmpPath).catch(() => null))?.isFile()) {
      throw helperError(ERROR_CODES.HELPER_UNAVAILABLE, 'swiftc reported success but produced no binary', { stage: 'compile', hash, logTail });
    }

    progress('install', { path: finalPath });
    await chmod(tmpPath, 0o755);
    await rename(tmpPath, finalPath);
    const removed = await collectGarbage(binDir, { keep: KEEP_BINARIES, protect: finalPath, staleTmpMs: timeoutMs });
    if (removed.length) log(`[desktop-build] removed ${removed.length} old helper binar${removed.length === 1 ? 'y' : 'ies'}`);
    progress('done', { path: finalPath, hash });
    return { path: finalPath, hash, durationMs: Date.now() - started, logTail, compilerVersion: toolchain.compilerVersion };
  } finally {
    await release();
  }
}

/**
 * The helper binary to spawn:
 *   1. env SYNABUN_DESKTOP_HELPER_PATH (must exist)      → { path, hash, source:'env' }
 *   2. <dataHome>/bin/synabun-desktop-<current hash>     → { …, source:'cache' }
 *   3. compile when compile:true                        → { …, source:'compiled' }
 *   4. else helperError('HELPER_UNAVAILABLE', …, { needsCompile | needsToolchain })
 * Non-macOS hosts get helperError('UNSUPPORTED').
 */
export async function resolveHelperBinary({
  dataHome = getDataHome(),
  compile = false,
  env = process.env,
  execFileImpl = defaultExecFile,
  existsImpl = existsSync,
  log = () => {},
  onProgress = () => {},
  timeoutMs = DEFAULT_COMPILE_TIMEOUT_MS,
  sourcePath = HELPER_SOURCE_PATH,
  arch = process.arch,
  platform = process.platform,
} = {}) {
  const override = env?.SYNABUN_DESKTOP_HELPER_PATH;
  if (override) {
    if (!existsImpl(override)) {
      throw helperError(ERROR_CODES.HELPER_UNAVAILABLE, `SYNABUN_DESKTOP_HELPER_PATH points to a missing file: ${override}`, { override });
    }
    return { path: override, hash: hashFromBinaryPath(override), source: 'env' };
  }
  if (platform !== 'darwin') {
    throw helperError(ERROR_CODES.UNSUPPORTED, 'desktop control is only available on macOS', { platform });
  }
  const toolchain = await detectToolchain({ execFileImpl, existsImpl, arch, platform });
  if (!toolchain.swiftc) {
    throw helperError(ERROR_CODES.HELPER_UNAVAILABLE, 'the Xcode Command Line Tools are required to build the desktop helper', {
      needsToolchain: true, toolchain,
    });
  }
  const source = await readFile(sourcePath, 'utf8');
  const hash = sourceHash({ source, flags: compileFlags(arch), compilerVersion: toolchain.compilerVersion, arch: swiftArch(arch), protocolVersion: PROTOCOL_VERSION });
  const path = helperBinaryPath({ dataHome, hash });
  if (await isExecutable(path)) return { path, hash, source: 'cache', toolchain };
  if (!compile) {
    throw helperError(ERROR_CODES.HELPER_UNAVAILABLE, 'the desktop helper has not been built yet', { needsCompile: true, hash, toolchain });
  }
  const built = await compileHelper({ dataHome, log, execFileImpl, existsImpl, timeoutMs, onProgress, sourcePath, arch, platform, toolchain });
  return { ...built, source: 'compiled', toolchain };
}

/**
 * Opens Apple's Command Line Tools installer (`xcode-select --install` returns
 * as soon as the dialog is up). → { started:true } | { started:false, alreadyInstalled?, error }
 */
export async function installToolchain({ execFileImpl = defaultExecFile } = {}) {
  try {
    await execFileImpl('xcode-select', ['--install'], { timeout: 30000 });
    return { started: true };
  } catch (err) {
    const text = errorText(err);
    if (/already installed/i.test(text)) return { started: false, alreadyInstalled: true, error: firstLine(text) };
    return { started: false, error: firstLine(text) || 'xcode-select --install failed' };
  }
}

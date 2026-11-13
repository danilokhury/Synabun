// The MCP server's build after an install, an update or a pull: mcp-server/src compiled with TypeScript, so the
// running dist always matches the source on disk.
//
// - postinstall.js (every `npm i -g synabun`, `npm update -g`, the in-app updater's npm run, `npm install` in a
//   checkout) builds always (`force`): an update is exactly when the shipped or old dist may not match.
// - setup.js (every launch, and before the supervisor starts the server again) builds when the stamp in dist says
//   another version or another source built it: that is what catches a `git pull` on a clone.
// - The Neural Interface's POST /api/setup/build (the onboarding wizard) and the auto-build after POST
//   /api/system/restore use the async entry (buildMcpServerSafelyAsync), so the server keeps answering while tsc runs.
// - A packaged application (`packaged: true`) has its dist built by the packaging (packaging/lib/stage.mjs writes
//   the same stamp) and is replaced whole: it only asks whether its dist is whole, and never compiles.
//
// A build never leaves the user without a server: tsc writes into a fresh folder next to dist
// (mcp-server/.dist-build-<pid>-<time>), and only a build that exited 0 with every runtime entry of dist
// (lib/mcp-dist.js MCP_RUNTIME_ENTRIES: index.js, preload.js, preload-http.js) and every module they import present
// replaces dist. The swap renames the old dist aside (mcp-server/.dist-old-<pid>-<time>), renames the new one in, puts
// the old one back when the second rename fails, and removes the old one only after the swap succeeded. A build that
// is stopped between the two renames (or whose rollback failed) leaves dist missing and the old one aside: the next
// build puts that old one back before it does anything else (recoverDist), so a leftover is never the only good copy
// that a sweep removes. On any failure the previous dist stays as it was.
//
// One build at a time: every build holds mcp-server/.dist-build.lock (written whole to a temp file and linked into
// place, so it never exists empty; its owner's pid, token and start time inside) from before it sweeps until it
// swapped or gave up. A lock whose owner is gone, or older than LOCK_STALE_MS, is taken over through one exclusive
// claim per judged lock, and removed only when it is still the lock that was judged (tryBuildLock). A second builder waits up to `waitMs` (postinstall.js and setup.js wait; the Neural
// Interface's routes pass 0 and report `busy`). The sweep removes only temp and old folders no live build owns.
//
// The stamp (dist/.synabun-build.json) is the package version plus a SHA-256 over mcp-server/src, tsconfig.json and
// mcp-server/package.json: any change of version or source differs from it, so a check never skips a needed build.
//
// Nothing here throws for a build problem: every entry returns { status: 'failed', reason, output } instead, because
// a throw would exit the Neural Interface (its unhandled-rejection handler), fail setup.js's launch or, in
// postinstall.js, make npm roll the whole install back. Only plain node: modules: postinstall.js and setup.js import
// this on any Node.

import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { MCP_RUNTIME_ENTRIES, mcpDistMissing } from './mcp-dist.js';
import { mcpCompiler } from './runtime-dependencies.js';

export const BUILD_STAMP = '.synabun-build.json';
export const BUILD_LOCK = '.dist-build.lock';
const TEMP_PREFIX = '.dist-build-';
const OLD_PREFIX = '.dist-old-';
/** A lock older than this is taken over even when its owner still lives (a hung compiler). */
export const LOCK_STALE_MS = 30 * 60_000;
const LOCK_POLL_MS = 250;

export const MCP_RESTART_HINT = 'Restart your AI clients\' SynaBun MCP server (in Claude Code: /mcp) so they load the new build.';

function listFiles(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Whether dist (or `distDir`) holds every runtime entry and every module they import. */
export function mcpDistWhole(packageRoot, distDir = null) {
  return mcpDistMissing(packageRoot, { entries: MCP_RUNTIME_ENTRIES, ...(distDir ? { distDir } : {}) });
}

/**
 * What the build of this checkout should be stamped with: { version, sourceHash }, or null without a source.
 * Throws when a source file cannot be read (mcpBuildNeeded and the builders turn that into a result).
 */
export function mcpSourceStamp(packageRoot) {
  const root = resolve(packageRoot);
  const mcp = join(root, 'mcp-server');
  const src = join(mcp, 'src');
  if (!existsSync(src)) return null;
  let version = null;
  try { version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? null; } catch {}
  const files = [...listFiles(src), join(mcp, 'tsconfig.json'), join(mcp, 'package.json')]
    .filter(existsSync)
    .map(file => ({ file, name: relative(mcp, file).split(sep).join('/') }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const hash = createHash('sha256');
  for (const { file, name } of files) {
    hash.update(name); hash.update('\0');
    hash.update(readFileSync(file)); hash.update('\0');
  }
  return { version, sourceHash: hash.digest('hex') };
}

/** The stamp the current dist carries, or null. */
export function readBuildStamp(packageRoot) {
  try { return JSON.parse(readFileSync(join(resolve(packageRoot), 'mcp-server', 'dist', BUILD_STAMP), 'utf8')); } catch { return null; }
}

/**
 * Write the stamp of this source into a dist folder (the one of the package root by default). The packaging
 * (packaging/lib/stage.mjs) writes it after its own compile, so the application's dist is "current", never
 * "unstamped". Returns the stamp, or null without a source.
 */
export function writeBuildStamp(packageRoot, distDir = null) {
  const root = resolve(packageRoot);
  const stamp = mcpSourceStamp(root);
  if (!stamp) return null;
  const dist = distDir ? resolve(distDir) : join(root, 'mcp-server', 'dist');
  writeFileSync(join(dist, BUILD_STAMP), `${JSON.stringify({ ...stamp, builtAt: new Date().toISOString() }, null, 2)}\n`);
  return stamp;
}

/**
 * Whether dist must be built: { needed, reason }. Needed when it is incomplete, or when a source is present and the
 * stamp is missing or names another version or source. A copy with no source keeps its dist. A packaged application
 * (`packaged`) is replaced whole and has no compiler: only completeness counts there. Never throws: a source that
 * cannot be read is `needed` with reason 'unreadable' (the build then fails with the same error, as a result).
 */
export function mcpBuildNeeded(packageRoot, { packaged = false } = {}) {
  try {
    const { complete } = mcpDistWhole(packageRoot);
    if (!complete) return { needed: true, reason: 'incomplete' };
    if (packaged) return { needed: false, reason: 'packaged' };
    const want = mcpSourceStamp(packageRoot);
    if (!want) return { needed: false, reason: 'no-source' };
    const have = readBuildStamp(packageRoot);
    if (!have) return { needed: true, reason: 'unstamped' };
    if (have.version !== want.version) return { needed: true, reason: 'version' };
    if (have.sourceHash !== want.sourceHash) return { needed: true, reason: 'source' };
    return { needed: false, reason: 'current' };
  } catch (err) {
    return { needed: true, reason: 'unreadable', error: err?.message || String(err) };
  }
}

const COMPILE_OPTIONS = (cwd, windowsHide) => ({ cwd, windowsHide, timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });

function defaultCompile({ tsc, project, outDir, cwd, windowsHide }) {
  execFileSync(process.execPath, [tsc, '-p', project, '--outDir', outDir], { ...COMPILE_OPTIONS(cwd, windowsHide), stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The same compile without blocking the caller's event loop (the Neural Interface's routes). */
function defaultCompileAsync({ tsc, project, outDir, cwd, windowsHide }) {
  return new Promise((done, fail) => {
    execFile(process.execPath, [tsc, '-p', project, '--outDir', outDir], COMPILE_OPTIONS(cwd, windowsHide), (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; fail(err); } else done({ stdout, stderr });
    });
  });
}

// ── The lock ──

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

/** Before any build writes its JSON in: a lock with no readable content younger than this is a build being taken. */
export const LOCK_EMPTY_GRACE_MS = 5_000;
const CLAIM_INFIX = '.takeover-';
/** A takeover claim older than this belongs to a waiter that died mid-takeover. */
const CLAIM_STALE_MS = 60_000;
const TEMP_INFIX = '.tmp-';

function readLockInfo(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * What is at the lock path right now: null when nothing, else { id, stale }. `id` names this very lock (its token,
 * or for a lock without readable content its inode and change time), so a takeover can tell it from a later one.
 * A lock is stale when its owner is gone or it is older than LOCK_STALE_MS; a lock without readable content (an
 * older SynaBun's lock caught between its create and its write) is held for LOCK_EMPTY_GRACE_MS, then stale.
 */
function lockState(path, now = Date.now()) {
  let st;
  try { st = statSync(path); } catch { return null; }
  const info = readLockInfo(path);
  if (!info || typeof info !== 'object' || typeof info.token !== 'string' || !info.token) {
    return { id: `ino-${st.ino}-${st.ctimeMs}`, stale: now - st.mtimeMs > LOCK_EMPTY_GRACE_MS };
  }
  const id = `tok-${info.token.replace(/[^0-9A-Za-z_-]/g, '_')}`;
  let startedAt = Number(info.startedAt);
  if (!Number.isFinite(startedAt)) startedAt = st.mtimeMs;
  if (now - startedAt > LOCK_STALE_MS) return { id, stale: true };
  return { id, stale: !pidAlive(Number(info.pid)) };
}

/** The id of the lock at `path` as lockState names it, or null. */
export const lockId = (path) => lockState(path, 0)?.id ?? null;

/**
 * Remove the stale lock `judged` names, and only that one. Every waiter that judged the same lock stale races for
 * one claim file named after it (created exclusively); only the winner removes, and only after it read the lock
 * again and found the very lock it judged: a lock taken meanwhile has another id and is left alone. A claim
 * whose lock is gone is swept by the next build that takes the lock.
 */
export function removeStaleLock(path, judged) {
  const claim = `${path}${CLAIM_INFIX}${judged}`;
  try { closeSync(openSync(claim, 'wx')); } catch (err) {
    // Another waiter is taking this one over. A claim older than CLAIM_STALE_MS is one whose waiter died between
    // its create and its removal (a takeover takes milliseconds): cleared, so the lock is not stuck for ever; the
    // next attempt claims again.
    if (err?.code === 'EEXIST') {
      try { if (Date.now() - statSync(claim).mtimeMs > CLAIM_STALE_MS) rmSync(claim, { force: true }); } catch {}
    }
    return;
  }
  try {
    if (lockId(path) === judged) rmSync(path, { force: true });
  } finally {
    try { rmSync(claim, { force: true }); } catch {}
  }
}

/** Claims and temp files of the lock left by a process that stopped mid-way, now that this build holds it. */
function sweepLockLeftovers(mcp, ownId) {
  let names = [];
  try { names = readdirSync(mcp); } catch { return; }
  for (const name of names) {
    if (name.startsWith(`${BUILD_LOCK}${CLAIM_INFIX}`)) {
      if (name === `${BUILD_LOCK}${CLAIM_INFIX}${ownId}`) continue;
      try { if (Date.now() - statSync(join(mcp, name)).mtimeMs > CLAIM_STALE_MS) rmSync(join(mcp, name), { force: true }); } catch {}
    } else if (name.startsWith(`${BUILD_LOCK}${TEMP_INFIX}`)) {
      const pid = Number(/\.tmp-(\d+)-/.exec(name)?.[1]);
      if (pid !== process.pid && pidAlive(pid)) continue;
      try { if (Date.now() - statSync(join(mcp, name)).mtimeMs > LOCK_EMPTY_GRACE_MS) rmSync(join(mcp, name), { force: true }); } catch {}
    }
  }
}

/**
 * Take mcp-server/.dist-build.lock once, without waiting: the lock, or null when another build holds it.
 * The lock appears whole: its JSON is written to a temp file first and linked to the lock path (link fails with
 * EEXIST while one is there). A stale lock is removed (removeStaleLock) and the take tried again.
 * Throws only for an error that is not "already there" (the folder is missing).
 */
export function tryBuildLock(mcp) {
  const path = join(mcp, BUILD_LOCK);
  const token = randomBytes(8).toString('hex');
  const temp = `${path}${TEMP_INFIX}${process.pid}-${token}`;
  writeFileSync(temp, JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }), { flag: 'wx' });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(temp, path);
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
        const state = lockState(path);
        if (state && !state.stale) return null;
        if (state) removeStaleLock(path, state.id);
        continue;
      }
      sweepLockLeftovers(mcp, `tok-${token}`);
      return {
        path,
        pid: process.pid,
        token,
        // Only the very lock this build wrote is removed: never one a later build took over.
        release() { try { if (readLockInfo(path)?.token === token) rmSync(path, { force: true }); } catch {} },
      };
    }
    return null;
  } finally {
    try { rmSync(temp, { force: true }); } catch {}
  }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* a runtime without it: no wait */ }
}

/** The lock, waiting up to waitMs (a sync caller: setup.js, postinstall.js). null when still held after that. */
function lockSync(mcp, waitMs) {
  const until = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const lock = tryBuildLock(mcp);
    if (lock) return lock;
    if (Date.now() >= until) return null;
    sleepSync(Math.min(LOCK_POLL_MS, Math.max(1, until - Date.now())));
  }
}

async function lockAsync(mcp, waitMs) {
  const until = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const lock = tryBuildLock(mcp);
    if (lock) return lock;
    if (Date.now() >= until) return null;
    await new Promise(r => setTimeout(r, Math.min(LOCK_POLL_MS, Math.max(1, until - Date.now()))));
  }
}

/** Whether mcp-server/.dist-build.lock is held by a live build right now (a route can say "busy" before it starts). */
export function mcpBuildRunning(packageRoot) {
  const path = join(resolve(packageRoot), 'mcp-server', BUILD_LOCK);
  const state = lockState(path);
  return !!state && !state.stale;
}

// ── Leftovers ──

/** The pid in a `.dist-build-<pid>-<time>` or `.dist-old-<pid>-<time>` name, or null. */
function ownerPid(name) {
  const m = /^\.dist-(?:build|old)-(\d+)-\d+$/.exec(name);
  return m ? Number(m[1]) : null;
}

const byMtimeDesc = (dir) => (a, b) => {
  const t = (n) => { try { return statSync(join(dir, n)).mtimeMs; } catch { return 0; } };
  return t(b) - t(a);
};

/**
 * dist missing or incomplete while a whole old dist lies aside (an update stopped between its two renames, or a
 * rollback that failed): the newest whole old one becomes dist again. Returns true when it did.
 */
function recoverDist(root, mcp, dist, log) {
  if (mcpDistWhole(root).complete) return false;
  let names = [];
  try { names = readdirSync(mcp).filter(n => n.startsWith(OLD_PREFIX)); } catch { return false; }
  for (const name of names.sort(byMtimeDesc(mcp))) {
    const old = join(mcp, name);
    if (!mcpDistWhole(root, old).complete) continue;
    try {
      if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
      renameSync(old, dist);
    } catch (err) {
      log.warn(`Could not put back the previous MCP server build that an interrupted update left aside (${err?.code || err?.message}).`);
      continue;
    }
    log.warn('Put back the previous MCP server build that an interrupted update left aside.');
    return true;
  }
  return false;
}

/** Leftovers of a build or swap that was stopped (a temp folder, an old dist set aside): never one a live build owns. */
function sweep(mcp) {
  let entries = [];
  try { entries = readdirSync(mcp); } catch { return; }
  for (const name of entries) {
    if (!name.startsWith(TEMP_PREFIX) && !name.startsWith(OLD_PREFIX)) continue;
    const pid = ownerPid(name);
    // Another process still building (its folder, while it lives). This build holds the lock, so its own earlier
    // folders, and those of a build whose process is gone, are leftovers.
    if (pid !== null && pid !== process.pid && pidAlive(pid)) continue;
    try { rmSync(join(mcp, name), { recursive: true, force: true }); } catch {}
  }
}

// ── The build ──

/** The messages of a result, for the callers that print: one sentence each. */
const FAILED = (reason, keep) => ({
  'no-compiler': `MCP server build failed: TypeScript is not installed (npm install at the package root installs it).${keep}`,
  'no-source': 'MCP server build is incomplete and this copy has no source to build it from',
  busy: 'MCP server build skipped: another SynaBun process is building it right now.',
  lock: `MCP server build failed: the build lock could not be taken.${keep}`,
  error: `MCP server build failed.${keep}`,
})[reason];

/**
 * Everything of a build but the compile itself: the lock, the recovery, the decision, the temp folder, and (`finish`)
 * the check, the stamp and the swap. The compile is the only step that may be awaited, so the sync entry
 * (postinstall.js, setup.js) and the async one (the Neural Interface's routes) share this and differ only in how
 * they take the lock and run `compile`. `lock` is already held (or null: busy). Never throws.
 * @returns {{ done: object } | { args: object, finish: (err: Error|null, compiled?: { stdout?: string }) => object }}
 */
function startBuild(packageRoot, { force, packaged, compiler, windowsHide, rename, log, lock }) {
  const root = resolve(packageRoot);
  const mcp = join(root, 'mcp-server');
  const dist = join(mcp, 'dist');
  const release = () => { try { lock?.release(); } catch {} };
  const failed = (reason, extra = {}) => { release(); return { done: { status: 'failed', reason, ...extra } }; };
  try {
    if (!lock) {
      log.warn(FAILED('busy'));
      return failed('busy');
    }
    recoverDist(root, mcp, dist, log);
    sweep(mcp);
    const check = mcpBuildNeeded(root, { packaged });
    if (check.reason === 'unreadable') {
      log.fail(`MCP server build failed: the source could not be read (${check.error}).${mcpDistWhole(root).complete ? ' The previous build is kept.' : ''}`);
      return failed('error', { output: check.error });
    }
    if (packaged) {
      // Replaced whole, no compiler: whole is current; not whole is a damaged application, nothing to build it with.
      if (!check.needed) { log.ok('MCP server build shipped with this application'); release(); return { done: { status: 'current', reason: 'packaged' } }; }
      log.fail('MCP server build is incomplete and this application has no compiler: reinstall SynaBun.');
      return failed('no-source');
    }
    if (!force && !check.needed) {
      log.ok(check.reason === 'no-source' ? 'MCP server build shipped with this copy' : 'MCP server build matches the installed source');
      release();
      return { done: { status: 'current', reason: check.reason } };
    }
    const stamp = mcpSourceStamp(root);
    if (!stamp) {
      if (check.needed) log.fail(FAILED('no-source'));
      release();
      return { done: { status: check.needed ? 'failed' : 'current', reason: 'no-source' } };
    }
    const hadDist = mcpDistWhole(root).complete;
    log.info(force ? 'Building the MCP server from the installed source...'
      : `Building the MCP server (${({ incomplete: 'the build is incomplete', unstamped: 'the build has no record of its source', version: 'the version changed', source: 'the source changed' })[check.reason] || check.reason})...`);
    const tsc = compiler === undefined ? mcpCompiler(root) : compiler;
    const keep = hadDist ? ' The previous build is kept.' : '';
    if (!tsc) {
      log.fail(FAILED('no-compiler', keep));
      return failed('no-compiler');
    }
    const temp = join(mcp, `${TEMP_PREFIX}${process.pid}-${Date.now()}`);
    mkdirSync(temp, { recursive: true });   // this build's folder, visible (and spared by every other build's sweep) from here on
    const discard = () => { try { rmSync(temp, { recursive: true, force: true }); } catch {} };
    const finish = (err, compiled = {}) => {
      try {
        if (err) {
          const output = [err.stdout?.toString().trim(), err.stderr?.toString().trim()].filter(Boolean).join('\n') || err.message;
          log.fail(`MCP server build failed.${keep}`);
          log.error(output);
          discard();
          return { status: 'failed', reason: 'compile', output };
        }
        // The new build must be whole before it replaces anything: every runtime entry, checked as if it were dist.
        const missing = mcpDistWhole(root, temp);
        if (!missing.complete) {
          log.fail(`MCP server build failed: the compiler wrote an incomplete build.${keep}`);
          discard();
          return { status: 'failed', reason: 'incomplete-output', output: missing.missing.join('\n') };
        }
        writeFileSync(join(temp, BUILD_STAMP), `${JSON.stringify({ ...stamp, builtAt: new Date().toISOString() }, null, 2)}\n`);
        const old = join(mcp, `${OLD_PREFIX}${process.pid}-${Date.now()}`);
        let movedAside = false;
        try {
          if (existsSync(dist)) { rename(dist, old); movedAside = true; }
          rename(temp, dist);
        } catch (swapErr) {
          if (movedAside && !existsSync(dist)) { try { rename(old, dist); } catch {} }
          discard();
          log.fail(`MCP server build could not replace the previous one (${swapErr.code || swapErr.message}).${keep}`);
          return { status: 'failed', reason: 'swap', output: swapErr.message };
        }
        // Only now, with the new dist in place, is the old one no longer needed.
        if (movedAside) { try { rmSync(old, { recursive: true, force: true }); } catch {} }
        log.ok('MCP server built');
        if (hadDist) log.info(MCP_RESTART_HINT);
        const output = compiled?.stdout ? String(compiled.stdout).trim() : '';
        return { status: 'built', reason: force ? 'forced' : check.reason, ...(output ? { output } : {}) };
      } catch (unexpected) {
        discard();
        log.fail(`MCP server build failed (${unexpected?.message || unexpected}).${keep}`);
        return { status: 'failed', reason: 'error', output: unexpected?.message || String(unexpected) };
      } finally {
        release();
      }
    };
    return { args: { tsc, project: mcp, outDir: temp, cwd: mcp, windowsHide }, finish };
  } catch (unexpected) {
    log.fail(`MCP server build failed (${unexpected?.message || unexpected}).`);
    return failed('error', { output: unexpected?.message || String(unexpected) });
  }
}

const QUIET = { ok() {}, info() {}, warn() {}, fail() {}, error() {} };

/** The lock for a build of `packageRoot`, or null when busy; a lock that cannot be created at all is an error result. */
function takeLockSync(packageRoot, waitMs) {
  try { return { lock: lockSync(join(resolve(packageRoot), 'mcp-server'), waitMs) }; } catch (err) { return { error: err }; }
}

/**
 * Build mcp-server into a temp folder and swap it in only when it succeeded. Never throws.
 * @param {string} packageRoot
 * @param {{ force?: boolean, packaged?: boolean, waitMs?: number, compile?: Function, compiler?: string|null, windowsHide?: boolean,
 *           rename?: Function, log?: { ok: Function, info: Function, warn: Function, fail: Function, error: Function } }} [o]
 *   `waitMs`: how long to wait for another build to finish (0: report `busy` at once).
 * @returns {{ status: 'built'|'current'|'failed', reason: string, output?: string }}
 */
export function buildMcpServerSafely(packageRoot, {
  force = false,
  packaged = false,
  waitMs = 0,
  compile = defaultCompile,
  compiler,
  windowsHide = false,
  rename = renameSync,
  log = QUIET,
} = {}) {
  const taken = takeLockSync(packageRoot, waitMs);
  if (taken.error) { log.fail(FAILED('lock', '')); return { status: 'failed', reason: 'lock', output: taken.error.message }; }
  const build = startBuild(packageRoot, { force, packaged, compiler, windowsHide, rename, log, lock: taken.lock });
  if (build.done) return build.done;
  let compiled;
  try { compiled = compile(build.args); } catch (err) { return build.finish(err); }
  return build.finish(null, compiled);
}

/**
 * The same build with the compile awaited (`compile` may return a promise), for a server that must keep answering
 * while the compiler runs. Same result shape; never rejects.
 */
export async function buildMcpServerSafelyAsync(packageRoot, {
  force = false,
  packaged = false,
  waitMs = 0,
  compile = defaultCompileAsync,
  compiler,
  windowsHide = false,
  rename = renameSync,
  log = QUIET,
} = {}) {
  let lock;
  try { lock = await lockAsync(join(resolve(packageRoot), 'mcp-server'), waitMs); } catch (err) { log.fail(FAILED('lock', '')); return { status: 'failed', reason: 'lock', output: err.message }; }
  const build = startBuild(packageRoot, { force, packaged, compiler, windowsHide, rename, log, lock });
  if (build.done) return build.done;
  let compiled;
  try { compiled = await compile(build.args); } catch (err) { return build.finish(err); }
  return build.finish(null, compiled);
}

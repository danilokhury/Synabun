// Native page WebSockets are safe only behind a server boundary established at listen time: a page in a native
// (MoreLogin) context can open ws://127.0.0.1:<port>/… of any local serve, and an unauthenticated OpenCode serve would
// give it a shell, files and sessions. What admits a serve is how it behaves, checked at run time
// (lib/opencode-serve-probe.js): it listens on loopback only, refuses every sensitive route without its password
// (plain HTTP and WebSocket upgrades, with no credentials and with wrong ones), and accepts the password SynaBun read
// from its own stdout. The version is only a precondition, checked on EVERY verification: it must read as
// MAJOR.MINOR.PATCH and be NATIVE_SERVE_MIN_VERSION or newer, as launched and as the serve reports it.
// For a foreign serve (no password for /api/info), its OS-identified executable must report that version instead;
// the cache includes the executable identity and version, re-read on every scan, as well as the listener generation.
//
// Admission uses build pre-flight evidence and then checks every real process. This is Option 1: a verified build
// may misbehave at runtime before its post-start probe fails (normally <1 s; not an atomic network boundary).
//   - Every new build is checked in a throwaway serve before browser admission. An unverified build never starts
//     while a native context is held: MoreLogin port protection has a 0.0.0.0 bypass, including WebSockets.
//     Only a completed pre-flight (process and listener confirmed gone) admits later launches while attached.
//     A new native attachment still waits for every actual serve's process-bound probe, including startup races.
//   - A serve that fails its check is stopped: SIGTERM, then SIGKILL after a bounded wait, until the OS confirms its
//     process and its listener are gone. Until then (and for good when that cannot be confirmed) every native
//     attachment is refused, and contexts already attached are revoked (one page emptied to about:blank, every other
//     page closed, the browser disconnected: the profile's window is kept, revokeNativeContext). A failure that is only
//     a missing answer (a timeout) stops the serve when a native context is held; otherwise it blocks native
//     attachment and is asked again.
//   - Serves SynaBun did not start (a terminal, another app, an earlier SynaBun), on any port: found by the processes
//     listening on TCP (lib/opencode-serve-scan.js) whenever a context is attached and every NATIVE_WATCH_MS while one
//     is. SynaBun holds no password for them, so the probe asks them as `foreign`: loopback only, every route of the
//     fixed matrix refused without credentials and with wrong ones (HTTP and WebSocket), the password asked before the
//     router, and no guessable password accepted. That is accepted: the serve then answers a page nothing but 401 /
//     403, and SynaBun has no better evidence about a password it does not hold. A foreign serve that fails is never
//     stopped; the browser is refused (attached contexts revoked) with its pid, port and path and the way to fix it.
//     When the listeners cannot be listed or a listener cannot be identified, the browser is refused.
// NATIVE_SERVE_KNOWN_GOOD are the versions whose authentication was inspected by hand (2.1.4; 2.2.5, Homebrew
// anomalyco/tap/opencode-v2, 2026-11-01). They are probed like every other version: known-good only means "expected to
// pass", shown in Settings. Started from a Settings command line (its binary is unknown) or with a password that is
// not private to stdout is never admitted. There is no setting or variable that skips any of this.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { binaryIdentity, binaryKey, probeOpencodeServe } from './opencode-serve-probe.js';
import { isOpencodePath, listenerGenerationKey, scanOpencodeServes } from './opencode-serve-scan.js';
import { listListenAddressesAsync, listPortListenersAsync, pidExists, readProcessExecutableAsync, readProcessIdentityAsync } from './process-identity.js';

export const NATIVE_SERVE_KNOWN_GOOD = Object.freeze(['2.1.4', '2.2.5']);
// The name older callers import: the versions checked by hand.
export const NATIVE_SERVE_VERSIONS = NATIVE_SERVE_KNOWN_GOOD;
export const NATIVE_SERVE_MIN_VERSION = '2.1.0';
// How often the OpenCode serves of this computer are looked at again while a native context is attached.
export const NATIVE_WATCH_MS = 15_000;
// How long a watch pass waits for a foreign serve that failed only by not answering to be confirmed gone (ensureWatch).
export const NATIVE_EXIT_GRACE_MS = 3_000;

/** "2.3.0", "v2.3.0", "opencode v2.3.0" → "2.3.0"; null for anything else (a prerelease, four parts, extra words). */
export function nativeServeVersionOf(version) {
  const bare = String(version ?? '').trim().replace(/^opencode\s+/i, '').replace(/^v(?=\d)/i, '');
  const m = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/.exec(bare);
  return m ? { text: bare, major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

const MIN = nativeServeVersionOf(NATIVE_SERVE_MIN_VERSION);
const atLeastMinimum = (v) => v.major !== MIN.major ? v.major > MIN.major : v.minor !== MIN.minor ? v.minor > MIN.minor : v.patch >= MIN.patch;

/**
 * What the version alone says, before any probe: `{ ok, version, knownGood, reason }`, `reason` 'version-unreadable'
 * or 'version-old' when `ok` is false.
 */
export function nativeServeVersionPolicy(version) {
  const v = nativeServeVersionOf(version);
  if (!v) return { ok: false, version: version ? String(version).trim() : null, knownGood: false, reason: 'version-unreadable' };
  if (!atLeastMinimum(v)) return { ok: false, version: v.text, knownGood: false, reason: 'version-old' };
  return { ok: true, version: v.text, knownGood: NATIVE_SERVE_KNOWN_GOOD.includes(v.text), reason: null };
}

/** May a serve of this launch be admitted once its probe passes? No Settings command line, stdout password, version policy. */
export function nativeServeCapability({ version, commandLine = false, passwordFrom } = {}) {
  return !commandLine && passwordFrom === 'stdout' && nativeServeVersionPolicy(version).ok;
}

// Why a serve cannot be admitted at all (no probe would change it), in words that name what to change; null when the
// probe decides.
export function nativeServeReason({ version, commandLine = false, passwordFrom } = {}) {
  if (commandLine) return 'command-line';
  if (passwordFrom !== 'stdout') return 'password';
  return nativeServeVersionPolicy(version).reason;
}

const BASE = `Native browser WebSockets require authenticated OpenCode serves: OpenCode ${NATIVE_SERVE_MIN_VERSION} or newer, started by SynaBun with its private stdout password, that pass SynaBun's runtime check (listening on loopback only, refusing every sensitive /api request and WebSocket upgrade without the password, accepting SynaBun's), and no other OpenCode serve on this computer that answers without its password; wait for startup, or act on the serve named below.`;

const MAX_COMMAND = 200;
const short = (text, max = MAX_COMMAND) => {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const pidOf = (o) => (Number.isInteger(o?.pid) && o.pid > 0 ? o.pid : null);

// The fields of an offender a caller may see (a route's answer, a dispatch error): what names the serve, never its
// token, its password or the rest of its record. A command line is shortened.
export function narrowOffenders(offenders = []) {
  return (Array.isArray(offenders) ? offenders : []).map((o) => {
    const out = { reason: String(o?.reason || 'unknown'), pid: pidOf(o), port: Number(o?.port) > 0 ? Number(o.port) : null };
    if (o?.path) out.path = short(o.path, 400);
    if (o?.command) out.command = short(o.command, 400);
    if (o?.version) out.version = String(o.version).trim();
    if (o?.check) out.check = String(o.check);
    if (o?.detail) out.detail = short(o.detail, 400);
    if (o?.state) out.state = String(o.state);
    if (o?.reason === 'record') { out.kind = o.kind || null; out.claimable = !!o.claimable; }
    return out;
  });
}

// What a person can do about a serve SynaBun started that is not admitted.
function remedy(o, { report = false } = {}) {
  const pid = pidOf(o);
  const steps = [`stop this serve (close the OpenCode panel${pid ? ` / end pid ${pid}` : ''})`, 'choose another OpenCode under Settings → Executable paths'];
  if (report) steps.push(`or report the incompatibility (OpenCode ${o.version ? String(o.version).trim() : 'of unknown version'}, failed check "${o.check || 'unknown'}")`);
  return `${steps.join(', ')}. Settings → Executable paths → Verify OpenCode checks again`;
}

function describeOffender(o) {
  const pid = pidOf(o);
  const where = [pid ? `pid ${pid}` : null, o.port ? `port ${o.port}` : null].filter(Boolean).join(', ');
  const what = [o.path || null, o.command ? `command ${short(o.command)}` : null, o.version ? `version ${String(o.version).trim()}` : null].filter(Boolean).join(', ');
  const head = `OpenCode serve ${where || '(unknown process)'}${what ? ` (${what})` : ''}`;
  switch (o.reason) {
    case 'probe': return `${head}: failed SynaBun's runtime authentication check "${o.check || 'unknown'}": ${o.detail || 'not verified'}. Fix: ${remedy(o, { report: true })}`;
    case 'verifying': return `${head}: its authentication is being checked; try again in a moment`;
    case 'build-checking': return `${head}: automatic build pre-flight is running; native browser admission waits until its throwaway listener is confirmed gone`;
    case 'exposure': return o.state === 'stuck'
      ? `${head}: failed SynaBun's runtime authentication check "${o.check || 'unknown'}" and SynaBun could not confirm that it stopped (its process or its listener is still there, or the OS could not say). Fix: end ${pid ? `pid ${pid}` : 'that serve'} (kill -9 ${pid || '<pid>'}), check that nothing listens on port ${o.port} (lsof -nP -iTCP:${o.port} -sTCP:LISTEN), then try again`
      : `${head}: failed SynaBun's runtime authentication check "${o.check || 'unknown'}" (${o.detail || 'not verified'}) and is being stopped; the native browser waits until its listener is gone`;
    case 'foreign': return `${head}: not started by SynaBun, and failed SynaBun's runtime authentication check "${o.check || 'unknown'}": ${o.detail || 'not verified'}. SynaBun never stops a serve it did not start. Fix: stop it yourself${pid ? ` (kill ${pid})` : ''}, update to OpenCode ${NATIVE_SERVE_MIN_VERSION} or newer (opencode upgrade), or choose another executable under Settings → Executable paths. Start it on 127.0.0.1 with both OPENCODE_PASSWORD and OPENCODE_SERVER_PASSWORD unset so it generates a private password. If the check still fails, report the incompatibility and this failed check`;
    case 'foreign-checking': return `${head}: an OpenCode serve SynaBun did not start is being checked; try again in a moment`;
    case 'foreign-scan': return `SynaBun could not tell which OpenCode serves run on this computer: ${o.detail || 'the listening processes could not be read'}. Fix: check that lsof works (lsof -nP -iTCP -sTCP:LISTEN), then try again`;
    case 'unverified-build': return `${head}: this build has not completed automatic pre-flight verification. A native browser is attached, so the unverified build is not started. Verification runs before browser admission or after attached contexts finish; MoreLogin port protection alone cannot isolate it (0.0.0.0 bypass). ${o.detail || ''}`;
    case 'version-old': return `${head}: OpenCode older than ${NATIVE_SERVE_MIN_VERSION} was never checked by SynaBun. Fix: update OpenCode (opencode upgrade), or ${remedy(o)}`;
    case 'version-unreadable': return `${head}: its version cannot be read as MAJOR.MINOR.PATCH, so SynaBun does not admit it. Fix: ${remedy(o)}`;
    case 'version': return `${head}: this OpenCode version is not one SynaBun admits (${NATIVE_SERVE_MIN_VERSION} or newer that passes the runtime check). Fix: ${remedy(o)}`;
    case 'command-line': return `${head}: started from the OpenCode command line set in Settings (its version cannot be read, nor its binary checked); clear it so SynaBun starts the executable it checks, or stop this serve`;
    case 'password': return `${head}: started without a private stdout password`;
    case 'starting': return `${head}: still starting; try again once OpenCode answers`;
    case 'untracked-port': return `${head}: answers on a port SynaBun did not start in this run; stop the process listening on port ${o.port}`;
    case 'record': {
      const kind = o.kind ? `, kind ${o.kind}` : '';
      if (o.claimable) return `${head}: left running by an earlier SynaBun that has ended${kind}; it could not be stopped automatically: end ${pid ? `pid ${pid}` : 'that serve'}`;
      // Not confirmed: the owner may still run, or the OS could not say whether this pid is still that serve (a pid
      // is reused once its process ends). Never ask the user to end a number that may be another program now.
      return `${head}: on record from another SynaBun process, or one whose identity the OS could not confirm${kind}. It is unconfirmed${pid ? ` whether pid ${pid} is still this serve (the number may belong to another program by now)` : ''}: check ${pid ? `that pid ${pid}'s command line is the one shown (ps -o command= -p ${pid}; on Windows, Task Manager → Details → Command line column)` : 'the OpenCode serves that are running'} before ending it, or close the other SynaBun`;
    }
    default: return `${head}: not verified`;
  }
}

export function nativeServeError(offenders = []) {
  const list = offenders.map(describeOffender);
  const error = new Error(list.length ? `${BASE} Blocking: ${list.join('; ')}.` : BASE);
  error.code = 'NATIVE_SERVE_UNVERIFIED';
  error.offenders = narrowOffenders(offenders);
  return error;
}

const nativeContextClosed = () => Object.assign(new Error('The browser closed while SynaBun was checking its OpenCode serves; nothing was attached.'), { code: 'NATIVE_CONTEXT_CLOSED' });
const nativeAttachAborted = () => Object.assign(new Error('The browser request ended while SynaBun was checking its OpenCode serves; nothing was attached.'), { code: 'NATIVE_ATTACH_ABORTED' });
const defaultSleep = (ms) => new Promise((done) => { const t = setTimeout(done, ms); t.unref?.(); });
// `work`, or null once `ms` passed (never rejects).
const within = (work, ms) => {
  if (!(ms > 0)) return Promise.resolve(null);
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.min(ms, 2_147_000_000)); timer.unref?.(); });
  return Promise.race([Promise.resolve(work).catch(() => null), late]).finally(() => clearTimeout(timer));
};

/**
 * Verdicts about builds (a binary and its version, binaryKey): what Settings says about the OpenCode SynaBun would
 * start. In memory; `createVerdictFile` keeps them across restarts. Only a definitive answer is kept (never a
 * timeout); `get` answers `{ ok, failed, detail, version, at }` or null. A persisted diagnostic verdict never grants admission:
 * each serve is checked itself.
 */
export function createVerdictMemory({ max = 50 } = {}) {
  const map = new Map();
  return {
    get: (key) => (key && map.get(key)) || null,
    set(key, verdict) {
      if (!key) return;
      map.delete(key);
      map.set(key, { ok: !!verdict.ok, failed: verdict.failed || null, detail: verdict.detail || null, version: verdict.version || null, at: Number(verdict.at) || Date.now() });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    delete: (key) => { map.delete(key); },
    entries: () => [...map.entries()],
  };
}

/**
 * createVerdictMemory kept in a JSON file (`DATA_HOME/data/opencode-serve-verdicts.json`): read once, written whole
 * through a rename after each change. A file that cannot be read starts empty; a write that fails keeps the memory.
 * It holds binary keys and verdict sentences, never a password.
 */
export function createVerdictFile({ file, max = 50, read = readFileSync, write = writeFileSync, rename = renameSync, mkdir = mkdirSync } = {}) {
  // `file` may be a function: the path is asked (and the file read) on first use, so a module can build its boundary
  // before it knows its data folder.
  let memory = null;
  let path = null;
  const load = () => {
    if (memory) return memory;
    memory = createVerdictMemory({ max });
    try { path = typeof file === 'function' ? file() : file; } catch { path = null; }
    if (!path) return memory;
    try {
      const saved = JSON.parse(read(path, 'utf8'));
      for (const [key, verdict] of Array.isArray(saved?.verdicts) ? saved.verdicts : []) {
        if (typeof key === 'string' && verdict && typeof verdict === 'object') memory.set(key, verdict);
      }
    } catch { /* nothing kept yet */ }
    return memory;
  };
  const save = () => {
    if (!path) return;
    try {
      mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      write(tmp, `${JSON.stringify({ version: 1, verdicts: memory.entries() }, null, 2)}\n`, { mode: 0o600 });
      rename(tmp, path);
    } catch { /* kept in memory for this run */ }
  };
  return {
    get: (key) => load().get(key),
    entries: () => load().entries(),
    set(key, verdict) { if (!key) return; load().set(key, verdict); save(); },
    delete(key) { if (!key || !load().get(key)) return; memory.delete(key); save(); },
  };
}

/**
 * Which process listens, at one moment: `{ pid, startedAt, executable, addresses, key }` (`key`
 * listenerGenerationKey: pid, start time, sockets), or null when the OS could not say (fail closed: such a serve is
 * not verified).
 */
export async function readServeGeneration(pid, { identity = readProcessIdentityAsync, executable = readProcessExecutableAsync, addresses = listListenAddressesAsync } = {}) {
  if (!(Number.isInteger(pid) && pid > 0)) return null;
  const [id, exe, socks] = await Promise.all([
    Promise.resolve().then(() => identity(pid)).catch(() => null),
    Promise.resolve().then(() => executable(pid)).catch(() => null),
    Promise.resolve().then(() => addresses(pid)).catch(() => null),
  ]);
  if (!id?.startedAt || !Array.isArray(socks)) return null;
  return { pid, startedAt: id.startedAt, executable: exe || null, addresses: socks, key: listenerGenerationKey({ pid, startedAt: id.startedAt, addresses: socks }) };
}

// Contexts this process revoked: context → { at, why }. server.js reads it when the context's close event comes, so a
// revocation is never reported as a profile "closed outside SynaBun" and never blocks the runs that worked there.
const _revoked = new WeakMap();

/** When and why SynaBun revoked `context` ({ at, why }), or null. */
export function nativeContextRevocation(context) {
  if (!context || (typeof context !== 'object' && typeof context !== 'function')) return null;
  return _revoked.get(context) || null;
}

/**
 * Take a native context's pages away from a serve that failed: no page of it runs a site's script any more, then the
 * browser connection is closed, so SynaBun's session must attach again (through the boundary). Bounded; never throws.
 *
 * The browser's window is kept (2026-11-15). Before, every page was closed: closing the last tab of a MoreLogin
 * profile closes its window, MoreLogin then closes the whole profile (envkit log: close_click + CloseBrowser), and the
 * runs' next browser call started it again, which spends one of the plan's daily launches. On 2026-11-15 at 21:13:30
 * one revocation (a foreign OpenCode serve, pid 21487, failed "http-anonymous" while it was exiting) closed P-1 and P-4
 * 37 ms apart, and one at 21:14:22 (pid 54472, exiting too) closed P-1 again. Now one page is emptied
 * (about:blank: the page that was there runs no more script) and every other page is closed; only when the emptying
 * fails is that page closed too (the window may then go: the boundary's protection comes first).
 */
export async function revokeNativeContext(context, { timeoutMs = 5_000, why = null, stepMs = 2_000 } = {}) {
  try { if (context && typeof context === 'object') _revoked.set(context, { at: Date.now(), why: why ? String(why).slice(0, 500) : null }); } catch { /* not markable */ }
  const work = (async () => {
    let pages = [];
    try { pages = (context?.pages?.() || []).filter((page) => !page?.isClosed?.()); } catch { pages = []; }
    const [keep, ...rest] = pages;
    const close = (page) => Promise.resolve().then(() => page.close({ runBeforeUnload: false })).catch(() => {});
    // The kept page: emptied within `stepMs`, else (an error, no answer) closed after all.
    const empty = async (page) => {
      let timer;
      const late = new Promise((resolve) => { timer = setTimeout(() => resolve('late'), stepMs); timer.unref?.(); });
      const done = await Promise.race([Promise.resolve().then(() => page.goto('about:blank')).then(() => 'empty', () => 'failed'), late])
        .finally(() => clearTimeout(timer));
      if (done !== 'empty') await close(page);
    };
    await Promise.all([...rest.map(close), keep ? empty(keep) : null]);
    try { await context?.browser?.()?.close?.(); } catch { /* already gone */ }
  })();
  await within(work, timeoutMs);
}

const sameIdentity = (a, b) => (!a && !b) || (!!a && !!b && a.realpath === b.realpath && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev);
// No shell, no server launch and bounded output/time. A foreign listener's version is not public over HTTP when
// its authentication works; ask the executable the OS identified instead. Interpreters cannot identify the script
// they run this way, so those foreign serves fail closed rather than treating `node --version` as OpenCode.
export function readOpencodeBinaryVersion(identity, { run = execFile } = {}) {
  if (!identity?.native || !isOpencodePath(identity.realpath)) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      run(identity.realpath, ['--version'], { timeout: 2000, maxBuffer: 16_384, windowsHide: true },
        (error, stdout) => resolve(error ? null : nativeServeVersionOf(stdout)?.text || null));
    } catch { resolve(null); }
  });
}
const INTERPRETER = /^(?:node|nodejs|bun|deno)(?:\.exe)?$/i;
const exited = (proc) => !proc || proc.exitCode != null || proc.signalCode != null;

/**
 * The boundary. `probe` asks a serve (lib/opencode-serve-probe.js probeOpencodeServe), `identify` reads the binary a
 * serve was started from (binaryIdentity), `verdicts` keeps what is known about builds, `scan` lists the OpenCode
 * serves of this computer (lib/opencode-serve-scan.js), `readGeneration` which process listens (readServeGeneration),
 * `portListeners` / `pidAlive` / `signalPid` confirm and enforce a stop, `revoke` takes an attached context away.
 */
export function createNativeServeBoundary({ probe = probeOpencodeServe, identify = binaryIdentity, readVersion = readOpencodeBinaryVersion, verdicts = createVerdictMemory(),
  scan = scanOpencodeServes, readGeneration = readServeGeneration, portListeners = listPortListenersAsync, pidAlive = pidExists,
  signalPid = (pid, signal) => process.kill(pid, signal), revoke = revokeNativeContext, platform = process.platform,
  now = Date.now, retryMs = 5_000, termMs = 3_000, killMs = 3_000, gonePollMs = 100, refreshMs = 8_000, foreignTtlMs = 5 * 60_000,
  watchMs = NATIVE_WATCH_MS, exitGraceMs = NATIVE_EXIT_GRACE_MS, exitPollMs = 250, preflight = null, log = () => {} } = {}) {
  const processes = new Map();
  // Process-local admission evidence: persisted diagnostic verdicts and ordinary runtime passes cannot grant it.
  const builds = new Map(), buildChecks = new Map();
  let verificationEpoch = 0;
  // Every native context that relies on the boundary, attached or still being checked (a reservation): while any is
  // held, assertLaunch admits only builds that completed a throwaway pre-flight. A context is held from before its check until it closes, its browser
  // disconnects, its attachment fails or it is revoked. `attached`: its check passed (its pages are SynaBun's to use).
  const contexts = new Map();
  // Serves that failed and are being stopped ('removing') or whose stop could not be confirmed ('stuck'): each blocks
  // every native attachment until the OS confirms its process and its listener are gone.
  const exposures = new Map();
  // Serves SynaBun did not start: the last look (`result`), the look under way, and a verdict per listening process.
  const foreign = { result: null, scanning: null, verdicts: new Map() };
  let watchTimer = null;

  const attachedContexts = () => [...contexts.entries()].filter(([, rec]) => rec.attached);
  const ownPids = () => {
    const pids = new Set();
    for (const [proc, e] of processes) { if (proc.pid) pids.add(proc.pid); if (e.pid) pids.add(e.pid); }
    for (const x of exposures.values()) { if (x.pid) pids.add(x.pid); if (x.procPid) pids.add(x.procPid); }
    return pids;
  };

  // Every attached context is taken away (pages closed, connection closed); it stays held until that is done, so
  // nothing starts meanwhile. A context still being checked is refused by its own attach.
  function revokeAll(why) {
    for (const [context, rec] of attachedContexts()) {
      if (rec.revoking) continue;
      rec.revoking = true;
      log(`revoking a native browser context: ${why}`);
      Promise.resolve().then(() => revoke(context, { why })).catch(() => {}).finally(() => rec.release());
    }
  }

  // Is the stopped serve gone: its process ended, the pid that listened ended, and the OS lists neither on its port?
  async function gone(x) {
    if (!exited(x.proc)) return false;
    // The pid that listened, when it is not the spawned process: still there (or the OS cannot tell) is not gone.
    if (x.pid && x.pid !== x.procPid && pidAlive(x.pid) !== false) return false;
    let pids;
    try { pids = await portListeners(x.port); } catch { pids = null; }
    if (!Array.isArray(pids)) return false;
    return !pids.includes(x.pid) && !pids.includes(x.procPid);
  }
  async function waitGone(x, ms) {
    const end = now() + ms;
    for (;;) {
      if (await gone(x)) return true;
      if (now() >= end) return false;
      await defaultSleep(Math.max(1, Math.min(gonePollMs, end - now())));
    }
  }

  // Stop a serve that failed: SIGTERM, then SIGKILL (to the process SynaBun spawned and to the pid that listens, when
  // that is its own), each followed by a bounded wait for the OS to confirm the process and the listener are gone.
  function terminate(proc, entry, verdict) {
    const id = `${entry.port}|${entry.pid || proc.pid || '?'}`;
    const known = exposures.get(id);
    if (known) return known.done;
    const x = { id, proc, port: entry.port, pid: entry.pid || proc.pid || null, procPid: proc.pid || null, path: entry.path || null, version: entry.version || null,
      check: verdict.failed, detail: verdict.detail, state: 'removing', since: now(), done: null };
    exposures.set(id, x);
    const send = (signal) => {
      try { entry.kill(signal); } catch { /* the wait below tells */ }
      if (entry.pidOwned && x.pid && x.pid !== x.procPid) { try { signalPid(x.pid, signal); } catch { /* gone, or not ours to signal */ } }
    };
    x.done = (async () => {
      send('SIGTERM');
      if (await waitGone(x, termMs)) { exposures.delete(id); log(`OpenCode serve pid ${x.pid} port ${x.port} stopped (${x.check === 'preflight-cleanup' ? 'build pre-flight finished' : `it failed the runtime check "${x.check}"`})`); return true; }
      log(`OpenCode serve pid ${x.pid} port ${x.port} still runs ${Math.round(termMs / 1000)} s after SIGTERM: SIGKILL`);
      send('SIGKILL');
      if (await waitGone(x, killMs)) { exposures.delete(id); log(`OpenCode serve pid ${x.pid} port ${x.port} stopped by SIGKILL`); return true; }
      x.state = 'stuck';
      log(`OpenCode serve pid ${x.pid} port ${x.port} failed its runtime check and could not be confirmed stopped: native browsers stay refused`);
      return false;
    })();
    return x.done;
  }
  // A stop that could not be confirmed is looked at again (never signalled again: the pid may be another process now).
  async function recheckStuck(x) {
    if (x.state !== 'stuck' || x.rechecking) return;
    x.rechecking = true;
    try { if (await gone(x)) { exposures.delete(x.id); log(`OpenCode serve pid ${x.pid} port ${x.port} is gone now`); } } finally { x.rechecking = false; }
  }

  function onFailure(proc, entry, verdict) {
    const held = contexts.size > 0;
    builds.delete(entry.launchKey);
    verificationEpoch++;
    log(`OpenCode serve pid ${entry.pid || proc.pid || '?'} port ${entry.port} (version ${entry.version || '?'}) failed the runtime check "${verdict.failed}": ${verdict.detail}`);
    // A definitive failure is a serve SynaBun cannot vouch for: stopped. A missing answer stops it only while a
    // native context relies on the boundary (otherwise it blocks attachment and is asked again).
    if (!verdict.transient || held) terminate(proc, entry, verdict);
    if (held) revokeAll(`OpenCode serve pid ${entry.pid || proc.pid || '?'} port ${entry.port} failed "${verdict.failed}"`);
  }

  // Is the process that listens the one SynaBun started? Its executable as the OS maps it: the very file pinned at
  // launch when that file is a native executable (macOS / Linux, where SynaBun execs its real path); an OpenCode
  // path or a script interpreter when the launcher is a script (npm's shim starts the platform binary); on Windows
  // the launcher is the resolver's spec, so the executable is only required to be readable.
  function processCheck(entry, before, after) {
    const pid = entry.pid;
    if (!before || !after) return { id: 'process', ok: false, transient: true, detail: `pid ${pid || '?'}: its start time or its sockets could not be read` };
    if (before.key !== after.key) return { id: 'process', ok: false, transient: true, detail: `pid ${pid}: the process or its sockets changed while it was checked` };
    const exe = after.executable;
    if (!exe) return { id: 'process', ok: false, transient: true, detail: `pid ${pid}: the executable it runs could not be read` };
    if (platform !== 'win32') {
      const pinned = entry.identity?.native ? entry.identity.realpath : null;
      if (pinned && exe !== pinned) return { id: 'process', ok: false, detail: `pid ${pid} runs ${exe}, not the OpenCode SynaBun started (${pinned})` };
      if (!pinned && !isOpencodePath(exe) && !INTERPRETER.test(exe.split(/[\\/]/).pop() || '')) return { id: 'process', ok: false, detail: `pid ${pid} runs ${exe}, which is not OpenCode` };
    }
    return { id: 'process', ok: true, detail: `pid ${pid} (started ${after.startedAt}) runs ${exe}` };
  }

  // Probe one tracked serve (one probe at a time per serve), bound to the process and sockets read before and after.
  function startProbe(proc, entry) {
    if (entry.probing) return entry.probing;
    const run = (async () => {
      const before = await Promise.resolve().then(() => readGeneration(entry.pid)).catch(() => null);
      let result;
      try { result = await probe({ port: entry.port, pid: entry.pid, password: entry.password }); }
      catch (error) { result = { ok: false, failed: 'loopback', transient: true, detail: `the probe failed: ${String(error?.message || error)}`, checks: [] }; }
      if (!result || typeof result !== 'object') result = { ok: false, failed: 'loopback', transient: true, detail: 'the probe gave no answer', checks: [] };
      const after = await Promise.resolve().then(() => readGeneration(entry.pid)).catch(() => null);
      // What the serve says it is (GET /api/info with its password) is the version that counts, and it is checked
      // against the policy every time, never only when it changed.
      const reported = result.version != null ? String(result.version).trim() : null;
      const policy = nativeServeVersionPolicy(reported);
      if (reported) {
        entry.version = policy.version || reported;
        entry.knownGood = policy.knownGood;
        entry.launchKey = binaryKey(entry.identity, entry.version);
      }
      const extra = [processCheck(entry, before, after),
        policy.ok ? { id: 'version', ok: true, detail: `OpenCode ${policy.version}` }
          : { id: 'version', ok: false, detail: reported ? `the serve reports OpenCode ${reported}, which SynaBun does not admit (${NATIVE_SERVE_MIN_VERSION} or newer, MAJOR.MINOR.PATCH)` : 'the serve did not report its version with SynaBun\'s password' }];
      const firstExtra = extra.find((c) => !c.ok) || null;
      const ok = !!result.ok && !firstExtra;
      const failed = !result.ok ? (result.failed || 'unknown') : firstExtra ? firstExtra.id : null;
      const verdict = {
        ok, failed,
        detail: ok ? (result.detail || 'every check passed') : !result.ok ? (result.detail || null) : firstExtra.detail,
        transient: !ok && (!result.ok ? !!result.transient : !!firstExtra.transient),
        exposed: !ok && !!result.exposed,
        checks: [...(Array.isArray(result.checks) ? result.checks : []), ...extra.map(({ id, ok: pass, detail }) => ({ id, ok: pass, detail }))],
        at: now(), version: entry.version || null, generation: after, matrix: result.matrix || null,
      };
      if (processes.get(proc) !== entry) return verdict;
      entry.verdict = verdict;
      if (!verdict.transient) verdicts.set(entry.launchKey, verdict);
      if (!verdict.ok) onFailure(proc, entry, verdict);
      return verdict;
    })().finally(() => { entry.probing = null; });
    entry.probing = run;
    return run;
  }

  // Where a tracked serve stands now: 'refused' (never admissible), 'starting', 'verifying', 'verified' or 'failed'.
  // A ready serve without a verdict, one whose binary changed since its verdict, or one whose last probe got no answer
  // a while ago is probed (again) here.
  function stateOf(proc, e) {
    if (!e.safe) return 'refused';
    if (!e.ready) return 'starting';
    if (e.probing) return 'verifying';
    const current = e.path ? identify(e.path) : null;
    const changed = !sameIdentity(current, e.seen);
    if (changed) e.seen = current;
    const v = e.verdict;
    if (!v || changed || (!v.ok && v.transient && now() - v.at >= retryMs)) { startProbe(proc, e); return 'verifying'; }
    return v.ok ? 'verified' : 'failed';
  }

  // ── Serves SynaBun did not start ──
  async function probeForeign(serve) {
    const key = listenerGenerationKey(serve);
    let rec = foreign.verdicts.get(key);
    if (rec?.probing) return rec.probing;
    const identity = identify(serve.executable);
    const version = await Promise.resolve().then(() => readVersion(identity)).catch(() => null);
    const policy = nativeServeVersionPolicy(version);
    // Read on every scan, including a cache hit: Homebrew may replace a file without changing its size or mtime,
    // and a version change must invalidate the verdict even when those two fields stayed the same.
    const cacheKey = identity && policy.ok ? `${key}|${serve.executable}|${binaryKey(identity, policy.version)}` : null;
    const v = rec?.verdict;
    if (cacheKey && rec?.cacheKey === cacheKey && v && now() - v.at < foreignTtlMs && !(v.transient && now() - v.at >= retryMs)) return v;
    if (!rec) { rec = { serve, verdict: null, probing: null }; foreign.verdicts.set(key, rec); }
    rec.serve = serve;
    rec.cacheKey = cacheKey;
    const ports = [...new Set((serve.addresses || []).map((a) => Number(a.port)).filter((p) => p > 0))];
    rec.probing = (async () => {
      let verdict = null;
      if (!identity || !policy.ok) {
        const failed = !identity ? 'binary' : 'version';
        const detail = !identity ? `the executable of pid ${serve.pid} (${serve.executable || 'unknown path'}) could not be identified`
          : policy.reason === 'version-old' ? `OpenCode ${policy.version} is older than ${NATIVE_SERVE_MIN_VERSION}`
            : 'the listening executable did not report an OpenCode MAJOR.MINOR.PATCH version';
        rec.verdict = { ok: false, failed, detail, version: policy.version, transient: !identity || policy.reason === 'version-unreadable', checks: [{ id: failed, ok: false, detail }], at: now(), port: ports[0] || null };
        return rec.verdict;
      }
      const before = await Promise.resolve().then(() => readGeneration(serve.pid)).catch(() => null);
      for (const port of ports) {
        let result;
        try { result = await probe({ port, pid: serve.pid, password: null, foreign: true }); }
        catch (error) { result = { ok: false, failed: 'loopback', transient: true, detail: `the probe failed: ${String(error?.message || error)}`, checks: [] }; }
        if (!result || typeof result !== 'object') result = { ok: false, failed: 'loopback', transient: true, detail: 'the probe gave no answer', checks: [] };
        verdict = { ok: !!result.ok, failed: result.ok ? null : (result.failed || 'unknown'), detail: result.detail || null, transient: !result.ok && !!result.transient,
          exposed: !result.ok && !!result.exposed, checks: Array.isArray(result.checks) ? result.checks : [], at: now(), port, matrix: result.matrix || null };
        if (!verdict.ok) break;
      }
      if (!verdict) verdict = { ok: false, failed: 'loopback', detail: `pid ${serve.pid} listens on no TCP port`, transient: true, checks: [], at: now(), port: null };
      const after = await Promise.resolve().then(() => readGeneration(serve.pid)).catch(() => null);
      const stable = before && after && before.key === after.key && before.executable === after.executable && after.executable === serve.executable
        && sameIdentity(identity, identify(serve.executable));
      const extra = [
        { id: 'process', ok: !!stable, detail: stable ? `pid ${serve.pid} and its executable stayed the same`
          : `pid ${serve.pid}: its process, executable or sockets changed or could not be read during verification` },
        { id: 'version', ok: true, detail: `OpenCode ${policy.version}` },
      ];
      if (verdict.ok && !stable) Object.assign(verdict, { ok: false, failed: 'process', transient: true, detail: extra[0].detail });
      verdict.version = policy.version;
      verdict.checks.push(...extra);
      rec.verdict = verdict;
      if (!verdict.ok) log(`OpenCode serve pid ${serve.pid} port ${verdict.port ?? '?'} (${serve.executable || serve.command || '?'}), not started by SynaBun, failed the runtime check "${verdict.failed}": ${verdict.detail}`);
      return verdict;
    })().finally(() => { rec.probing = null; });
    return rec.probing;
  }

  function refreshForeign() {
    if (foreign.scanning) return foreign.scanning;
    foreign.scanning = (async () => {
      let result;
      try { result = await scan(); } catch (error) { result = { ok: false, detail: String(error?.message || error) }; }
      if (!result || typeof result !== 'object') result = { ok: false, detail: 'the scan gave no answer' };
      if (result.ok && (!Array.isArray(result.serves) || result.serves.some((s) => !Number.isInteger(s?.pid) || s.pid <= 0
        || !s.startedAt || !Array.isArray(s.addresses) || !s.addresses.length))) {
        result = { ok: false, detail: 'the listener scan returned an incomplete process or socket list' };
      }
      const own = ownPids();
      const serves = result.ok ? (Array.isArray(result.serves) ? result.serves : []).filter((s) => Number.isInteger(s?.pid) && !own.has(s.pid)) : [];
      foreign.result = { ok: !!result.ok, detail: result.ok ? null : (result.detail || 'the scan failed'), serves, at: now() };
      const live = new Set(serves.map(listenerGenerationKey));
      for (const key of [...foreign.verdicts.keys()]) if (!live.has(key) && !foreign.verdicts.get(key).probing) foreign.verdicts.delete(key);
      const checked = await Promise.allSettled(serves.map(probeForeign));
      if (checked.some((r) => r.status === 'rejected')) foreign.result = { ok: false, detail: 'an OpenCode executable or its verification result could not be read', serves: [], at: now() };
      return foreign.result;
    })().finally(() => { foreign.scanning = null; });
    return foreign.scanning;
  }

  function foreignOffenders(excluded) {
    const out = [];
    if (!foreign.result) { refreshForeign(); return [{ pid: null, port: null, reason: 'foreign-checking' }]; }
    // A bounded refresh may return while lsof / --version / a probe is still pending. Its old verdict cannot
    // admit a browser then: the very identity used as the cache key has not finished being checked.
    if (foreign.scanning) return [{ pid: null, port: null, reason: 'foreign-checking' }];
    if (!foreign.result.ok) return [{ pid: null, port: null, reason: 'foreign-scan', detail: foreign.result.detail }];
    for (const s of foreign.result.serves) {
      if (excluded.has(s.pid)) continue;
      const rec = foreign.verdicts.get(listenerGenerationKey(s));
      const base = { pid: s.pid, port: s.addresses?.[0]?.port || null, path: s.executable || null, command: s.command || null, version: rec?.verdict?.version || null };
      if (!rec || rec.probing || !rec.verdict) { if (!rec?.probing) probeForeign(s); out.push({ ...base, reason: 'foreign-checking' }); continue; }
      if (!rec.verdict.ok) out.push({ ...base, port: rec.verdict.port || base.port, reason: 'foreign', check: rec.verdict.failed, detail: rec.verdict.detail });
    }
    return out;
  }

  /**
   * Look again at what may have changed since the last look, bounded by `refreshMs`: whether each verified serve is
   * still the process and sockets its verdict was about (else it is probed again, and waited for), the OpenCode serves
   * SynaBun did not start (listed and probed), and stops that could not be confirmed.
   */
  async function refresh() {
    const jobs = [];
    for (const [proc, e] of processes) {
      if (!e.safe || !e.ready || e.probing || !e.verdict?.ok) continue;
      jobs.push((async () => {
        const g = await Promise.resolve().then(() => readGeneration(e.pid)).catch(() => null);
        if (processes.get(proc) !== e || e.probing || !e.verdict?.ok) return;
        const current = e.path ? identify(e.path) : null;
        if (!g || g.key !== e.verdict.generation?.key || g.executable !== e.verdict.generation?.executable || !sameIdentity(current, e.seen)) {
          log(`OpenCode serve pid ${e.pid} port ${e.port}: ${g ? 'its process or its sockets changed' : 'its process could not be read'} since it was checked: checking again`);
          e.seen = current;
          e.verdict = null;
          await startProbe(proc, e);
        }
      })());
    }
    for (const x of exposures.values()) jobs.push(recheckStuck(x));
    jobs.push(refreshForeign());
    await within(Promise.allSettled(jobs), refreshMs);
  }

  // ── A foreign serve that is going away ──
  // On 2026-11-15 two revocations (21:13:30, 21:14:22 local) came from foreign serves that were exiting: the probe got no
  // answer (pid 21487: "GET /api/session did not answer", its exit handler ran at 21:13:29.03) or a reset (pid 54472:
  // ECONNRESET, exit handler at 21:14:22.60). A serve that answered nothing gave nothing away; once the OS confirms its
  // process ended, or that it no longer listens on that port, no page can reach it. So when EVERY offender of a watch
  // pass is such a failure (a foreign serve, `transient`, nothing `exposed`), the pass waits up to `exitGraceMs` for the
  // OS to confirm them gone, and revokes only for those that are not. Anything else (an exposed answer, a serve still
  // being checked, a scan that failed, a serve SynaBun started) is revoked at once, as before.
  const foreignVerdictOf = (o) => {
    const serve = (foreign.result?.serves || []).find((s) => s.pid === o.pid);
    return serve ? foreign.verdicts.get(listenerGenerationKey(serve))?.verdict || null : null;
  };
  const settlingForeign = (o) => {
    if (o?.reason !== 'foreign' || !Number.isInteger(o.pid) || !(o.pid > 0) || !(Number(o.port) > 0)) return false;
    const v = foreignVerdictOf(o);
    return !!v && !v.ok && v.transient === true && v.exposed !== true;
  };
  async function foreignGone(o) {
    let alive;
    try { alive = pidAlive(o.pid); } catch { alive = null; }
    if (alive === false) return true;
    let pids;
    try { pids = await portListeners(Number(o.port)); } catch { pids = null; }
    return Array.isArray(pids) && !pids.includes(o.pid);
  }
  async function withoutExitingForeign(bad) {
    if (!(exitGraceMs > 0) || !bad.length || !bad.every(settlingForeign)) return bad;
    const end = now() + exitGraceMs;
    let left = bad;
    for (;;) {
      const gone = await Promise.all(left.map((o) => foreignGone(o).catch(() => false)));
      const settled = left.filter((_, i) => gone[i]);
      for (const o of settled) log(`OpenCode serve pid ${o.pid} port ${o.port}, not started by SynaBun, failed "${o.check}" while it was going away and is gone now: no browser context revoked for it`);
      left = left.filter((_, i) => !gone[i]);
      if (!left.length || now() >= end) return left;
      await defaultSleep(Math.max(1, Math.min(exitPollMs, end - now())));
    }
  }

  function ensureWatch() {
    if (watchTimer || !(watchMs > 0)) return;
    watchTimer = setInterval(() => {
      if (!attachedContexts().length) { clearInterval(watchTimer); watchTimer = null; return; }
      refresh().then(async () => {
        if (!foreign.result?.ok) { revokeAll('the OpenCode listening processes could not be verified'); return; }
        const bad = await withoutExitingForeign(foreignOffenders(new Set()));
        if (bad.length) revokeAll(`an OpenCode serve SynaBun did not start could not be verified (pid ${bad[0].pid || '?'}, port ${bad[0].port || '?'}, check "${bad[0].check || bad[0].reason}")`);
      }).catch(() => {});
    }, watchMs);
    watchTimer.unref?.();
  }

  function offenders({ ports = [], unverifiedRecords = [] } = {}) {
    const out = [...buildChecks.values()].map(({ info }) => ({ reason: 'build-checking', path: info.path, version: info.version }));
    const verified = new Set();
    for (const [proc, e] of processes) {
      const base = { pid: e.pid || proc.pid || null, port: e.port, path: e.path || null, version: e.version || null };
      const state = stateOf(proc, e);
      if (state === 'refused') out.push({ ...base, reason: e.reason || 'version' });
      else if (state === 'starting') out.push({ ...base, reason: 'starting' });
      else if (state === 'verifying') out.push({ ...base, reason: 'verifying' });
      else if (state === 'failed') out.push({ ...base, reason: 'probe', check: e.verdict.failed, detail: e.verdict.detail });
      else verified.add(e.port);
    }
    // A failed serve whose process has ended but whose listener is not confirmed gone yet (or never was).
    for (const x of exposures.values()) {
      if (out.some((o) => o.reason === 'probe' && o.port === x.port && o.pid === x.pid)) continue;
      out.push({ pid: x.pid, port: x.port, path: x.path, version: x.version, reason: 'exposure', state: x.state, check: x.check, detail: x.detail });
    }
    for (const port of ports) {
      const n = Number(port);
      if (verified.has(n) || out.some(o => o.port === n)) continue;
      out.push({ pid: null, port: n, reason: 'untracked-port' });
    }
    // A record has the serve's command line (its identity), not a path; never its token.
    for (const r of unverifiedRecords) out.push({ pid: r?.pid || null, port: r?.port || null, kind: r?.kind || null, command: r?.command || null, claimable: !!r?.claimable, reason: 'record' });
    const excluded = ownPids();
    for (const r of unverifiedRecords) if (Number.isInteger(r?.pid)) excluded.add(r.pid);
    out.push(...foreignOffenders(excluded));
    return out;
  }
  function reserve(context) {
    const held = contexts.get(context);
    if (held) return held.release;
    const browser = context.browser?.() || null;
    const rec = { attached: false, revoking: false, release: null };
    const release = () => {
      if (contexts.get(context) !== rec) return;
      contexts.delete(context);
      context.removeListener?.('close', release);
      browser?.removeListener?.('disconnected', release);
    };
    rec.release = release;
    contexts.set(context, rec);
    context.once?.('close', release);
    browser?.once?.('disconnected', release);
    return release;
  }
  function status() {
    const serves = [];
    for (const [proc, e] of processes) {
      const state = stateOf(proc, e);
      const v = e.verdict;
      serves.push({
        pid: e.pid || proc.pid || null, port: e.port, path: e.path || null, version: e.version || null, knownGood: !!e.knownGood, own: true,
        state, reason: state === 'refused' ? (e.reason || 'version') : state === 'failed' ? 'probe' : null,
        failed: state === 'failed' ? v.failed : null, detail: v?.detail || null, checkedAt: v?.at || null,
        stopping: [...exposures.values()].some((x) => x.port === e.port && x.pid === (e.pid || proc.pid)),
        checks: (v?.checks || []).map(({ id, ok, detail, skipped }) => ({ id, ok: !!ok, detail: detail || '', ...(skipped ? { skipped: true } : {}) })),
      });
    }
    for (const x of exposures.values()) {
      if (serves.some((s) => s.port === x.port && s.pid === x.pid)) continue;
      serves.push({ pid: x.pid, port: x.port, path: x.path, version: x.version, knownGood: false, own: true, state: 'failed', reason: 'probe', failed: x.check, detail: x.detail,
        checkedAt: x.since, stopping: x.state === 'removing', stuck: x.state === 'stuck', checks: [] });
    }
    const others = [];
    for (const s of foreign.result?.ok ? foreign.result.serves : []) {
      const rec = foreign.verdicts.get(listenerGenerationKey(s));
      const v = rec?.verdict || null;
      others.push({ pid: s.pid, port: v?.port || s.addresses?.[0]?.port || null, path: s.executable || null, version: v?.version || null, command: s.command ? short(s.command, 400) : null, own: false,
        state: foreign.scanning || rec?.probing || !v ? 'verifying' : v.ok ? 'verified' : 'failed', failed: v && !v.ok ? v.failed : null, detail: v?.detail || null, checkedAt: v?.at || null,
        checks: (v?.checks || []).map(({ id, ok, detail, skipped }) => ({ id, ok: !!ok, detail: detail || '', ...(skipped ? { skipped: true } : {}) })) });
    }
    return {
      serves, foreign: others,
      scan: foreign.result ? { ok: foreign.result.ok, detail: foreign.result.detail, at: foreign.result.at } : null,
      nativeAttached: contexts.size, minimum: NATIVE_SERVE_MIN_VERSION, knownGood: [...NATIVE_SERVE_KNOWN_GOOD],
    };
  }

  async function attach(context, { state, sweep = null, waitMs = 20_000, sweepMs = 10_000, deadline = Infinity, signal = null, pollMs = 250, now: clock = Date.now, sleep = defaultSleep } = {}) {
    const release = reserve(context);
    const rec = contexts.get(context);
    const held = () => contexts.get(context) === rec;
    try {
      const start = clock();
      const end = Number.isFinite(deadline) ? deadline : Infinity;
      const waitEnd = Math.min(start + Math.max(0, waitMs), end);
      const sweepEnd = Math.min(start + Math.max(0, sweepMs), end);
      let current = state();
      let sweeping = false;
      if (sweep && current.unverifiedRecords?.length) {
        sweeping = true;
        Promise.resolve().then(sweep).catch(() => {}).finally(() => { sweeping = false; });
      }
      // Held first; then what may have changed is looked at again (the processes behind the verdicts, the serves
      // SynaBun did not start), bounded by refreshMs and the request's deadline.
      await within(refresh(), Math.min(refreshMs, end - clock()));
      current = state();
      const pending = (o) => o.reason === 'build-checking' || o.reason === 'starting' || o.reason === 'verifying' || o.reason === 'foreign-checking' || (o.reason === 'exposure' && o.state === 'removing');
      for (;;) {
        if (!held()) throw nativeContextClosed();
        if (signal?.aborted) throw nativeAttachAborted();
        const blocking = offenders(current);
        if (!blocking.length) {
          rec.attached = true;
          ensureWatch();
          return release;
        }
        const t = clock();
        const waitable = (o) => (pending(o) && t < waitEnd)
          || (o.reason === 'record' && o.claimable && sweeping && t < sweepEnd);
        if (!blocking.every(waitable)) throw nativeServeError(blocking);
        const until = Math.max(...blocking.map(o => (pending(o) ? waitEnd : sweepEnd)));
        await sleep(Math.max(1, Math.min(pollMs, until - t)));
        current = state();
      }
    } catch (error) {
      release();
      throw error;
    }
  }

  return {
    offenders,
    reserve,
    status,
    refresh,
    holds: (context) => contexts.has(context),
    // What is known about a build (binaryKey): `{ ok, failed, detail, version, at }` or null. Shown in Settings; it
    // never admits a serve.
    buildVerdict: (key) => verdicts.get(key),
    // A cached runtime pass is not a pre-flight. Known-good version labels never grant launch authority.
    assertLaunch(safe, info = {}) {
      if (!contexts.size) return;
      const key = binaryKey(info.identity, info.version);
      const current = info.path ? identify(info.path) : null;
      if (safe && key && builds.get(key)?.ok && sameIdentity(current, info.identity)
          && !exposures.size && ![...contexts.values()].some(r => r.revoking)) return;
      const e = nativeServeError([{ pid: null, port: info.port || null, path: info.path || null, version: info.version || null,
        reason: safe ? 'unverified-build' : (info.reason || 'version') }]);
      e.message = `A native browser is attached, so this unverified OpenCode serve is not started. ${e.message}`;
      throw e;
    },
    // Called automatically by every production launch and before a native browser is admitted. Starting a NEW
    // build while a context is held would expose the pre-flight itself through MoreLogin's 0.0.0.0 bypass.
    // An in-progress pre-flight precedes any subsequent attach reservation; that attach waits for its cleanup.
    async prepareBuild(safe, info = {}) {
      if (!safe) { this.assertLaunch(safe, info); return; }
      const key = binaryKey(info.identity, info.version);
      if (!info.identity?.native) throw nativeServeError([{ ...info, reason: 'unverified-build', detail: 'Choose the native OpenCode executable in Settings → Executable paths; a script launcher can change which binary it starts without changing its own identity.' }]);
      if (!key || !sameIdentity(identify(info.path), info.identity)) throw nativeServeError([{ ...info, reason: 'unverified-build', detail: 'The executable identity changed or could not be read.' }]);
      if (builds.get(key)?.ok) return;
      if (buildChecks.has(key)) return buildChecks.get(key).promise;
      this.assertLaunch(safe, info);
      if (typeof preflight !== 'function') throw nativeServeError([{ ...info, reason: 'unverified-build', detail: 'Automatic pre-flight is unavailable.' }]);
      const epoch = verificationEpoch;
      const owned = new Map(); // Retain cleanup evidence even if the child exits before printing its password.
      const rec = { info, promise: null };
      buildChecks.set(key, rec);
      rec.promise = Promise.resolve().then(() => preflight(info, {
        track: (proc, detail) => { this.track(proc, detail); owned.set(proc, processes.get(proc)); },
        verify: (proc, detail) => this.ready(proc, detail),
        stop: async (proc) => {
          const entry = owned.get(proc);
          const exposure = [...exposures.values()].find(x => x.proc === proc);
          if (exposure) return exposure.done;
          if (!entry || !proc.pid) return true;
          return terminate(proc, entry, { failed: 'preflight-cleanup', detail: 'the throwaway build verification has finished' });
        },
      })).then(result => {
        if (!result?.ok || result.version !== info.version || !sameIdentity(identify(info.path), info.identity) || epoch !== verificationEpoch) {
          builds.delete(key);
          throw nativeServeError([{ ...info, reason: 'unverified-build', detail: result?.detail || 'The pre-flight failed or verification changed while it ran; retry.' }]);
        }
        // preflight resolves only after its process AND listener are confirmed gone.
        const verdict = { ...result, buildPreflight: true, at: now() };
        builds.set(key, verdict);
        verdicts.set(key, verdict);
      }).finally(() => { if (buildChecks.get(key) === rec) buildChecks.delete(key); });
      return rec.promise;
    },
    // `kill(signal)` stops the serve (the server's own, Windows included); `stop` is the older form (SIGTERM only).
    track(proc, { port, safe = false, version = null, path = null, reason = null, identity = undefined, knownGood = false, stop = null, kill = null }) {
      if (!proc || proc.exitCode != null || proc.signalCode != null) return;
      const id = identity === undefined ? (path ? identify(path) : null) : identity;
      const killer = typeof kill === 'function' ? kill
        : (signal) => (signal === 'SIGTERM' && typeof stop === 'function' ? stop() : proc.kill?.(signal));
      processes.set(proc, { port: Number(port), safe, ready: false, version, path, reason: safe ? null : (reason || 'version'),
        identity: id, seen: id, launchKey: binaryKey(id, version), knownGood: !!knownGood, pid: proc.pid || null, pidOwned: false, password: null,
        verdict: null, probing: null, kill: killer });
      const release = () => processes.delete(proc);
      proc.once('exit', release);
      proc.once('error', () => { if (!proc.pid) release(); });
    },
    // The serve answers (private HTTP/WS readiness passed): `pid` the process that listens (SynaBun's own: its spawn
    // or a descendant the records confirmed), `password` the one it printed. Its probe starts now; until it has
    // passed, the serve blocks a native attachment ('verifying').
    ready(proc, { pid = null, password = null } = {}) {
      const entry = processes.get(proc);
      if (!entry) return null;
      entry.ready = true;
      if (Number.isInteger(pid) && pid > 0) { entry.pid = pid; entry.pidOwned = true; }
      if (password) entry.password = password;
      return entry.safe ? startProbe(proc, entry) : null;
    },
    // Settings → Verify OpenCode: every ready serve is probed again, its build's verdict forgotten first, and the
    // serves SynaBun did not start are listed and probed again. Bounded by the probe's own limits.
    async reverify() {
      const epoch = ++verificationEpoch;
      const priorBuilds = new Map(builds);
      builds.clear();
      const runs = [];
      for (const [proc, e] of processes) {
        if (!e.safe || !e.ready) continue;
        verdicts.delete(e.launchKey);
        e.verdict = null;
        runs.push((e.probing ? e.probing.then(() => startProbe(proc, e)) : startProbe(proc, e)).then(v => {
          if (epoch === verificationEpoch && v.ok && priorBuilds.has(e.launchKey) && sameIdentity(identify(e.path), e.identity)) builds.set(e.launchKey, priorBuilds.get(e.launchKey));
        }));
      }
      foreign.verdicts.clear();
      runs.push(refreshForeign());
      for (const x of exposures.values()) runs.push(recheckStuck(x));
      await Promise.allSettled(runs);
      return status();
    },
    // attach without waiting: the context is held when nothing blocks now (after the bounded refresh), else refused.
    // A context already held is returned as it is.
    async protect(context, state) {
      if (contexts.has(context)) return contexts.get(context).release;
      return attach(context, { state: () => state || {}, waitMs: 0, sweepMs: 0 });
    },
    // The context is held (a pending reservation assertLaunch honours) before anything is waited for; then, bounded,
    // what may have changed is looked at again (refresh) and SynaBun repairs what it can: a sweep of the records an
    // ended SynaBun left (started at once, in the background, waited for at most `sweepMs`), SynaBun's own serves
    // still starting or being probed, the serves SynaBun did not start being probed and a failed serve being stopped
    // (waited for at most `waitMs`). Any other blocker refuses at once. `deadline` (an absolute time) and `signal` end
    // the wait early. On every failure the reservation is released; the next attempt reads the live state again.
    attach,
  };
}

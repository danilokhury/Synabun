// Native page WebSockets are safe only behind a server boundary established at
// listen time. This is a capability allowlist, not a generic OpenCode version
// check: 2.1.4's HTTP/upgrade authentication and stdout password path were
// inspected and tested. Unknown binaries/command wrappers keep the old guard.
// 2.2.5 (Homebrew anomalyco/tap/opencode-v2) checked 2026-11-01 against throwaway
// serves on 127.0.0.1: no password variable → it prints "server password <secret>"
// on stdout; every /api route (session, config, event, pty, shell, file, mcp, and
// the new tunnel and pairing) answers 401 without it, both plain and as a
// WebSocket upgrade, and 200 with it; one listener, bound to 127.0.0.1 only.
// Non-/api paths serve the static web UI (HTML), as before.
export const NATIVE_SERVE_VERSIONS = Object.freeze(['2.1.4', '2.2.5']);

export function nativeServeCapability({ version, commandLine = false, passwordFrom } = {}) {
  const bare = String(version || '').trim().replace(/^opencode\s+/, '').replace(/^v/, '');
  return !commandLine && passwordFrom === 'stdout' && NATIVE_SERVE_VERSIONS.includes(bare);
}

// Why a serve is not native-safe, in words that name what to change.
export function nativeServeReason({ version, commandLine = false, passwordFrom } = {}) {
  if (commandLine) return 'command-line';
  if (passwordFrom !== 'stdout') return 'password';
  return nativeServeCapability({ version, commandLine, passwordFrom }) ? null : 'version';
}

const BASE = `Native browser WebSockets require authenticated OpenCode ${NATIVE_SERVE_VERSIONS.join(' or ')} serves with private stdout credentials; wait for startup, stop unverified serves or use the verified executable path.`;

const MAX_COMMAND = 200;
const short = (text, max = MAX_COMMAND) => {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const pidOf = (o) => (Number.isInteger(o?.pid) && o.pid > 0 ? o.pid : null);

// The fields of an offender a caller may see (a route's answer, a dispatch error): what names the serve, never its
// token or the rest of its record. A command line is shortened.
export function narrowOffenders(offenders = []) {
  return (Array.isArray(offenders) ? offenders : []).map((o) => {
    const out = { reason: String(o?.reason || 'unknown'), pid: pidOf(o), port: Number(o?.port) > 0 ? Number(o.port) : null };
    if (o?.path) out.path = short(o.path, 400);
    if (o?.command) out.command = short(o.command, 400);
    if (o?.version) out.version = String(o.version).trim();
    if (o?.reason === 'record') { out.kind = o.kind || null; out.claimable = !!o.claimable; }
    return out;
  });
}

function describeOffender(o) {
  const pid = pidOf(o);
  const where = [pid ? `pid ${pid}` : null, o.port ? `port ${o.port}` : null].filter(Boolean).join(', ');
  const what = [o.path || null, o.command ? `command ${short(o.command)}` : null, o.version ? `version ${String(o.version).trim()}` : null].filter(Boolean).join(', ');
  const head = `OpenCode serve ${where || '(unknown process)'}${what ? ` (${what})` : ''}`;
  switch (o.reason) {
    case 'version': return `${head}: this OpenCode version is not one whose authentication SynaBun verified (${NATIVE_SERVE_VERSIONS.join(', ')}); install one of them, or stop this serve (close the OpenCode panel${pid ? ` / end pid ${pid}` : ''})`;
    case 'command-line': return `${head}: started from the OpenCode command line set in Settings (its version cannot be read); clear it so SynaBun starts the verified executable, or stop this serve`;
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

export function createNativeServeBoundary() {
  const processes = new Map();
  // Every native context that relies on the boundary, attached or still being checked (a reservation): while any is
  // held, assertLaunch refuses an unverified serve. A context is held from before its check until it closes, its
  // browser disconnects or its attachment fails.
  const contexts = new Map();
  function offenders({ ports = [], unverifiedRecords = [] } = {}) {
    const out = [];
    const verified = new Set();
    for (const [proc, e] of processes) {
      const base = { pid: proc.pid || null, port: e.port, path: e.path || null, version: e.version || null };
      if (!e.safe) out.push({ ...base, reason: e.reason || 'version' });
      else if (!e.ready) out.push({ ...base, reason: 'starting' });
      else verified.add(e.port);
    }
    for (const port of ports) {
      const n = Number(port);
      if (verified.has(n) || out.some(o => o.port === n)) continue;
      out.push({ pid: null, port: n, reason: 'untracked-port' });
    }
    // A record has the serve's command line (its identity), not a path; never its token.
    for (const r of unverifiedRecords) out.push({ pid: r?.pid || null, port: r?.port || null, kind: r?.kind || null, command: r?.command || null, claimable: !!r?.claimable, reason: 'record' });
    return out;
  }
  function reserve(context) {
    const held = contexts.get(context);
    if (held) return held;
    const browser = context.browser?.() || null;
    const release = () => {
      if (contexts.get(context) !== release) return;
      contexts.delete(context);
      context.removeListener('close', release);
      browser?.removeListener('disconnected', release);
    };
    contexts.set(context, release);
    context.once('close', release);
    browser?.once('disconnected', release);
    return release;
  }
  function check(state) {
    const blocking = offenders(state);
    if (blocking.length) throw nativeServeError(blocking);
  }
  return {
    offenders,
    reserve,
    holds: (context) => contexts.has(context),
    assertLaunch(safe, info = {}) {
      if (!safe && contexts.size) {
        const e = nativeServeError([{ pid: null, port: info.port || null, path: info.path || null, version: info.version || null, reason: info.reason || 'version' }]);
        e.message = `A native browser is attached, so this unverified OpenCode serve is not started. ${e.message}`;
        throw e;
      }
    },
    track(proc, { port, safe = false, version = null, path = null, reason = null }) {
      if (!proc || proc.exitCode != null || proc.signalCode != null) return;
      processes.set(proc, { port: Number(port), safe, ready: false, version, path, reason: safe ? null : (reason || 'version') });
      const release = () => processes.delete(proc);
      proc.once('exit', release);
      proc.once('error', () => { if (!proc.pid) release(); });
    },
    ready(proc) { const entry = processes.get(proc); if (entry) entry.ready = true; },
    // Synchronous: check now, then hold the context. A context already held is returned as it is.
    protect(context, state) {
      if (contexts.has(context)) return contexts.get(context);
      check(state);
      return reserve(context);
    },
    // The context is held (a pending reservation assertLaunch honours) before anything is waited for; then, bounded,
    // SynaBun repairs what it can: a sweep of the records an ended SynaBun left (started at once, in the background,
    // waited for at most `sweepMs`) and SynaBun's own verified serves still starting (waited for at most `waitMs`).
    // Any other blocker refuses at once. `deadline` (an absolute time) and `signal` end the wait early. On every
    // failure the reservation is released; nothing is cached, so the next attempt reads the live state again.
    async attach(context, { state, sweep = null, waitMs = 20_000, sweepMs = 10_000, deadline = Infinity, signal = null, pollMs = 250, now = Date.now, sleep = defaultSleep } = {}) {
      const release = reserve(context);
      const held = () => contexts.get(context) === release;
      try {
        const start = now();
        const end = Number.isFinite(deadline) ? deadline : Infinity;
        const waitEnd = Math.min(start + Math.max(0, waitMs), end);
        const sweepEnd = Math.min(start + Math.max(0, sweepMs), end);
        let current = state();
        let sweeping = false;
        if (sweep && current.unverifiedRecords?.length) {
          sweeping = true;
          Promise.resolve().then(sweep).catch(() => {}).finally(() => { sweeping = false; });
        }
        for (;;) {
          if (!held()) throw nativeContextClosed();
          if (signal?.aborted) throw nativeAttachAborted();
          const blocking = offenders(current);
          if (!blocking.length) return release;
          const t = now();
          const waitable = (o) => (o.reason === 'starting' && t < waitEnd)
            || (o.reason === 'record' && o.claimable && sweeping && t < sweepEnd);
          if (!blocking.every(waitable)) throw nativeServeError(blocking);
          const until = Math.max(...blocking.map(o => (o.reason === 'starting' ? waitEnd : sweepEnd)));
          await sleep(Math.max(1, Math.min(pollMs, until - t)));
          current = state();
        }
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}

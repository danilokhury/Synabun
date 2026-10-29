/**
 * SynaBun — what the end of the server process says, and what its supervisor does
 *
 * setup.js runs the Neural Interface server as a child and decides, when that
 * child ends, whether to start it again (lib/server-supervisor.js). The exit
 * status alone cannot say whether an end was asked for: every way out of
 * server.js passes its `exit` handler, which ends the process by force to skip
 * native teardown (Windows then reports exit code 1, macOS and Linux SIGKILL).
 * So the server says so for a stop that was asked for (a restart has its own
 * marker), twice over: a stop marker in the data home, and a line on its stdout
 * with the token its supervisor gave it, which needs no disk. The status is read
 * for what it can tell: a crash, and of which kind.
 *
 *   describeExit({ code, signal })   the status in plain words, for the log, the
 *                                    supervisor record and the app's stopped page
 *   serverExitDecision({ ... })      restart / stopped / crashed / failed
 *   writeStopMarker / readStopMarker the marker, written whole, read strictly
 *   readRestartMarker                when the restart was asked for
 *   stopAnnouncement / readStopAnnouncement   the stop line on stdout
 *   watchChildEnd(child, ...)        the end of the child, once its output is read
 *   createRestartGuard({ ... })      the crash-loop guard: so many starts in a window
 *
 * No imports and no I/O of its own (a writer is handed its file functions). The
 * words are English: the desktop app localizes a status by its `kind`
 * (packaging/desktop/src/server-exit-view.mjs), the page by its `kind` too.
 */

/** The sentinel a supervised server exits with to be started again (sysexits EX_TEMPFAIL). */
export const RESTART_EXIT_CODE = 75;

/** The marker server.js leaves in the data home before a stop that was asked for (shutdown, update, signal). */
export const STOP_MARKER_NAME = 'stop-requested';

/** The environment variable that hands a server its supervisor's stop token (one per start, never inherited further). */
export const STOP_TOKEN_ENV = 'SYNABUN_STOP_TOKEN';

/** What a stop reason may be in a marker or a stop line: a short word ("shutdown", "run-update", "sigterm"). */
export function cleanStopReason(reason) {
  return typeof reason === 'string' ? reason.replace(/[^\w-]/g, '').slice(0, 40) : '';
}

/**
 * Write the stop marker whole: a temporary file beside it, renamed over it, so
 * the supervisor never reads half a marker. `fs` is { writeFileSync,
 * renameSync, rmSync }. Returns { ok: true } when it is in place, else
 * { ok: false, error } (its code: ENOSPC, EROFS, EPERM, …). Never throws.
 */
export function writeStopMarker(path, { reason, pid, at }, fs) {
  const temp = `${path}.${pid}.tmp`;
  const text = JSON.stringify({ reason: cleanStopReason(reason), pid, at });
  try {
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, path);
    return { ok: true };
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    return { ok: false, error: String(error?.code || error?.message || error || 'unknown').slice(0, 60) };
  }
}

/** How much earlier than the server's start a marker may say it was written: a clock that moved a little. */
export const MARKER_CLOCK_SLACK_MS = 60_000;

/**
 * The marker as the supervisor takes it: complete JSON left by `pid` (the
 * server it started, never "any server"), written no earlier than `since` (when
 * it started that server) less a minute for a clock that moved. Returns
 * { reason, at } or null: an empty, truncated, foreign or stale file is no stop.
 */
export function readStopMarker(text, { pid, since = 0 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let saved;
  try { saved = JSON.parse(String(text ?? '')); } catch { return null; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
  if (saved.pid !== pid) return null;
  if (!Number.isFinite(saved.at) || saved.at < Number(since || 0) - MARKER_CLOCK_SLACK_MS) return null;
  return { reason: cleanStopReason(saved.reason), at: saved.at };
}

/** When the restart marker says the restart was asked for (server.js writes its Date.now() in it), or null. */
export function readRestartMarker(text) {
  const value = String(text ?? '').trim();
  if (!/^\d{1,16}$/.test(value)) return null;
  const at = Number(value);
  return Number.isSafeInteger(at) && at > 0 ? at : null;
}

/** The line a server prints when a stop was asked of it: its supervisor reads it on stdout, with no disk involved. */
export function stopAnnouncement(token, reason) {
  return `[server] Stop requested: ${cleanStopReason(reason) || 'stop'} (supervisor ${token})`;
}

/** The reason of a stop line that carries `token` (the one the supervisor gave this server), or null. */
export function readStopAnnouncement(line, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return null;
  const found = /^\[server\] Stop requested: ([\w-]{1,40}) \(supervisor ([0-9a-f]{32})\)\s*$/.exec(String(line ?? '').trim());
  return found && found[2] === token ? { reason: found[1] } : null;
}

/** Signals that stop a process on request. Any other signal is a crash or a forced end (systemd's "clean" set). */
export const CLEAN_SIGNALS = Object.freeze(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGPIPE']);

/** What each kind is called in a sentence: "0xC0000409, native crash". */
export const EXIT_KIND_WORDS = Object.freeze({
  'native-crash': 'native crash',
  'out-of-memory': 'out of memory',
  'node-fatal': 'Node.js fatal error',
  error: 'stopped by an error',
  killed: 'ended by force',
  interrupted: 'interrupted',
  stopped: 'stopped on request',
  restart: 'restart requested',
  exit: '',
});

// Windows ends a crashed process with an NTSTATUS. These are the ones a Node.js
// server meets; anything else in the error range is still reported by number.
const WINDOWS_STATUS = new Map([
  [0xC0000409, ['STATUS_STACK_BUFFER_OVERRUN', 'native-crash', 'a fail-fast inside the process: abort() (an uncaught C++ exception, a failed native assertion) or a failed security check']],
  [0xC0000005, ['STATUS_ACCESS_VIOLATION', 'native-crash', 'an invalid memory access']],
  [0xC00000FD, ['STATUS_STACK_OVERFLOW', 'native-crash', 'a native stack overflow']],
  [0xC0000374, ['STATUS_HEAP_CORRUPTION', 'native-crash', 'corrupted native memory']],
  [0xC000001D, ['STATUS_ILLEGAL_INSTRUCTION', 'native-crash', 'an instruction this processor does not have']],
  [0xC0000096, ['STATUS_PRIVILEGED_INSTRUCTION', 'native-crash', 'a privileged instruction']],
  [0xC0000094, ['STATUS_INTEGER_DIVIDE_BY_ZERO', 'native-crash', 'an integer division by zero']],
  [0xC0000006, ['STATUS_IN_PAGE_ERROR', 'native-crash', 'a page of the program could not be read (a disk or network error)']],
  [0xC0000420, ['STATUS_ASSERTION_FAILURE', 'native-crash', 'a failed native assertion']],
  [0xC0000142, ['STATUS_DLL_INIT_FAILED', 'native-crash', 'a DLL could not initialize']],
  [0x80000003, ['STATUS_BREAKPOINT', 'native-crash', 'a fatal error trap (V8 or libuv stopping the process)']],
  [0xC0000017, ['STATUS_NO_MEMORY', 'out-of-memory', 'Windows had no memory left to give it']],
  [0xC000012D, ['STATUS_COMMITMENT_LIMIT', 'out-of-memory', 'the system commit limit was reached']],
  [0xC000013A, ['STATUS_CONTROL_C_EXIT', 'interrupted', 'Ctrl+C, or the console it ran in was closed']],
  [0x40010004, ['DBG_TERMINATE_PROCESS', 'killed', 'ended by a debugger or by Windows']],
]);

// Exit codes of a Node.js process.
const NODE_CODES = new Map([
  [1, ['error', 'an error the server did not handle (printed above), or it was ended by force']],
  [7, ['error', 'its own error handler failed']],
  [134, ['node-fatal', 'Node.js stopped it ("FATAL ERROR" above: out of memory, or an internal check)']],
  [RESTART_EXIT_CODE, ['restart', 'it asked to be started again']],
]);

const SIGNALS = new Map([
  ['SIGSEGV', ['native-crash', 'a segmentation fault (invalid memory access)']],
  ['SIGBUS', ['native-crash', 'a bus error (invalid memory access)']],
  ['SIGILL', ['native-crash', 'an illegal instruction']],
  ['SIGFPE', ['native-crash', 'an arithmetic error']],
  ['SIGABRT', ['native-crash', 'abort(): an uncaught C++ exception, a failed native assertion or a fatal error']],
  ['SIGTRAP', ['native-crash', 'a fatal error trap']],
  ['SIGSYS', ['native-crash', 'a bad system call']],
  ['SIGKILL', ['killed', 'by force, or by the system when memory ran out']],
  ['SIGTERM', ['stopped', 'it was asked to stop']],
  ['SIGINT', ['stopped', 'it was interrupted']],
  ['SIGHUP', ['stopped', 'its terminal went away']],
  ['SIGPIPE', ['stopped', 'its output was closed']],
]);

/**
 * `code` as an unsigned 32-bit hex status ("0xC0000409") when it is one: an
 * NTSTATUS-sized value (as Node reports it, or as a negative 32-bit number).
 * Null for ordinary exit codes.
 */
export function exitStatusHex(code) {
  if (typeof code !== 'number' || !Number.isInteger(code)) return null;
  if (code < 0 && code >= -0x80000000) code >>>= 0;
  if (code < 0x40000000 || code > 0xFFFFFFFF) return null;
  return `0x${code.toString(16).toUpperCase().padStart(8, '0')}`;
}

/**
 * The exit status in plain words. Returns
 *   { code, signal, hex, name, kind, detail, label, text }
 * `kind` is one of the keys of EXIT_KIND_WORDS; `label` its words; `text` the
 * short form a person reads ("0xC0000409, native crash", "exit code 1, …",
 * "SIGSEGV, native crash"); `detail` what it means, for the log.
 */
export function describeExit({ code = null, signal = null } = {}) {
  const numeric = typeof code === 'number' && Number.isInteger(code) ? code : null;
  const sig = typeof signal === 'string' && /^SIG[A-Z0-9]+$/.test(signal) ? signal : null;
  const hex = exitStatusHex(numeric);
  let name = null;
  let kind = 'exit';
  let detail = '';
  if (sig) {
    name = sig;
    const known = SIGNALS.get(sig);
    if (known) [kind, detail] = known;
    else { kind = 'killed'; detail = 'ended by that signal'; }
  } else if (hex) {
    const unsigned = Number.parseInt(hex.slice(2), 16);
    const known = WINDOWS_STATUS.get(unsigned);
    if (known) [name, kind, detail] = known;
    else if (unsigned >= 0xC0000000 && unsigned <= 0xCFFFFFFF) { kind = 'native-crash'; detail = 'a Windows error status'; }
  } else if (numeric !== null) {
    const known = NODE_CODES.get(numeric);
    if (known) [kind, detail] = known;
    else if (numeric === 0) detail = 'a normal exit';
  }
  const label = EXIT_KIND_WORDS[kind] || '';
  const head = sig || hex || (numeric !== null ? `exit code ${numeric}` : 'no exit status');
  return {
    code: numeric,
    signal: sig,
    hex,
    name,
    kind,
    detail,
    label,
    text: label ? `${head}, ${label}` : head,
  };
}

/**
 * One line for the supervisor's log: "exit code 3221226505 = 0xC0000409,
 * native crash (STATUS_STACK_BUFFER_OVERRUN): a fail-fast inside …".
 */
export function formatExit(described) {
  const d = described && typeof described === 'object' && 'kind' in described ? described : describeExit(described || {});
  const head = d.signal ? `signal ${d.signal}` : d.code !== null ? `exit code ${d.code}${d.hex ? ` = ${d.hex}` : ''}` : 'no exit status';
  const label = d.label ? `, ${d.label}` : '';
  const name = d.name && d.name !== d.signal ? ` (${d.name})` : '';
  const detail = d.detail ? `: ${d.detail}` : '';
  return `${head}${label}${name}${detail}`;
}

/**
 * What the supervisor does when the server it runs has ended:
 *   'restart'  it asked to be started again (exit code 75 or the restart marker)
 *   'stopped'  it was asked to stop (the stop marker), or stopped cleanly
 *              (exit code 0, a clean signal, Windows' Ctrl+C status): the
 *              supervisor ends too
 *   'failed'   it ended before it was listening: a start that failed, reported
 *              as one (starting it again would fail the same way)
 *   'crashed'  it ended on its own after it was up: started again, within the
 *              supervisor's crash-loop guard
 * Asked for both, the later request wins: `stopAfterRestart` (the stop was
 * asked when, or after, the restart was: the desktop app quitting while a
 * restart shuts down) is a stop; otherwise the restart goes ahead.
 */
export function serverExitDecision({ code = null, signal = null, restartRequested = false, stopRequested = false, stopAfterRestart = false, listened = false } = {}) {
  if (stopRequested && stopAfterRestart) return 'stopped';
  if (restartRequested || code === RESTART_EXIT_CODE) return 'restart';
  if (stopRequested) return 'stopped';
  if (code === 0) return 'stopped';
  if ((code === null || code === undefined) && CLEAN_SIGNALS.includes(signal)) return 'stopped';
  // Windows' own Ctrl+C, or the console it ran in closing: what SIGINT and SIGHUP are elsewhere.
  if (exitStatusHex(code) === '0xC000013A') return 'stopped';
  if (!listened) return 'failed';
  return 'crashed';
}

/**
 * The fields a supervisor record's error keeps about an exit (lib/start-launcher.js
 * supervisorError): what the desktop app's stopped page shows.
 */
export function exitRecordFields(described) {
  const d = described && typeof described === 'object' && 'kind' in described ? described : describeExit(described || {});
  return {
    ...(d.code !== null ? { exitCode: d.code } : {}),
    ...(d.signal ? { exitSignal: d.signal } : {}),
    ...(d.hex ? { exitHex: d.hex } : {}),
    exitKind: d.kind,
  };
}

/**
 * Call `onEnd({ code, signal })` once, when `child` has ended and its output
 * has been read to the end ('close'), or `drainMs` after it exited when
 * something it started still holds that output open. Reading to the end
 * first keeps a crash's last words: what a native assertion or an uncaught
 * error printed just before the process died. `cancel()` stops it (the child
 * could not be started, and that was reported already).
 */
export function watchChildEnd(child, { drainMs = 1500, onEnd, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let ended = null;
  let done = false;
  let drain = null;
  const decide = () => {
    if (done || !ended) return;
    done = true;
    if (drain !== null) clearTimer(drain);
    onEnd?.(ended);
  };
  child.on('exit', (code, signal) => {
    ended = { code, signal };
    drain = setTimer(decide, drainMs);
  });
  child.on('close', (code, signal) => {
    ended ??= { code, signal };
    decide();
  });
  return {
    cancel() {
      done = true;
      if (drain !== null) clearTimer(drain);
    },
    get decided() { return done; },
  };
}

/**
 * The crash-loop guard: `note()` counts one more start of the server and says
 * whether that is more than `limit` within `windowMs` ({ count, exceeded }).
 */
export function createRestartGuard({ windowMs = 60_000, limit = 5, now = () => Date.now() } = {}) {
  const starts = [];
  return {
    windowMs,
    limit,
    note() {
      const at = now();
      starts.push(at);
      while (starts.length && at - starts[0] > windowMs) starts.shift();
      return { count: starts.length, exceeded: starts.length > limit };
    },
  };
}

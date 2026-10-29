/**
 * SynaBun — the supervisor's run of the server
 *
 * setup.js starts the Neural Interface server (neural-interface/server.js) as a
 * child through this module, and decides every time that child ends what comes
 * next (lib/server-exit.js serverExitDecision):
 *
 *   restart   it asked to be started again (exit code 75, or the restart marker)
 *   crashed   it ended on its own after it was up: started again within the
 *             crash-loop guard (5 starts in 60 s), and the record of the crash
 *             (lib/server-crash-record.js) is left for the server it starts,
 *             which tells the owner's pages once that it happened
 *   failed    it ended before it was listening: the start reports it and ends
 *   stopped   it was asked to stop (the stop marker, or the stop line on its
 *             stdout with this start's token), or it ended cleanly: the
 *             supervisor ends too
 *
 * Asked both to restart and to stop, the later request wins: a stop asked while
 * a restart shut down (the desktop app quitting) is a stop. A marker that is
 * there but cannot be read (a scanner holding it) is read again a few times; a
 * stop marker that stays unreadable is still read as the stop it stands for.
 *
 * The end is decided once the child's output has been read to the end
 * (watchChildEnd), so a crash's last lines are kept, and its stdout is read in
 * whole lines: a line split across two reads is still one line.
 *
 * When the supervisor ends because the server could not be kept up (the guard
 * gave up, a start failed), it says so first (the supervisor record, the restart
 * report) and then waits, a bounded time, for what Windows recorded about a
 * native crash, which it writes to its logs as soon as each part is found.
 *
 * Everything outside this process is handed in (the record, the restart report,
 * the browser, the Windows lookup, the exit), so
 * tests/server-supervisor.test.mjs runs this with real child processes over a
 * temporary data home. Never run setup.js to check it.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MARKER_CLOCK_SLACK_MS, RESTART_EXIT_CODE, STOP_MARKER_NAME, STOP_TOKEN_ENV, createRestartGuard, describeExit, exitRecordFields, formatExit,
  readRestartMarker, readStopAnnouncement, readStopMarker, serverExitDecision, watchChildEnd,
} from './server-exit.js';
import { clearCrashRecord, writeCrashRecord } from './server-crash-record.js';
import { describeWindowsCrash, lookupWindowsCrash as nodeLookupWindowsCrash } from './windows-crash-event.js';

/** The crash-loop guard: more than CRASH_LIMIT starts within CRASH_WINDOW_MS end the supervisor. */
export const CRASH_WINDOW_MS = 60_000;
export const CRASH_LIMIT = 5;
/** How long the server's output is read after it exited, at most, before its end is decided. */
export const SERVER_OUTPUT_DRAIN_MS = 1500;
/** The pause before a server is started again (its port is let go). */
export const RESPAWN_DELAY_MS = 250;
/**
 * How long a supervisor that ends waits, at most, for what Windows recorded about
 * a native crash (lib/windows-crash-event.js tries at 1.5, 7.5 and 22.5 s). The
 * lookup is given this less CRASH_LOOKUP_MARGIN_MS as its whole budget, waits and
 * queries together, so it ends, with what it found written, before the wait does.
 */
export const CRASH_LOOKUP_WAIT_MS = 30_000;
export const CRASH_LOOKUP_MARGIN_MS = 2000;
/** Each log file is moved aside past this size, when the supervisor starts. */
export const LOG_ROTATE_BYTES = 50 * 1024 * 1024;
/**
 * A marker that is there but cannot be read (Windows: a scanner holds a file it just saw written) is read again,
 * this many times in all, this far apart, before the end is decided without its words.
 */
export const MARKER_READ_ATTEMPTS = 6;
export const MARKER_RETRY_MS = 150;
// What a read of a file someone else holds for a moment answers.
const HELD = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE']);
const MAX_LINE = 64 * 1024;

/** Whole lines out of a stream's chunks: `push(chunk)` hands each complete line to `onLine`, `end()` the rest. */
export function createLineReader(onLine, { maxLine = MAX_LINE } = {}) {
  let rest = '';
  const emit = (line) => { try { onLine(line.endsWith('\r') ? line.slice(0, -1) : line); } catch {} };
  return {
    push(chunk) {
      rest += String(chunk);
      let at;
      while ((at = rest.indexOf('\n')) >= 0) {
        emit(rest.slice(0, at));
        rest = rest.slice(at + 1);
      }
      // A line that never ends is read in pieces, never kept whole.
      while (rest.length > maxLine) {
        emit(rest.slice(0, maxLine));
        rest = rest.slice(maxLine);
      }
    },
    end() {
      if (rest) emit(rest);
      rest = '';
    },
  };
}

/** The address the server says it listens on ("  Server:    http://localhost:3344"): { url, port } or null. */
export function listeningAddress(line) {
  const found = /^\s*Server:\s+(https?:\/\/\S+)/.exec(String(line ?? ''));
  if (!found) return null;
  let port = null;
  try {
    const url = new URL(found[1]);
    port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  } catch {}
  return { url: found[1], port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null };
}

function within(promise, ms) {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    Promise.resolve(promise).catch(() => {}).then(() => { clearTimeout(timer); done(); });
  });
}

/**
 * Run the server and keep it up. Returns { stop(signal), child }: `stop` ends
 * it on the supervisor's own signal (SIGINT, SIGTERM) and exits.
 *
 * @param {object} o
 * @param {string} o.serverPath   neural-interface/server.js
 * @param {string} o.cwd          the folder it runs in
 * @param {string} o.dataHome     SynaBun's data home (markers, records, logs)
 * @param {() => object} [o.env]  the environment the server gets, read at each start
 * @param {{ info: Function, warn: Function, fail: Function }} [o.print]  the supervisor's own lines
 * @param {(name: string, detail?: object) => void} [o.onPhase]     the supervisor record's phase
 * @param {(code: string, message: string, extra?: object) => void} [o.onFailed]  the record's failure
 * @param {(o: { port: number|null, first: boolean }) => void} [o.onListening]  the server said it listens
 * @param {{ reopen: (port: number) => void, failed: (error: object) => Promise<void> }} [o.reports]  the restart report
 * @param {(code: number) => void} [o.exit]
 */
export function superviseServer({
  serverPath,
  cwd,
  dataHome,
  execPath = process.execPath,
  nodeArgs = ['--disable-warning=ExperimentalWarning', '--max-old-space-size=6144'],
  env = () => process.env,
  windowsHide = false,
  platform = process.platform,
  spawn = nodeSpawn,
  logDir = join(dataHome, 'data'),
  print = { info() {}, warn() {}, fail() {} },
  passthrough = { stdout: process.stdout, stderr: process.stderr },
  onPhase = () => {},
  onFailed = () => {},
  onListening = () => {},
  reports = { reopen() {}, async failed() {} },
  resolvePort = () => null,
  lookupWindowsCrash = nodeLookupWindowsCrash,
  exit = (code) => process.exit(code),
  windowMs = CRASH_WINDOW_MS,
  limit = CRASH_LIMIT,
  drainMs = SERVER_OUTPUT_DRAIN_MS,
  respawnDelayMs = RESPAWN_DELAY_MS,
  crashLookupWaitMs = CRASH_LOOKUP_WAIT_MS,
  markerReadAttempts = MARKER_READ_ATTEMPTS,
  markerRetryMs = MARKER_RETRY_MS,
  files = { readFileSync, statSync },
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  newToken = () => randomBytes(16).toString('hex'),
  now = () => Date.now(),
} = {}) {
  if (!serverPath || !dataHome) throw new Error('superviseServer needs the server and the data home');

  // Marker files the server writes before it ends: a restart it asked for (server.js /api/server/restart; a
  // native teardown crash can clobber its exit code 75), and a stop someone asked for (its exit status cannot say
  // so: server.js ends itself by force after its cleanup, which Windows reports as exit code 1 and macOS / Linux
  // as SIGKILL). A marker from a run before this one says nothing about this one.
  const restartMarker = resolve(dataHome, 'restart-requested');
  const stopMarker = resolve(dataHome, STOP_MARKER_NAME);
  const remove = (path) => { try { if (existsSync(path)) unlinkSync(path); } catch {} };
  remove(restartMarker);
  remove(stopMarker);
  // What a stop marker left half-written when its server died between the write and the rename.
  try {
    for (const name of readdirSync(dataHome)) if (/^stop-requested\.\d+\.tmp$/.test(name)) remove(join(dataHome, name));
  } catch {}

  // The server's stdout and stderr go to log files too, whoever launched the supervisor (the Apps menu, a
  // terminal, launchd, the desktop app): the files a person sends when they report a crash.
  try { mkdirSync(logDir, { recursive: true }); } catch {}
  const stdoutPath = resolve(logDir, 'server-stdout.log');
  const stderrPath = resolve(logDir, 'server-stderr.log');
  for (const path of [stdoutPath, stderrPath]) {
    try { if (existsSync(path) && statSync(path).size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`); } catch {}
  }
  let outLog = null;
  let errLog = null;
  // A full disk reports asynchronously from WriteStream.write(): without an error listener that event would end
  // the supervisor itself. Only the stream that failed is given up; supervision goes on.
  const openLog = (kind, path) => {
    let stream = null;
    try { stream = createWriteStream(path, { flags: 'a' }); } catch (error) {
      print.warn(`Could not open ${kind} log: ${error.message}`);
      return null;
    }
    stream.on('error', (error) => {
      if (kind === 'stdout' && outLog === stream) outLog = null;
      if (kind === 'stderr' && errLog === stream) errLog = null;
      print.warn(`Could not persist ${kind} server log: ${error.message} — continuing without file capture.`);
      try { stream.destroy(); } catch {}
    });
    return stream;
  };
  outLog = openLog('stdout', stdoutPath);
  errLog = openLog('stderr', stderrPath);
  const stamp = `\n===== supervisor start ${new Date(now()).toISOString()} (pid ${process.pid}) =====\n`;
  try { outLog?.write(stamp); errLog?.write(stamp); } catch {}

  const guard = createRestartGuard({ windowMs, limit, now });
  const seconds = Math.round(windowMs / 1000);
  const state = { child: null, firstLaunch: true, shuttingDown: false, ending: false, listenPort: null };

  // What the supervisor says about the server's end also goes into the server's own error log, beside the
  // server's last lines. Once the logs are closed a late line is dropped, never written to an ended stream.
  const noteInServerLog = (line) => {
    try { errLog?.write(`[supervisor ${new Date(now()).toISOString()}] ${line}\n`); } catch {}
  };

  // Windows: what Windows Error Reporting recorded about a native crash (the module, the fail-fast code, the
  // report's folder), read from the Application log, each part logged as soon as it is found. The next server is
  // never held up for it; a supervisor that ends waits for it, a bounded time (settle).
  const lookupCrash = (pid, since, status) => {
    if (platform !== 'win32' || status.kind !== 'native-crash') return null;
    const said = new Set();
    const tell = (found) => {
      const line = found?.crash ? describeWindowsCrash(found.crash, found.report) : '';
      if (!line || said.has(line)) return;
      said.add(line);
      print.info(line);
      noteInServerLog(line);
    };
    // Its budget fits in the wait of a supervisor that ends: nothing it finds is cut off by that wait.
    const budgetMs = Math.max(0, crashLookupWaitMs - CRASH_LOOKUP_MARGIN_MS);
    return Promise.resolve()
      .then(() => lookupWindowsCrash({ pid, since, platform, onFound: tell, budgetMs }))
      .then((found) => {
        if (found) tell(found);
        else {
          const line = `No Windows Error Reporting event was found for the crash of pid ${pid}.`;
          print.info(line);
          noteInServerLog(line);
        }
        return found;
      }, () => null);
  };

  // What is still on its way to the log files is written before the supervisor goes: a crash's last lines are
  // the ones that say why. So is what Windows recorded about it, `crashLookupWaitMs` at the most.
  const closeStream = (stream) => new Promise((done) => {
    if (!stream) { done(); return; }
    try { stream.end(done); } catch { done(); }
  });
  async function settle(pending = null) {
    if (pending) await within(pending, crashLookupWaitMs);
    const streams = [outLog, errLog];
    outLog = null;
    errLog = null;
    await within(Promise.allSettled(streams.map(closeStream)), 1500);
  }

  // The supervisor ends without a server: it has said so already (onFailed); the restart report says it to a
  // page that waits (lib/start-launcher.js openRestartReport), while the logs get their last lines.
  function endWithoutServer(code, error, pending = null) {
    if (state.ending) return;
    state.ending = true;
    // The crash it recovered from is not news any more: no server came back up to tell it.
    clearCrashRecord(dataHome);
    Promise.allSettled([
      settle(pending),
      Promise.resolve().then(() => reports.failed(error)),
    ]).finally(() => exit(code));
  }

  // A marker file as it is now: { state: 'none' }, { state: 'read', text, mtimeMs } or, when it is there and could
  // not be read after a few tries (a scanner holding it), { state: 'unreadable', code, mtimeMs }.
  const mtimeOf = (path) => {
    try { const ms = files.statSync(path).mtimeMs; return Number.isFinite(ms) ? ms : null; } catch { return null; }
  };
  async function readMarkerFile(path) {
    let failure = null;
    for (let attempt = 0; attempt < Math.max(1, markerReadAttempts); attempt++) {
      if (attempt) await sleep(markerRetryMs);
      try {
        return { state: 'read', text: String(files.readFileSync(path, 'utf8')), mtimeMs: mtimeOf(path) };
      } catch (error) {
        if (error?.code === 'ENOENT') return { state: 'none' };
        failure = error;
        if (!HELD.has(error?.code)) break;
      }
    }
    return { state: 'unreadable', code: String(failure?.code || failure?.message || 'unknown').slice(0, 40), mtimeMs: mtimeOf(path) };
  }

  // The restart marker: { marked, at } (at: when the restart was asked for, when that can be told).
  async function takeRestartMarker() {
    const file = await readMarkerFile(restartMarker);
    if (file.state === 'none') return { marked: false, at: null };
    remove(restartMarker);
    return { marked: true, at: (file.state === 'read' ? readRestartMarker(file.text) : null) ?? file.mtimeMs };
  }

  // The stop marker, taken: { reason, at } of a stop this server asked for, or null. One that is there (its file is
  // seen) but stays unreadable is only ever written for a stop someone asked for, so it is read as a stop (and said
  // so), unless it was plainly written before this server started. One that cannot even be seen (Windows: a file
  // being deleted while something still holds it) proves nothing.
  async function takeStopMarker(pid, since) {
    const file = await readMarkerFile(stopMarker);
    if (file.state === 'none') return null;
    remove(stopMarker);
    if (file.state === 'read') return readStopMarker(file.text, { pid, since });
    if (file.mtimeMs === null) {
      noteInServerLog(`A stop marker could not be read or seen (${file.code}) when the server (pid ${pid}) ended: it says nothing about this end.`);
      return null;
    }
    if (file.mtimeMs < since - MARKER_CLOCK_SLACK_MS) return null;
    const line = `The stop marker of the server (pid ${pid}) is there but could not be read (${file.code}): its end is read as the stop it stands for.`;
    print.warn(line);
    noteInServerLog(line);
    return { reason: '', at: file.mtimeMs, unreadable: true };
  }

  // The server has ended and its output was read: what it left (its markers) is read, then it is started again, or
  // the supervisor ends too.
  function onServerEnd(child, status, info) {
    if (state.child === child) state.child = null;
    if (state.shuttingDown || state.ending) return;
    // (decided once: a read that failed decides without the markers, a decision that failed is only said)
    Promise.all([takeRestartMarker(), takeStopMarker(child.pid, info.spawnedAt)]).then(
      ([restart, marker]) => decideEnd(child, status, { ...info, restart, marker }),
      (error) => {
        print.fail(`The markers the server left could not be read: ${error?.message || error}`);
        decideEnd(child, status, { ...info, restart: { marked: false, at: null }, marker: null });
      },
    ).catch((error) => print.fail(`The end of the server could not be decided: ${error?.message || error}`));
  }

  function decideEnd(child, { code, signal }, { listened, spawnedAt, announced, restart, marker }) {
    if (state.shuttingDown || state.ending) return;
    const restartMarked = restart.marked;
    const stop = marker || announced;
    // Both asked for: the later request wins (a stop asked while a restart shut down: the desktop app quitting).
    const stopAfterRestart = !!stop && restartMarked && Number.isFinite(stop.at) && Number.isFinite(restart.at) && stop.at >= restart.at;
    const status = describeExit({ code, signal });
    const decision = serverExitDecision({ code, signal, restartRequested: restartMarked, stopRequested: !!stop, stopAfterRestart, listened });

    if (decision === 'restart' || decision === 'crashed') {
      const crashed = decision === 'crashed';
      if (crashed) {
        // Nobody asked for this end: the server crashed after it was up. It is started again, as a restart is,
        // within the same crash-loop guard.
        print.fail(`The server crashed: ${formatExit(status)}.`);
        noteInServerLog(`The server (pid ${child.pid}) crashed: ${formatExit(status)}. Starting it again.`);
      } else if (code === RESTART_EXIT_CODE) {
        print.info('Server requested restart — respawning...');
      } else {
        print.info(`Server exited with code ${code} but restart marker present — respawning.`);
      }
      const lookup = crashed ? lookupCrash(child.pid, spawnedAt, status) : null;
      const { count, exceeded } = guard.note();
      // The page that asked for this has no server to ask now: from here until the new one is listening, this
      // supervisor says what happens.
      try { reports.reopen(state.listenPort || resolvePort()); } catch {}
      if (exceeded) {
        // A loop of crashes says how the last one ended (the app's stopped page names it); restarts asked for do not.
        const message = crashed
          ? `the server stopped ${count} times in ${seconds} s (the last time: ${status.text})`
          : `the server restarted ${count} times in ${seconds} s`;
        const fields = crashed ? exitRecordFields(status) : {};
        print.fail(`Server restarted ${count} times in ${seconds}s — aborting supervisor.`);
        onFailed('RESTART_LOOP', message, fields);
        endWithoutServer(1, { code: 'RESTART_LOOP', message, ...fields }, lookup);
        return;
      }
      if (crashed) {
        // The server it starts tells the owner's pages, once, what happened and what was lost.
        if (!writeCrashRecord(dataHome, { exit: status, at: now(), uptimeMs: Math.max(0, now() - spawnedAt) })) {
          print.warn('Could not leave the crash notice for the next server.');
        }
        print.info(`Starting it again (${count} of ${limit} restarts within ${seconds} s).`);
      }
      state.firstLaunch = false;
      setTimeout(spawnOnce, respawnDelayMs);
      return;
    }

    if (decision === 'failed') {
      // It ended before it was listening: a start that failed. Starting it again would fail the same way, so the
      // start reports it and ends.
      const message = `the server exited before it was listening (${status.text})`;
      print.fail(`Server exited with code ${code ?? signal}: ${formatExit(status)}`);
      noteInServerLog(`The server (pid ${child.pid}) ended before it was listening: ${formatExit(status)}.`);
      onFailed('SERVER_EXITED', message, exitRecordFields(status));
      endWithoutServer(Number.isInteger(code) && code !== 0 ? code : 1, { code: 'SERVER_EXITED', message, ...exitRecordFields(status) }, lookupCrash(child.pid, spawnedAt, status));
      return;
    }

    // Stopped: asked for (Stop Server, the app quitting, an update), or a clean end.
    state.ending = true;
    print.info(`Server stopped${stop?.reason ? ` (${stop.reason})` : ''}.`);
    if (stopAfterRestart) print.info('The restart it had asked for was called off by the stop asked after it.');
    // A native crash on the way out (a native teardown abort) is still worth a line.
    if (status.kind === 'native-crash') {
      print.info(`It ended with ${formatExit(status)} while it stopped.`);
      noteInServerLog(`The server (pid ${child.pid}) ended with ${formatExit(status)} while it stopped.`);
    }
    settle().finally(() => exit(0));
  }

  function spawnFailed(error) {
    const message = `the server could not be started: ${error?.message || error}`;
    print.fail(`Could not start the server: ${error?.message || error}`);
    onFailed('SERVER_SPAWN_FAILED', message);
    endWithoutServer(1, { code: 'SERVER_SPAWN_FAILED', message });
  }

  function spawnOnce() {
    if (state.shuttingDown || state.ending) return;
    remove(stopMarker);
    const spawnedAt = now();
    // This start's token: the server prints it with a stop someone asked of it (lib/server-exit.js
    // stopAnnouncement), which tells the stop without the data folder.
    const token = newToken();
    let child;
    try {
      child = spawn(execPath, [...nodeArgs, serverPath], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide,
        env: {
          ...(typeof env === 'function' ? env() : env),
          SYNABUN_DATA_HOME: dataHome,
          MEMORY_DATA_DIR: resolve(dataHome, 'mcp-data'),
          SYNABUN_SUPERVISED: '1',
          [STOP_TOKEN_ENV]: token,
        },
      });
    } catch (error) {
      spawnFailed(error);
      return;
    }
    state.child = child;
    onPhase('server', { pid: child.pid });

    const first = state.firstLaunch;
    let listened = false;
    let announced = null;
    const lines = createLineReader((line) => {
      const said = readStopAnnouncement(line, token);
      // When it was said, by this supervisor's clock (the latest, when it is said again): a restart asked for
      // before it gives way to it.
      if (said) { announced = { ...said, at: now() }; return; }
      if (listened) return;
      // The server prints its address from its listen callback: it is up.
      const address = listeningAddress(line);
      if (!address) return;
      listened = true;
      if (address.port) state.listenPort = address.port;
      onPhase('listening', { port: address.port || undefined });
      try { onListening({ port: address.port, first }); } catch {}
    });

    // Its end is decided once its output has been read to the end, or a moment after it exited when something it
    // started still holds that output open: a crash's last words are its last lines.
    const end = watchChildEnd(child, {
      drainMs,
      onEnd: (status) => {
        lines.end();
        onServerEnd(child, status, { listened, spawnedAt, announced });
      },
    });
    child.on('error', (error) => {
      // A server that could not be started at all is reported here, and not a second time as an end.
      if (end.decided) return;
      end.cancel();
      if (state.child === child) state.child = null;
      spawnFailed(error);
    });
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (text) => {
      try { passthrough?.stdout?.write(text); } catch {}
      try { outLog?.write(text); } catch {}
      lines.push(text);
    });
    child.stderr?.on('data', (text) => {
      try { passthrough?.stderr?.write(text); } catch {}
      try { errLog?.write(text); } catch {}
    });
  }

  spawnOnce();

  return {
    get child() { return state.child; },
    /** The supervisor's own signal: the server gets it too (its handler stops it gracefully), and this ends. */
    stop(signal) {
      state.shuttingDown = true;
      try { state.child?.kill(signal); } catch {}
      exit(0);
    },
  };
}

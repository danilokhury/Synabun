// ═══════════════════════════════════════════
// SynaBun — the client side of ACP's file and terminal methods (Antigravity side panel)
// ═══════════════════════════════════════════
//
// An ACP client may offer the agent its own file system and terminals (clientCapabilities
// `fs` and `terminal`): the agent then reads and writes text files and runs commands through
// the client instead of by itself. The Antigravity side panel offers them only when the owner
// turned them on in the panel (its "let Antigravity use SynaBun for files / commands" switches,
// sent with the socket's hello); lib/antigravity/panel-bridge.js routes the agent's requests
// here and answers "method not found" for what was not offered. One host per panel socket.
//
//   fs/read_text_file      { sessionId, path, line?, limit? }                     -> { content }
//   fs/write_text_file     { sessionId, path, content }                            -> {}
//   terminal/create        { sessionId, command, args?, env?, cwd?, outputByteLimit? } -> { terminalId }
//   terminal/output        { sessionId, terminalId }   -> { output, truncated, exitStatus: null | { exitCode, signal } }
//   terminal/wait_for_exit { sessionId, terminalId }   -> { exitCode, signal }
//   terminal/kill          { sessionId, terminalId }   -> {}   the terminal stays readable
//   terminal/release       { sessionId, terminalId }   -> {}   killed first when still running, then forgotten
//
// Files: an absolute path. A read is of a regular file of at most 10 MB, decoded as UTF-8 (a
// file that is not UTF-8 is refused; a byte-order mark is kept, so a read written back is the
// same file); `line` is the 1-based first line, `limit` a number of lines, each line with its
// own ending. A write of at most 10 MB creates the file and its missing folders, or replaces
// the content of the regular file that is there, in place: its mode, owner and links stay.
// A folder, a link to one, a device or a FIFO is refused, and nothing waits on a FIFO.
//
// Terminals: the command runs in `cwd` (an absolute folder; the session's own when not given)
// with the agent's own environment plus the pairs it named, then `terminalEnv`, which the agent
// cannot change (the panel marks every command as the agent's: SYNABUN_AGENT_TERMINAL, because
// SynaBun's server, not the agent, is its parent process). Without `args` the command is a
// command line for the platform's shell (POSIX `/bin/sh -c`, Windows `cmd.exe /d /s /c`);
// with them it is a program started without a shell. On POSIX it leads its own process group,
// so a kill reaches what it started (Windows: taskkill /T). stdin is closed; stdout and stderr
// are one output, kept to `outputByteLimit` bytes (default 1 MiB, at most 16 MiB) by dropping
// from the beginning at a character boundary (`truncated` says so). At most 16 terminals at a
// time, released or not: a terminal holds its output until the agent releases it.
// `onOutput(snapshot)` sees a terminal's whole current output at most every 250 ms while it
// grows, and once more when the command ends (also after a release).
//
// Nothing here confines a path: the agent runs as the owner and reads and writes the same files
// by itself. What this adds is bounds, the refusals above, and an end for everything it
// started (`releaseSession`, `releaseAll`).

import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk/unstable';
import { forgetAgentProcess, registerAgentProcess } from '../peer-identity.js';

export const ACP_CLIENT_HOST_LIMITS = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  defaultOutputBytes: 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
  maxTerminals: 16,
  outputThrottleMs: 250,
  killGraceMs: 2_000,
  // After the command exits, how long its output may still arrive before the end is reported
  // (something it started in the background can hold the pipe open far longer).
  exitDrainMs: 150,
  maxCommandChars: 32 * 1024,
  maxArgs: 1_000,
  maxArgChars: 32 * 1024,
  maxEnv: 200,
  maxEnvValueChars: 32 * 1024,
});

const O_NONBLOCK = fsConstants.O_NONBLOCK || 0;
const BLOCK_BYTES = 64 * 1024;
const MAX_ID_CHARS = 500;
const FS_METHODS = new Set(['fs/read_text_file', 'fs/write_text_file']);

const invalid = (message, data) => RequestError.invalidParams(data, message);
const megabytes = (bytes) => (bytes >= 1048576 ? `${Math.round(bytes / 1048576)} MB` : `${bytes} bytes`);

/** The error an fs call failed with, as the agent should read it. */
function fileError(error, path) {
  switch (error?.code) {
    case 'ENOENT': case 'ENOTDIR': return RequestError.resourceNotFound(path);
    case 'EISDIR': return invalid(`${path} is a folder, not a file.`, { path });
    case 'EACCES': case 'EPERM': return invalid(`Permission denied: ${path}`, { path });
    case 'ELOOP': return invalid(`Too many links on the way to ${path}.`, { path });
    case 'EFBIG': case 'ENOSPC': case 'EDQUOT': case 'EROFS': return invalid(`${path} cannot be written: ${error.code}.`, { path });
    default: return RequestError.internalError({ path, code: error?.code || null }, error?.message || String(error));
  }
}

function absolutePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw invalid('`path` must be an absolute path.');
  if (!isAbsolute(value)) throw invalid(`\`path\` must be an absolute path: ${value}`, { path: value });
  return value;
}

function sessionIdOf(params) {
  const id = params?.sessionId;
  if (typeof id !== 'string' || !id || id.length > MAX_ID_CHARS) throw invalid('Unknown session.');
  return id;
}

/** Lines `line` (1-based) … `line + limit - 1` of `text`, each with its own ending; all of it without either. */
export function sliceLines(text, line, limit) {
  const first = Number.isInteger(line) && line > 1 ? line : 1;
  const count = Number.isInteger(limit) && limit >= 0 ? limit : null;
  if (first === 1 && count === null) return text;
  let start = 0;
  for (let n = 1; n < first; n++) {
    const next = text.indexOf('\n', start);
    if (next === -1) return '';
    start = next + 1;
  }
  if (count === null) return text.slice(start);
  let end = start;
  for (let n = 0; n < count; n++) {
    const next = text.indexOf('\n', end);
    if (next === -1) { end = text.length; break; }
    end = next + 1;
  }
  return text.slice(start, end);
}

/** How much of `buf` holds whole UTF-8 characters: a sequence cut at its end is left for later. */
export function completeUtf8Length(buf) {
  const n = buf.length;
  for (let i = n - 1, back = 0; i >= 0 && back < 4; i--, back++) {
    const byte = buf[i];
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return n - i >= need ? n : i;
  }
  return n;
}

/**
 * A command's output, kept to its last `limit` bytes. Written in 64 KB blocks (no copy of what is
 * already kept on every write); read whole, from a character boundary when its start was dropped.
 */
export function createOutputBuffer(limit) {
  const blocks = [];
  let tailUsed = 0;    // bytes written into the last block
  let headOffset = 0;  // bytes of the first block already dropped
  let size = 0;        // bytes kept
  let truncated = false;
  const usedOf = (index) => (index === blocks.length - 1 ? tailUsed : blocks[index].length) - (index === 0 ? headOffset : 0);
  return {
    push(chunk) {
      if (!chunk?.length) return;
      let at = 0;
      while (at < chunk.length) {
        let tail = blocks[blocks.length - 1];
        if (!tail || tailUsed === tail.length) {
          tail = Buffer.allocUnsafe(BLOCK_BYTES);
          blocks.push(tail);
          tailUsed = 0;
        }
        const copied = chunk.copy(tail, tailUsed, at, Math.min(chunk.length, at + tail.length - tailUsed));
        tailUsed += copied;
        at += copied;
        size += copied;
      }
      while (size > limit) {
        truncated = true;
        const first = usedOf(0);
        const excess = size - limit;
        if (excess >= first && blocks.length > 1) {
          blocks.shift();
          headOffset = 0;
          size -= first;
          continue;
        }
        const drop = Math.min(excess, first);
        headOffset += drop;
        size -= drop;
        break;
      }
    },
    /** `final`: the command ended, so a character cut at the very end is kept (as U+FFFD). */
    read(final = false) {
      const parts = blocks.map((block, index) => block.subarray(index === 0 ? headOffset : 0, index === blocks.length - 1 ? tailUsed : block.length));
      const all = Buffer.concat(parts, size);
      let from = 0;
      if (truncated) while (from < all.length && (all[from] & 0xc0) === 0x80) from++;
      const to = final ? all.length : Math.max(from, completeUtf8Length(all));
      return { output: all.subarray(from, to).toString('utf8'), truncated };
    },
  };
}

function shellCommand(command, platform, env) {
  if (platform === 'win32') {
    return { file: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], options: { windowsVerbatimArguments: true } };
  }
  return { file: '/bin/sh', args: ['-c', command], options: {} };
}

/**
 * `childEnv()`: the agent's own environment, which a command starts from. `terminalEnv`: variables
 * every command gets last, over the agent's own pairs. `sessionCwd(sessionId)`: the folder a session
 * runs in, or null (a command without `cwd` in an unknown session is refused).
 * `onOutput({ sessionId, terminalId, output, truncated, exitStatus })`: see the header.
 * `spawnImpl`, `fs` (node:fs/promises' open, stat, mkdir), `killImpl` (process.kill) and `platform`
 * are there for tests.
 */
export function createAcpClientHost({
  childEnv = () => process.env,
  terminalEnv = {},
  sessionCwd = () => null,
  onOutput = null,
  spawnImpl = nodeSpawn,
  fs = nodeFs,
  killImpl = (pid, signal) => process.kill(pid, signal),
  platform = process.platform,
  limits = ACP_CLIENT_HOST_LIMITS,
  log = () => {},
  // Every command is the agent's: while it runs, its process tree never holds the owner's authority
  // (lib/peer-identity.js; the server, not the agent, is its parent, so no agent is in its tree by name).
  registerProcess = registerAgentProcess,
  forgetProcess = forgetAgentProcess,
} = {}) {
  const terminals = new Map();   // terminalId -> entry
  let reserved = 0;              // terminals being started

  // ── Files ──────────────────────────────────────────────────────────────

  async function readTextFile(params) {
    sessionIdOf(params);
    const path = absolutePath(params.path);
    let handle;
    try { handle = await fs.open(path, fsConstants.O_RDONLY | O_NONBLOCK); } catch (error) { throw fileError(error, path); }
    try {
      const stat = await handle.stat();
      if (stat.isDirectory()) throw invalid(`${path} is a folder, not a file.`, { path });
      if (!stat.isFile()) throw invalid(`${path} is not a regular file.`, { path });
      if (stat.size > limits.maxFileBytes) throw invalid(`${path} is larger than ${megabytes(limits.maxFileBytes)}.`, { path, size: stat.size });
      const parts = [];
      let total = 0;
      for (;;) {
        const room = limits.maxFileBytes + 1 - total;
        if (room <= 0) break;
        const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, room));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        parts.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
      if (total > limits.maxFileBytes) throw invalid(`${path} is larger than ${megabytes(limits.maxFileBytes)}.`, { path });
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts, total)); } catch { throw invalid(`${path} is not UTF-8 text.`, { path }); }
      return { content: sliceLines(text, params.line, params.limit) };
    } catch (error) {
      throw error instanceof RequestError ? error : fileError(error, path);
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async function writeTextFile(params) {
    sessionIdOf(params);
    const path = absolutePath(params.path);
    if (typeof params.content !== 'string') throw invalid('`content` must be text.');
    const data = Buffer.from(params.content, 'utf8');
    if (data.length > limits.maxFileBytes) throw invalid(`The content is larger than ${megabytes(limits.maxFileBytes)}.`, { path, size: data.length });
    let existing = null;
    try { existing = await fs.stat(path); } catch (error) { if (error?.code !== 'ENOENT') throw fileError(error, path); }
    if (existing?.isDirectory()) throw invalid(`${path} is a folder, not a file.`, { path });
    if (existing && !existing.isFile()) throw invalid(`${path} is not a regular file.`, { path });
    if (!existing) {
      try { await fs.mkdir(dirname(path), { recursive: true }); } catch (error) { throw fileError(error, dirname(path)); }
    }
    let handle;
    try { handle = await fs.open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | O_NONBLOCK, 0o666); } catch (error) { throw fileError(error, path); }
    try {
      // What was opened is what is written: a regular file, emptied only now.
      const stat = await handle.stat();
      if (stat.isDirectory()) throw invalid(`${path} is a folder, not a file.`, { path });
      if (!stat.isFile()) throw invalid(`${path} is not a regular file.`, { path });
      await handle.truncate(0);
      if (data.length) await handle.writeFile(data);
      return {};
    } catch (error) {
      throw error instanceof RequestError ? error : fileError(error, path);
    } finally {
      await handle.close().catch(() => {});
    }
  }

  // ── Terminals ──────────────────────────────────────────────────────────

  function argsOf(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > limits.maxArgs) throw invalid(`\`args\` must be a list of at most ${limits.maxArgs} words.`);
    for (const arg of value) {
      if (typeof arg !== 'string' || arg.length > limits.maxArgChars || arg.includes('\0')) throw invalid('An argument is not text, or too long.');
    }
    return [...value];
  }

  function envPairsOf(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > limits.maxEnv) throw invalid(`\`env\` must be a list of at most ${limits.maxEnv} variables.`);
    return value.map((pair) => {
      const name = pair?.name;
      const text = pair?.value;
      if (typeof name !== 'string' || !name || name.length > 256 || /[=\0]/.test(name)) throw invalid(`Not a variable name: ${String(name).slice(0, 80)}`);
      if (typeof text !== 'string' || text.length > limits.maxEnvValueChars || text.includes('\0')) throw invalid(`The value of ${name} is not text, or too long.`);
      return { name, value: text };
    });
  }

  function environment(pairs) {
    const env = { ...(childEnv() || {}) };
    const set = (name, value) => {
      // Windows reads names in any case: one PATH, never PATH and Path.
      if (platform === 'win32') for (const key of Object.keys(env)) if (key.toUpperCase() === name.toUpperCase()) delete env[key];
      env[name] = value;
    };
    for (const { name, value } of pairs) set(name, value);
    for (const [name, value] of Object.entries(terminalEnv || {})) set(name, String(value));
    return env;
  }

  async function cwdOf(value, sessionId) {
    let dir = value;
    if (dir === undefined || dir === null || dir === '') dir = sessionCwd(sessionId);
    if (typeof dir !== 'string' || !dir) throw invalid('No folder to run in: give `cwd`, an absolute path.');
    if (!isAbsolute(dir) || dir.includes('\0')) throw invalid(`\`cwd\` must be an absolute path: ${dir}`);
    let stat;
    try { stat = await fs.stat(dir); } catch { throw invalid(`The folder ${dir} does not exist.`, { cwd: dir }); }
    if (!stat.isDirectory()) throw invalid(`${dir} is not a folder.`, { cwd: dir });
    return dir;
  }

  function outputLimitOf(value) {
    if (value === undefined || value === null) return limits.defaultOutputBytes;
    if (!Number.isInteger(value) || value < 0) throw invalid('`outputByteLimit` must be a whole number of bytes.');
    return Math.min(value, limits.maxOutputBytes);
  }

  function signalTree(entry, signal) {
    const pid = entry.child?.pid;
    if (!pid) return;
    if (platform === 'win32') {
      try {
        const killer = spawnImpl('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer?.on?.('error', () => {});
      } catch { /* the plain kill below */ }
      try { entry.child.kill(); } catch { /* gone */ }
      return;
    }
    try { killImpl(-pid, signal); } catch { try { entry.child.kill(signal); } catch { /* gone */ } }
  }

  function snapshotOf(entry) {
    const { output, truncated } = entry.output.read(entry.finished);
    return { output, truncated, exitStatus: entry.finished ? { ...entry.exitStatus } : null };
  }

  function emit(entry) {
    entry.dirty = false;
    entry.lastEmit = Date.now();
    if (typeof onOutput !== 'function') return;
    try { onOutput({ sessionId: entry.sessionId, terminalId: entry.terminalId, ...snapshotOf(entry) }); } catch (error) { log(`terminal output listener failed: ${error?.message || error}`); }
  }

  function scheduleEmit(entry) {
    if (entry.timer || entry.released || typeof onOutput !== 'function') return;
    const wait = Math.max(0, entry.lastEmit + limits.outputThrottleMs - Date.now());
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (entry.dirty && !entry.released) emit(entry);
    }, wait);
    entry.timer.unref?.();
  }

  function closePipes(entry) {
    try { entry.child.stdout?.destroy(); } catch { /* closed */ }
    try { entry.child.stderr?.destroy(); } catch { /* closed */ }
  }

  function finish(entry, code, signal) {
    if (entry.finished) return;
    if (!entry.exitStatus) entry.exitStatus = { exitCode: Number.isInteger(code) ? code : null, signal: signal || null };
    entry.finished = true;
    clearTimeout(entry.timer);
    entry.timer = null;
    clearTimeout(entry.drainTimer);
    for (const waiter of entry.waiters.splice(0)) waiter.resolve({ ...entry.exitStatus });
    emit(entry);
    if (entry.released) closePipes(entry);
  }

  // SIGTERM to the command and what it started, SIGKILL to whatever of it is still there after the grace.
  function kill(entry) {
    if (entry.finished && !entry.pipesOpen) return;
    signalTree(entry, 'SIGTERM');
    if (!entry.killTimer) {
      entry.killTimer = setTimeout(() => { if (!entry.finished || entry.pipesOpen) signalTree(entry, 'SIGKILL'); }, limits.killGraceMs);
      entry.killTimer.unref?.();
    }
  }

  function release(entry) {
    if (entry.released) return;
    entry.released = true;
    terminals.delete(entry.terminalId);
    clearTimeout(entry.timer);
    entry.timer = null;
    kill(entry);
    // Output of something it left running in the background is not read any more.
    if (entry.finished) closePipes(entry);
  }

  function terminalOf(params) {
    const sessionId = sessionIdOf(params);
    const id = params?.terminalId;
    const entry = typeof id === 'string' ? terminals.get(id) : null;
    if (!entry || entry.sessionId !== sessionId) throw invalid(`Unknown terminal: ${String(id).slice(0, 80)}`, { terminalId: typeof id === 'string' ? id.slice(0, 200) : null });
    return entry;
  }

  async function createTerminal(params) {
    const sessionId = sessionIdOf(params);
    if (terminals.size + reserved >= limits.maxTerminals) throw invalid(`At most ${limits.maxTerminals} terminals at a time: release one first.`);
    const command = params.command;
    if (typeof command !== 'string' || !command.trim() || command.length > limits.maxCommandChars || command.includes('\0')) throw invalid('`command` must be a command line of at most 32 KB.');
    const args = argsOf(params.args);
    const pairs = envPairsOf(params.env);
    const outputLimit = outputLimitOf(params.outputByteLimit);
    reserved += 1;
    try {
      const cwd = await cwdOf(params.cwd, sessionId);
      const env = environment(pairs);
      const launch = args.length ? { file: command, args, options: {} } : shellCommand(command, platform, env);
      let child;
      try {
        child = spawnImpl(launch.file, launch.args, {
          cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: platform !== 'win32', ...launch.options,
        });
      } catch (error) {
        throw RequestError.internalError({ command: command.slice(0, 200) }, `Could not start ${command.slice(0, 200)}: ${error?.message || error}`);
      }
      // From the start: an error the child reports later is logged, never thrown at the server.
      child?.on?.('error', (error) => log(`terminal (${command.slice(0, 80)}): ${error?.message || error}`));
      await new Promise((resolve, reject) => {
        if (typeof child?.once !== 'function') { reject(new Error('the command did not start')); return; }
        const started = () => { child.off?.('error', failed); resolve(); };
        const failed = (error) => { child.off?.('spawn', started); reject(error); };
        child.once('spawn', started);
        child.once('error', failed);
      }).catch((error) => {
        throw RequestError.internalError({ command: command.slice(0, 200), code: error?.code || null }, `Could not start ${command.slice(0, 200)}: ${error?.message || error}`);
      });
      const entry = {
        terminalId: `term-${randomBytes(8).toString('hex')}`,
        sessionId,
        child,
        output: createOutputBuffer(outputLimit),
        exitStatus: null,
        finished: false,
        released: false,
        pipesOpen: true,
        waiters: [],
        timer: null,
        drainTimer: null,
        killTimer: null,
        dirty: false,
        lastEmit: 0,
      };
      const onData = (chunk) => {
        entry.output.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        entry.dirty = true;
        scheduleEmit(entry);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      try { registerProcess(child.pid, 'antigravity command'); } catch { /* the guard is best effort; the command runs */ }
      child.on('exit', (code, signal) => {
        try { forgetProcess(child.pid); } catch { /* already forgotten */ }
        entry.exitStatus = { exitCode: Number.isInteger(code) ? code : null, signal: signal || null };
        entry.drainTimer = setTimeout(() => finish(entry, code, signal), limits.exitDrainMs);
        entry.drainTimer.unref?.();
      });
      child.on('close', (code, signal) => { entry.pipesOpen = false; finish(entry, code, signal); });
      terminals.set(entry.terminalId, entry);
      return { terminalId: entry.terminalId };
    } finally {
      reserved -= 1;
    }
  }

  function terminalOutput(params) {
    return snapshotOf(terminalOf(params));
  }

  function waitForTerminalExit(params, { signal } = {}) {
    const entry = terminalOf(params);
    if (entry.finished) return { ...entry.exitStatus };
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (status) => { signal?.removeEventListener?.('abort', onAbort); resolve(status); },
      };
      const onAbort = () => {
        const at = entry.waiters.indexOf(waiter);
        if (at !== -1) entry.waiters.splice(at, 1);
        reject(RequestError.requestCancelled());
      };
      if (signal?.aborted) { reject(RequestError.requestCancelled()); return; }
      signal?.addEventListener?.('abort', onAbort, { once: true });
      entry.waiters.push(waiter);
    });
  }

  function killTerminal(params) {
    kill(terminalOf(params));
    return {};
  }

  function releaseTerminal(params) {
    release(terminalOf(params));
    return {};
  }

  const HANDLERS = {
    'fs/read_text_file': readTextFile,
    'fs/write_text_file': writeTextFile,
    'terminal/create': createTerminal,
    'terminal/output': terminalOutput,
    'terminal/wait_for_exit': waitForTerminalExit,
    'terminal/kill': killTerminal,
    'terminal/release': releaseTerminal,
  };

  return {
    /**
     * Answers one client method. `allow` ({ fs, terminal }) is what the client offered the agent
     * that asked: a method outside it is refused as "method not found", as one never offered.
     */
    async handle(method, params, { signal, allow = { fs: true, terminal: true } } = {}) {
      const handler = Object.hasOwn(HANDLERS, method) ? HANDLERS[method] : null;
      if (!handler) throw RequestError.methodNotFound(method);
      if (allow?.[FS_METHODS.has(method) ? 'fs' : 'terminal'] !== true) throw RequestError.methodNotFound(method);
      return handler(params && typeof params === 'object' ? params : {}, { signal });
    },
    /** Kills and forgets every terminal of a session (it closed, or was deleted). */
    releaseSession(sessionId) {
      for (const entry of [...terminals.values()]) if (entry.sessionId === sessionId) release(entry);
    },
    /** Kills and forgets every terminal (the agent restarted or ended, the socket closed). */
    releaseAll() {
      for (const entry of [...terminals.values()]) release(entry);
    },
    liveCount: () => terminals.size,
  };
}

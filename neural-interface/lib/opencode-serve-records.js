// ─────────────────────────────────────────────────────────────────────────────
// SynaBun's own OpenCode serves, on record, and what a crash left of them.
//
// Every `opencode serve` SynaBun starts is on record from its spawn until its
// process has ended: the shared serve (which the session title generator uses
// too), the isolated serves of panel sessions, loops and Assistant workers and
// brains, and the code editor's completion serve. One file per process,
// DATA_HOME/runtime/opencode-serves/<pid>.json (outside data/: process state
// of this machine, which no backup or restore carries):
//   { v, kind, id, port, pid, startedAt, command, token, scope, owner, recordedAt }
// `pid`, `startedAt` and `command` are the process's identity as the OS reports
// it (lib/process-identity.js); `token` is the random token SynaBun put in the
// serve's environment when it spawned it (SERVE_TOKEN_ENV), which nothing else
// carries; `scope` is the machine, the user and the boot the record was written
// in; `owner` is the identity of the SynaBun server that started it. The
// spawned process is recorded at once (record()), and the process that answers
// on the port too when the spawned one started it, proved through the parent
// chain (answering()). No other process is ever recorded: another server that
// took the port is a start collision, left running and off record.
//
// SynaBun stops a recorded process only when it can prove that SynaBun spawned
// it, on this machine, for this user, in this boot, and that the SynaBun that
// started it has ended:
//   • the record is whole (identity, port, token, scope, and a command line
//     that serves on its port, read as the platform parses it) and was written
//     on this machine, by this user, in this boot;
//   • the OS still reports the very process recorded (verify()): the same pid
//     and start time, a command line that serves on the port, the user's own,
//     and the token in its environment (Windows, where no other process's
//     environment can be read: the same command line, and a start time to the
//     fraction of a second); read again right before each signal (SIGTERM,
//     then SIGKILL when it stays);
//   • its owner has positively ended: no process runs under the owner's pid,
//     or one with another start time or command line. The running server
//     stops its own serves itself (claimable()), never in the sweep.
// Anything unknown, unreadable or ambiguous is left running: an owner that was
// never recorded or cannot be read, a process whose identity, user or
// environment cannot be read, a record of another machine or user. A record is
// removed only once its process has provably ended (gone, its pid another
// process's, or an earlier boot); a record whose process cannot be read stays
// for the next look. Nothing else is looked for: the machine's processes are
// never listed and searched for OpenCode, and a process SynaBun did not record
// is never signalled.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  SERVE_TOKEN_ENV, listPortListenersAsync, newServeToken, pidExists, readEnvironmentHas, readEnvironmentHasAsync,
  readHostScope, readHostScopeAsync, readProcessIdentity, readProcessIdentityAsync, readProcessParentAsync, sameProcess,
} from './process-identity.js';

/** The serves SynaBun starts. */
export const SERVE_KINDS = Object.freeze(['shared', 'isolated', 'completion']);
export const RECORD_VERSION = 2;

const RECORD_FILE = /^(\d+)\.json$/;
const TOKEN = /^[0-9a-f]{32}$/;
// A Windows start time to the fraction of a second (CIM's CreationDate, ISO 8601 with 7 digits).
const FINE_START = /T\d{2}:\d{2}:\d{2}\.\d{4,}/;
const isPid = (n) => Number.isInteger(n) && n > 0;
const isPort = (n) => Number.isInteger(n) && n > 0 && n <= 65535;
const str = (v) => (typeof v === 'string' ? v : '');

// ── Command lines, as the platform reads them ───────────────────────────────

/**
 * A Windows command line split the way a program's C runtime splits it: whitespace parts the arguments, double
 * quotes group them, backslashes are literal except before a quote, and "" inside quotes is a quote.
 * @param {string} line
 */
export function windowsArgv(line) {
  const text = String(line ?? '');
  const n = text.length;
  const args = [];
  let i = 0;
  while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
  if (i >= n) return args;
  // The program's name: up to the next quote when it starts with one, else up to whitespace; no escapes in it.
  let program = '';
  if (text[i] === '"') { i++; while (i < n && text[i] !== '"') program += text[i++]; i++; }
  else { while (i < n && text[i] !== ' ' && text[i] !== '\t') program += text[i++]; }
  args.push(program);
  for (;;) {
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
    if (i >= n) break;
    let arg = '';
    let quoted = false;
    while (i < n) {
      const c = text[i];
      if (!quoted && (c === ' ' || c === '\t')) break;
      if (c === '\\') {
        let k = i;
        while (k < n && text[k] === '\\') k++;
        const count = k - i;
        if (text[k] === '"') {
          arg += '\\'.repeat(Math.floor(count / 2));
          if (count % 2) { arg += '"'; i = k + 1; } else i = k;
        } else { arg += '\\'.repeat(count); i = k; }
        continue;
      }
      if (c === '"') {
        if (quoted && text[i + 1] === '"') { arg += '"'; i += 2; continue; }
        quoted = !quoted;
        i++;
        continue;
      }
      arg += c;
      i++;
    }
    args.push(arg);
  }
  return args;
}

// cmd.exe's reading of the line after /c: a caret takes the next character as it is (an escaped quote opens
// nothing), quotes group, unescaped whitespace outside quotes parts the words. The words keep their quotes.
function cmdWords(line) {
  const text = String(line ?? '');
  const words = [];
  let word = '';
  let quoted = false;
  let has = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!quoted && (c === ' ' || c === '\t')) { if (has) { words.push(word); word = ''; has = false; } continue; }
    has = true;
    if (c === '"') { quoted = !quoted; word += c; continue; }
    if (c === '^' && !quoted && i + 1 < text.length) { word += text[++i]; continue; }
    word += c;
  }
  if (has) words.push(word);
  return words;
}

// The text after cmd.exe's own switches up to /c (or /k), outer quotes taken off as /s does; null when there is none.
function cmdCommandText(line) {
  const text = String(line ?? '');
  let i = 0;
  const n = text.length;
  while (i < n && /\s/.test(text[i])) i++;
  if (text[i] === '"') { i = text.indexOf('"', i + 1); if (i < 0) return null; i++; }
  else while (i < n && !/\s/.test(text[i])) i++;
  for (;;) {
    while (i < n && /\s/.test(text[i])) i++;
    if (text[i] !== '/') return null;
    let j = i;
    while (j < n && !/\s/.test(text[j])) j++;
    const word = text.slice(i, j).toLowerCase();
    i = j;
    if (word === '/c' || word === '/k') break;
  }
  let rest = text.slice(i).trim();
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
  return rest;
}

const windowsBase = (path) => String(path ?? '').split(/[\\/]/).pop() || '';

/**
 * The arguments a command line holds, as the platform reads it. Windows: the C runtime's split; a cmd.exe that
 * runs a command (`cmd.exe /d /s /c "…"`, how a command file is started: lib/cli-resolver.js spawnArgsFor) is read
 * through to what it runs: its carets once, and once more for a command file (.cmd, .bat), which reads its own
 * arguments again. Elsewhere: the words `ps` prints.
 * @param {string} command
 * @param {string} [platform]
 */
export function commandArgs(command, platform = process.platform) {
  const text = str(command).trim();
  if (!text) return [];
  if (platform !== 'win32') return text.split(/\s+/);
  const argv = windowsArgv(text);
  if (!/^cmd(?:\.exe)?$/i.test(windowsBase(argv[0]))) return argv;
  const inner = cmdCommandText(text);
  if (inner == null) return argv;
  const words = cmdWords(inner);
  if (!words.length) return argv;
  // The program cmd.exe runs: its first word, quotes only group it (an escaped space is part of it).
  const target = words[0].replace(/"/g, '');
  const rest = /\.(?:cmd|bat)$/i.test(target) ? words.slice(1).map((word) => cmdWords(word).join(' ')) : words.slice(1);
  return [target, ...windowsArgv(`x ${rest.join(' ')}`).slice(1)];
}

/** Is `command` the command line of a serve on `port` (`… serve … --port <port>`), its arguments read as the platform reads them? */
export function servesOnPort(command, port, platform = process.platform) {
  if (!isPort(Number(port))) return false;
  const args = commandArgs(command, platform);
  if (!args.includes('serve')) return false;
  const p = String(Number(port));
  return args.some((arg, i) => arg === `--port=${p}` || (arg === '--port' && args[i + 1] === p));
}

const wholeScope = (s) => !!s && typeof s === 'object' && !!str(s.machine) && !!str(s.uid) && !!str(s.boot);
const sameScope = (a, b) => wholeScope(a) && wholeScope(b) && a.machine === b.machine && a.uid === b.uid && a.boot === b.boot;

/**
 * A record that proves which process it names: its identity whole, its port, the token of its spawn, where it was
 * written (machine, user, boot), and a command line that serves on its port.
 */
export function wholeRecord(record, platform = process.platform) {
  if (!record || typeof record !== 'object') return false;
  if (!SERVE_KINDS.includes(record.kind) || !isPid(record.pid) || !isPort(record.port)) return false;
  if (!str(record.startedAt) || !str(record.command) || !TOKEN.test(str(record.token)) || !wholeScope(record.scope)) return false;
  return servesOnPort(record.command, record.port, platform);
}

/** An owner that can be told apart from any other process: its pid, start time and command line. */
const wholeOwner = (owner) => !!owner && isPid(owner.pid) && !!str(owner.startedAt) && !!str(owner.command);

/**
 * @param {object} o
 * @param {string} o.dir the folder of the records (DATA_HOME/runtime/opencode-serves)
 * @param {() => object | null} [o.self] the identity of the running SynaBun server (read once, when first needed)
 * @param {() => object} [o.scope] `{ machine, uid, boot }` here (lib/process-identity.js readHostScope)
 * @param {() => Promise<object>} [o.scopeAsync] the same, without holding the event loop
 * @param {(pid: number) => object | null} [o.readIdentity] read right before a signal (lib/process-identity.js)
 * @param {(pid: number) => Promise<object | null>} [o.readIdentityAsync] every other read
 * @param {(pid: number, token: string, command: string) => boolean | null} [o.readToken] is the token in its environment?
 * @param {(pid: number, token: string, command: string) => Promise<boolean | null>} [o.readTokenAsync]
 * @param {(port: number) => Promise<number[] | null>} [o.listeners] who listens on a port (null: cannot be told)
 * @param {(pid: number) => Promise<{ pid: number, ppid: number, startedAt: string } | null>} [o.parentOf]
 * @param {(pid: number) => boolean | null} [o.exists] does a process run under the pid (null: cannot be told)
 * @param {(pid: number, signal: string) => void} [o.kill] the signal itself (Windows: taskkill /T /F, any signal)
 * @param {number} [o.selfPid] process.pid
 */
export function createServeRecords({
  dir,
  selfPid = process.pid,
  self = () => readProcessIdentity(selfPid),
  scope = null,
  scopeAsync = null,
  readIdentity = readProcessIdentity,
  readIdentityAsync = readProcessIdentityAsync,
  readToken = (pid, token, command) => readEnvironmentHas(pid, SERVE_TOKEN_ENV, token, { command }),
  readTokenAsync = (pid, token, command) => readEnvironmentHasAsync(pid, SERVE_TOKEN_ENV, token, { command }),
  listeners = (port) => listPortListenersAsync(port),
  parentOf = (pid) => readProcessParentAsync(pid),
  exists = pidExists,
  platform = process.platform,
  kill = null,
  newToken = newServeToken,
  now = () => Date.now(),
  sleep = (ms) => new Promise((done) => { const t = setTimeout(done, ms); t.unref?.(); }),
  stopWaitMs = 6000,
  killWaitMs = 3000,
  pollMs = 100,
  log = () => {},
} = {}) {
  if (!dir) throw new Error('createServeRecords requires dir');
  const readScope = scope || (() => readHostScope());
  const readScopeAsync = scopeAsync || (scope ? async () => scope() : () => readHostScopeAsync());
  const signal = kill || ((pid, sig) => {
    if (platform === 'win32') {
      // The serve and what it started: Windows has no signals to send.
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      return;
    }
    process.kill(pid, sig);
  });

  // Where this server runs: read once it is first needed, and again (at most once a minute) while the OS could not
  // tell all three. Until then nothing is recorded and nothing is stopped.
  let here = null;
  let hereTriedAt = -Infinity;
  const wholeOrNull = (s) => (wholeScope(s) ? { machine: s.machine, uid: s.uid, boot: s.boot } : null);
  const asScope = (s) => wholeOrNull(s && { machine: s.machine == null ? '' : String(s.machine), uid: s.uid == null ? '' : String(s.uid), boot: s.boot == null ? '' : String(s.boot) });
  function scopeNow() {
    if (!here && now() - hereTriedAt >= 60_000) {
      hereTriedAt = now();
      try { here = asScope(readScope()); } catch { here = null; }
    }
    return here;
  }
  async function scopeLater() {
    if (!here && now() - hereTriedAt >= 60_000) {
      hereTriedAt = now();
      try { here = asScope(await readScopeAsync()); } catch { here = null; }
    }
    return here;
  }

  // The running server's own identity: read once it is first needed, and again (at most once a minute) while the OS
  // could not be asked. Until then the owner is its pid alone, which a later run never takes for proof.
  let selfIdentity = null;
  let selfTriedAt = -Infinity;
  function owner() {
    if (!selfIdentity && now() - selfTriedAt >= 60_000) {
      selfTriedAt = now();
      try { selfIdentity = self() || null; } catch { selfIdentity = null; }
    }
    return selfIdentity && selfIdentity.pid === selfPid ? selfIdentity : { pid: selfPid };
  }
  // The tokens of the records this server wrote: those serves are its own.
  const issued = new Set();
  /** Is this record the running server's own: one it wrote, or one whose owner is this very process, here? */
  function ownedHere(record) {
    if (!record || typeof record !== 'object') return false;
    if (str(record.token) && issued.has(record.token)) return true;
    const o = record.owner;
    const me = owner();
    return wholeOwner(o) && wholeOwner(me) && o.pid === selfPid && sameProcess(o, me) && sameScope(record.scope, scopeNow());
  }

  const fileOf = (pid) => join(dir, `${pid}.json`);
  function readFile(name) {
    try { return JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { return null; }
  }
  function unlink(name) {
    try { unlinkSync(join(dir, name)); return true; } catch { return false; }
  }
  /** Every record on file, with its file name; `record` null for a file that is not a record. */
  function entries() {
    let names = [];
    try { names = readdirSync(dir); } catch { return []; }
    return names.filter((name) => RECORD_FILE.test(name)).map((name) => ({ name, record: readFile(name) }));
  }

  // ── Is it still that process? ──

  // The record against where this server runs: 'here', 'gone' (an earlier boot of this machine, for this user:
  // every process of it has ended) or 'unknown' (another machine's or user's, or where cannot be told).
  function whereVerdict(record) {
    const at = scopeNow();
    const there = record?.scope;
    if (!at || !wholeScope(there)) return 'unknown';
    if (there.machine !== at.machine || there.uid !== at.uid) return 'unknown';
    return there.boot === at.boot ? 'here' : 'gone';
  }
  // What the OS reports for the pid now, against the record: 'same', 'gone', 'unknown', or 'token' (the token in its
  // environment decides); null when nothing could be read for the pid.
  function identityVerdict(record, current) {
    if (!current) return null;
    if (String(current.startedAt) !== String(record.startedAt)) return 'gone';
    if (platform === 'win32') {
      if (String(current.command) !== String(record.command)) return 'gone';
      return FINE_START.test(String(record.startedAt)) ? 'same' : 'unknown';
    }
    if (current.uid == null || current.uid === '') return 'unknown';
    if (String(current.uid) !== record.scope.uid) return 'gone';
    if (!servesOnPort(current.command, record.port, platform)) return 'gone';
    return 'token';
  }
  const tokenVerdict = (has) => (has === true ? 'same' : has === false ? 'gone' : 'unknown');

  /**
   * Is the record's process still the very one recorded? 'same'; 'gone' (provably not: it has ended, its pid is
   * another process's, or it was of an earlier boot); 'unknown' (it cannot be told: nothing is done on it, and its
   * record stays). Read in full each time, right before a signal included.
   */
  function verifySync(record) {
    if (!wholeRecord(record, platform)) return 'unknown';
    const where = whereVerdict(record);
    if (where !== 'here') return where;
    const current = readIdentity(record.pid);
    const verdict = identityVerdict(record, current);
    if (verdict === null) return exists(record.pid) === false ? 'gone' : 'unknown';
    if (verdict !== 'token') return verdict;
    return tokenVerdict(readToken(record.pid, record.token, current.command));
  }
  /** verifySync without holding the event loop while the OS answers. */
  async function verify(record) {
    if (!wholeRecord(record, platform)) return 'unknown';
    await scopeLater();
    const where = whereVerdict(record);
    if (where !== 'here') return where;
    const current = await readIdentityAsync(record.pid);
    const verdict = identityVerdict(record, current);
    if (verdict === null) return exists(record.pid) === false ? 'gone' : 'unknown';
    if (verdict !== 'token') return verdict;
    return tokenVerdict(await readTokenAsync(record.pid, record.token, current.command));
  }

  // Has the record's owner ended? 'ended' (positively: no process under its pid, or the one there now has another
  // start time or command line), 'running', or 'unknown' (no owner, a bare pid that runs, a read that failed).
  function ownerVerdict(o, current, gone) {
    if (current) return wholeOwner(o) ? (sameProcess(o, current) ? 'running' : 'ended') : 'unknown';
    return gone ? 'ended' : 'unknown';
  }
  function ownerEndedSync(o) {
    if (!o || !isPid(o.pid)) return 'unknown';
    if (exists(o.pid) === false) return 'ended';
    if (!wholeOwner(o)) return 'unknown';
    const current = readIdentity(o.pid);
    return ownerVerdict(o, current, !current && exists(o.pid) === false);
  }
  async function ownerEnded(o) {
    if (!o || !isPid(o.pid)) return 'unknown';
    if (exists(o.pid) === false) return 'ended';
    if (!wholeOwner(o)) return 'unknown';
    const current = await readIdentityAsync(o.pid);
    return ownerVerdict(o, current, !current && exists(o.pid) === false);
  }

  /**
   * May the running server stop this record's process (once verify() says it is still that process)? Only a whole
   * record written here (this machine, user and boot) that is its own, or whose SynaBun has positively ended. Never
   * another live SynaBun's, one whose owner was never recorded or cannot be read, one of another machine or user.
   */
  function claimable(record) {
    if (!wholeRecord(record, platform) || whereVerdict(record) !== 'here') return false;
    return ownedHere(record) || ownerEndedSync(record.owner) === 'ended';
  }

  // ── On record ──

  /**
   * Record a process of a serve SynaBun started: the one it spawned, at once, and the one that answers on the port
   * when the spawned one started it (answering()). Its identity is read now, so that a later run can tell it from
   * whatever gets its pid afterwards. Nothing is recorded that could never be shown to be this start's: a process
   * whose identity cannot be read, whose command line is not a serve on `port`, that is another user's, that does
   * not carry this start's token (macOS, Linux), or whose start time is not to the fraction of a second (Windows);
   * nor while the machine, the user or the boot cannot be told. A live record of another start under the same pid
   * is never written over. Resolves the record or null.
   */
  async function record({ kind, id = null, port, pid, token } = {}) {
    const n = Number(pid);
    if (!SERVE_KINDS.includes(kind) || !isPid(n) || !isPort(Number(port)) || !TOKEN.test(str(token))) return null;
    const at = await scopeLater();
    if (!at) { log(`no record for the ${kind} serve on port ${port}: the machine, the user or the boot could not be read`); return null; }
    const identity = await readIdentityAsync(n);
    if (!identity) { log(`no record for the ${kind} serve on port ${port}: the identity of process ${n} could not be read`); return null; }
    const entry = {
      v: RECORD_VERSION, kind, id: id == null ? null : String(id), port: Number(port),
      pid: n, startedAt: identity.startedAt, command: identity.command, token,
      scope: { ...at }, owner: owner(), recordedAt: new Date(now()).toISOString(),
    };
    if (!wholeRecord(entry, platform)) { log(`no record for the ${kind} serve on port ${port}: process ${n} is not a serve on that port (${identity.command})`); return null; }
    if (platform === 'win32') {
      if (!FINE_START.test(entry.startedAt)) { log(`no record for the ${kind} serve on port ${port}: the start time of process ${n} is not precise enough to tell it apart`); return null; }
    } else {
      if (String(identity.uid ?? '') !== at.uid) { log(`no record for the ${kind} serve on port ${port}: process ${n} is not this user's`); return null; }
      if (await readTokenAsync(n, token, identity.command) !== true) { log(`no record for the ${kind} serve on port ${port}: process ${n} does not carry this start's token`); return null; }
    }
    const onFile = readFile(`${n}.json`);
    if (onFile && str(onFile.token) && onFile.token !== token && !issued.has(onFile.token) && await verify(onFile) === 'same') {
      log(`no record for the ${kind} serve on port ${port}: process ${n} is on record for another start`);
      return null;
    }
    if (!write(entry)) return null;
    issued.add(token);
    return entry;
  }

  function write(entry) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = fileOf(entry.pid);
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(tmp, path);
      return true;
    } catch (error) {
      log(`could not write the record of the ${entry.kind} serve on port ${entry.port}: ${error?.message || error}`);
      return false;
    }
  }

  /** Remove a record: only that very one (its pid and its spawn's token), never another start's under the same pid. */
  function remove(entry) {
    if (!entry || !isPid(Number(entry.pid))) return false;
    const name = `${Number(entry.pid)}.json`;
    const onFile = readFile(name);
    if (!onFile) return false;
    const same = str(entry.token) ? onFile.token === entry.token : sameProcess(onFile, entry);
    return same ? unlink(name) : false;
  }

  /** The whole records on file, the newest first. `kind` / `port` narrow them. */
  function list({ kind = null, port = null } = {}) {
    return entries()
      .map(({ record: r }) => r)
      .filter((r) => wholeRecord(r, platform) && (!kind || r.kind === kind) && (port == null || r.port === Number(port)))
      .sort((a, b) => String(b.recordedAt || '').localeCompare(String(a.recordedAt || '')));
  }

  // Did `ancestor` start `pid` (or a process that did)? true, false, or null (a link could not be read: nothing is
  // proved). A parent never starts after its child: Windows keeps a parent's pid after that parent has ended, and
  // the pid may be another process's by now.
  async function descendsFrom(pid, ancestor) {
    let at = await parentOf(pid);
    for (let depth = 0; at && depth < 8; depth++) {
      const ppid = Number(at.ppid);
      if (!isPid(ppid) || ppid === 1) return false;
      const up = await parentOf(ppid);
      if (!up) return null;
      if (platform === 'win32' && String(up.startedAt) > String(at.startedAt)) return false;
      if (ppid === ancestor) return true;
      at = up;
    }
    return at ? false : null;
  }

  /**
   * Who answers on `port` for a start whose spawned process is `pid`: `{ state: 'ours', pid }` (the spawned process,
   * or one it started, proved through the parent chain: the pid to record), `{ state: 'foreign' }` (another process
   * holds the port, or the spawned one has ended: a start collision) or `{ state: 'unknown' }` (the OS could not say
   * who listens: only the spawned process stays on record).
   * @param {{ port: number, pid: number, exited?: () => boolean }} o
   */
  async function answering({ port, pid, exited = () => false } = {}) {
    const n = Number(pid);
    if (!isPid(n) || exited()) return { state: 'foreign' };
    const pids = await listeners(Number(port));
    if (exited()) return { state: 'foreign' };
    if (!Array.isArray(pids)) return { state: 'unknown' };
    if (!pids.length) return { state: 'foreign' };
    let ours = null;
    for (const listener of pids) {
      if (listener !== n && await descendsFrom(listener, n) !== true) return { state: 'foreign', pids };
      ours = listener === n ? n : (ours ?? listener);
    }
    return { state: 'ours', pid: ours };
  }

  // ── What a crash left running ──

  // The signal, only while the OS still reports the very process recorded: read once more right before. 'signalled',
  // 'gone' (it is provably not that process now) or 'unknown' (the read or the signal failed: nothing is known).
  function signalIfSame(entry, sig) {
    const verdict = verifySync(entry);
    if (verdict !== 'same') return verdict;
    try { signal(entry.pid, sig); return 'signalled'; } catch (error) { return error?.code === 'ESRCH' ? 'gone' : 'unknown'; }
  }

  async function goneWithin(entry, ms) {
    const deadline = now() + ms;
    for (;;) {
      if (await verify(entry) === 'gone') return true;
      if (now() >= deadline) return false;
      await sleep(pollMs);
    }
  }

  // Stop a leftover serve: SIGTERM, then SIGKILL when it stays. 'stopped', 'gone' (it was provably no longer that
  // process when the signal was due), 'unknown' (it could not be read right before the signal: not signalled) or
  // 'survived'.
  async function stopLeftover(entry) {
    const term = signalIfSame(entry, 'SIGTERM');
    if (term !== 'signalled') return term;
    if (await goneWithin(entry, stopWaitMs)) return 'stopped';
    const hard = signalIfSame(entry, 'SIGKILL');
    if (hard === 'gone') return 'stopped';
    if (hard !== 'signalled') return 'survived';
    return (await goneWithin(entry, killWaitMs)) ? 'stopped' : 'survived';
  }

  async function sweepOnce() {
    const result = { stopped: [], dropped: [], kept: [] };
    const files = entries();
    const at = await scopeLater();
    if (!at) {
      if (files.length) log('the machine, the user or the boot could not be read: no leftover serve is looked at now');
      for (const { name } of files) result.kept.push({ pid: Number(RECORD_FILE.exec(name)?.[1]), why: 'scope-unknown' });
      return result;
    }
    for (const { name, record: entry } of files) {
      const pid = Number(RECORD_FILE.exec(name)?.[1]);
      const about = (why) => ({ pid, kind: entry.kind, port: entry.port, why });
      if (!entry || typeof entry !== 'object') { unlink(name); result.dropped.push({ pid, why: 'not-a-record' }); continue; }
      // Another machine's or another user's (a data home copied or shared): not this one's to judge, nor to tidy.
      const there = entry.scope;
      if (wholeScope(there) && there.machine !== at.machine) { result.kept.push(about('other-machine')); continue; }
      if (wholeScope(there) && there.uid !== at.uid) { result.kept.push(about('other-user')); continue; }
      // The running server's own serves: its own stops end them, and their exits remove their records.
      if (ownedHere(entry)) continue;
      // A file that is no whole record proves nothing: it goes, and nothing is signalled.
      if (!wholeRecord(entry, platform) || entry.pid !== pid) { unlink(name); result.dropped.push({ pid, why: 'not-a-record' }); continue; }
      // An earlier boot ended every process it had: the record goes, and nothing is signalled.
      if (there.boot !== at.boot) { remove(entry); result.dropped.push(about('earlier-boot')); continue; }
      const serveNow = await verify(entry);
      // Ended, or its pid is another program's by now: the record goes, and nothing is signalled.
      if (serveNow === 'gone') { remove(entry); result.dropped.push(about('process-gone')); continue; }
      if (serveNow !== 'same') { result.kept.push(about('identity-unknown')); continue; }
      const ownerNow = await ownerEnded(entry.owner);
      if (ownerNow !== 'ended') { result.kept.push(about(ownerNow === 'running' ? 'owner-running' : 'owner-unknown')); continue; }
      // SynaBun's own serve, started by a SynaBun that has ended: nothing uses it any more.
      log(`stopping a ${entry.kind} serve an earlier SynaBun left running on port ${entry.port} (pid ${entry.pid})`);
      const outcome = await stopLeftover(entry);
      if (outcome === 'stopped') { remove(entry); result.stopped.push(about('leftover')); continue; }
      if (outcome === 'gone') { remove(entry); result.dropped.push(about('process-gone')); continue; }
      // Not seen to end, or not readable right before the signal: it stays on record for the next look.
      result.kept.push(about(outcome === 'survived' ? 'survived' : 'identity-unknown'));
    }
    return result;
  }

  let sweeping = null;
  /** Look for the serves an earlier SynaBun left running, and stop them (see above). One look at a time. */
  function sweep() {
    if (!sweeping) {
      sweeping = sweepOnce()
        .catch((error) => { log(`the look for leftover serves failed: ${error?.message || error}`); return { stopped: [], dropped: [], kept: [] }; })
        .finally(() => { sweeping = null; });
    }
    return sweeping;
  }

  return {
    dir, record, remove, list, verify, verifySync, claimable, ownedHere, answering, sweep,
    /** A fresh token for one spawn, to put in its environment as SERVE_TOKEN_ENV. */
    newToken: () => newToken(),
    /** Where this server runs: `{ machine, uid, boot }`, or null while the OS cannot tell all three. */
    scope: scopeNow,
  };
}

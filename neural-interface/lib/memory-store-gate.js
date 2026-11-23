// The memory store while it is being upgraded, as the Neural Interface sees it.
//
// A schema migration of a populated store starts with a verified safety copy: about 30 s of synchronous SQLite work on
// a 2.6 GB database. On this server's one thread that stops HTTP, WebSockets and timers, and every open page says the
// server is offline. Dozens of places call the synchronous getDb(), inside mcp-server too, so no caller can be asked to
// look first. mcp-server asks this gate before every open instead (sqlite.ts setMemoryMigrationHost):
//
//   ready      nothing is pending. The only cost is one read-only look at the store, per open.
//   migrating  a child process (memory-store-migrate.js) copies and migrates, or waits for another process that does.
//              getDb() throws MemoryStoreMigratingError at once: it never waits and never sees a half-done schema.
//   deferred   only optional migrations (indexes) are pending and could not be made. The store is used as it is.
//   failed     a needed migration could not be made (no room, a copy that failed, a stopped migrator). The store stays
//              closed, getDb() says why, and the migration is tried again by itself.
//
// A child process rather than a worker thread: process.exit() waits for a worker that is inside a native VACUUM INTO
// (measured: 12 s of a 15 s copy), so a worker would hold a shutdown for the rest of the copy. A child is killed at
// once; its lock goes with it and the next holder removes the partial copy.
//
// A request that met a refusal is answered 503 with the state by name, even when its handler caught the error and was
// about to answer with an empty list (requestGuard): an empty answer would read as "there are no memories".
import { AsyncLocalStorage } from 'node:async_hooks';
import { fork } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import * as storeApi from '../../mcp-server/dist/services/sqlite.js';
import * as schemaApi from '../../mcp-server/dist/services/memory-schema.js';

export const MEMORY_STORE_MIGRATING = 'MEMORY_STORE_MIGRATING';
/** What a 503 tells a client to wait before it asks again. */
export const MEMORY_STORE_RETRY_AFTER_S = 5;
const RETRY_FIRST_MS = 60_000;
const RETRY_INTERRUPTED_MS = 5_000;
const RETRY_MAX_MS = 15 * 60_000;
const INTERRUPTED = 'MEMORY_MIGRATION_INTERRUPTED';
const MIGRATOR = fileURLToPath(new URL('./memory-store-migrate.js', import.meta.url));

export class MemoryStoreMigratingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryStoreMigratingError';
    this.code = MEMORY_STORE_MIGRATING;
    this.retryable = true;
  }
}

/** True for what getDb() throws because of a migration: the store is as it was, and the operation can be tried again. */
export function isMemoryStoreRefusal(error) {
  const code = String(error?.code || '');
  return code === MEMORY_STORE_MIGRATING || code.startsWith('MEMORY_MIGRATION_');
}

let lastBackgroundNote = '';
let lastBackgroundAt = 0;
/** A background job that met a refusal is skipped, and said at most once a minute per reason. */
export function noteMemoryStoreRefusal(label, error) {
  const line = `${error?.code || 'refused'}: ${error?.message || error}`;
  if (line === lastBackgroundNote && Date.now() - lastBackgroundAt < 60_000) return;
  lastBackgroundNote = line;
  lastBackgroundAt = Date.now();
  console.warn(`[memory store] ${label} skipped: ${line}`);
}

const defaultMessage = ({ since }, now) => `SynaBun's memory database is migrating${since ? ` (${Math.max(1, Math.round((now - since) / 1000))} s so far)` : ''}: `
  + 'a safety copy is being made and the schema upgraded, once, after an update. Nothing is lost. Try again shortly.';

/**
 * @param {{
 *   needsMigration: (dbPath: string) => boolean,  a populated store with a migration pending; may throw (cannot look)
 *   startMigrator: (dbPath: string, on: { progress: (fields: object) => void, done: (outcome: object) => void }) => { kill: () => void },
 *   message?: (current: object, now: number) => string,
 *   log?: (line: string) => void,
 *   now?: () => number,
 *   retryFirstMs?: number, retryInterruptedMs?: number, retryMaxMs?: number,
 * }} options
 */
export function createMemoryStoreGate({
  needsMigration, startMigrator, message = defaultMessage, log = (line) => console.warn(`[memory store] ${line}`), now = Date.now,
  retryFirstMs = RETRY_FIRST_MS, retryInterruptedMs = RETRY_INTERRUPTED_MS, retryMaxMs = RETRY_MAX_MS,
}) {
  const requests = new AsyncLocalStorage();
  const listeners = new Set();
  let current = { state: 'ready' };
  let run = null;
  let retryTimer = null;
  let failures = 0;
  let stopped = false;
  let waiters = [];

  function enter(next) {
    const before = current.state;
    current = next;
    if (next.state !== 'migrating') for (const wake of waiters.splice(0)) wake();
    if (before === next.state) return;
    for (const listener of [...listeners]) {
      try { listener(next.state); } catch (error) { log(`a listener failed: ${error?.message || error}`); }
    }
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function conclude(dbPath, outcome) {
    if (outcome?.ok) {
      failures = 0;
      if (outcome.deferred) {
        log(`upgrade put off: ${outcome.deferred.reason}`);
        enter({ state: 'deferred', path: dbPath, note: outcome.deferred.reason });
      } else enter({ state: 'ready' });
      return;
    }
    failures++;
    const code = outcome?.error?.code || INTERRUPTED;
    const note = outcome?.error?.message || 'The memory database upgrade stopped before it finished. The database is as it was.';
    const first = code === INTERRUPTED ? retryInterruptedMs : retryFirstMs;
    const delay = Math.min(first * 2 ** (failures - 1), retryMaxMs);
    log(`upgrade not done (${code}): ${note} Trying again in ${Math.round(delay / 1000)} s.`);
    enter({ state: 'failed', path: dbPath, code, note, retryAt: now() + delay });
    clearRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (stopped || current.state !== 'failed') return;
      let needed = false;
      try { needed = needsMigration(dbPath); } catch { needed = false; }
      if (needed) begin(dbPath);
      else enter({ state: 'ready' });
    }, delay);
    retryTimer.unref?.();
  }

  function begin(dbPath) {
    clearRetry();
    enter({ state: 'migrating', path: dbPath, since: now() });
    let finished = false;
    const done = (outcome) => {
      if (finished) return;
      finished = true;
      run = null;
      if (!stopped) conclude(dbPath, outcome);
    };
    try {
      const started = startMigrator(dbPath, {
        progress(fields) { if (!finished && current.state === 'migrating') current = { ...current, ...fields }; },
        done,
      });
      if (!finished) run = started;
    } catch (error) {
      done({ ok: false, error: { code: 'MEMORY_MIGRATION_COPY_FAILED', message: `The memory database upgrade could not be started: ${error?.message || error}. Nothing was changed.` } });
    }
  }

  function refusal() {
    const error = current.state === 'failed'
      ? Object.assign(new Error(current.note), { code: current.code, retryable: true })
      : new MemoryStoreMigratingError(message(current, now()));
    const seen = requests.getStore();
    if (seen) seen.refused = error;
    return error;
  }

  /** Asked by getDb() before it opens the store. Throws when this thread must not open it now. */
  function beforeOpen(dbPath) {
    if (dbPath === ':memory:' || stopped) return;
    // Another database (a move, a restore elsewhere): what was known of the last one says nothing about this one.
    if (current.state !== 'migrating' && current.path && current.path !== dbPath) {
      clearRetry();
      failures = 0;
      enter({ state: 'ready' });
    }
    if (current.state === 'migrating' || current.state === 'failed') throw refusal();
    if (current.state === 'deferred') return;
    let needed;
    // A store that cannot be looked at is opened the ordinary way, which says what is wrong and never copies here.
    try { needed = needsMigration(dbPath); } catch { return; }
    if (!needed) return;
    begin(dbPath);
    if (current.state === 'migrating' || current.state === 'failed') throw refusal();
  }

  function status() {
    const { state, since, holder, note, code, retryAt } = current;
    return {
      state,
      ...(since ? { since, seconds: Math.max(0, Math.round((now() - since) / 1000)) } : {}),
      ...(holder ? { holder } : {}),
      ...(note ? { note } : {}),
      ...(code ? { code } : {}),
      ...(retryAt ? { retryAt } : {}),
      ...(state === 'migrating' || state === 'failed' ? { retryable: true, retryAfter: MEMORY_STORE_RETRY_AFTER_S } : {}),
    };
  }

  /** True once no migration is under way; false when `timeoutMs` passed first. Never rejects. */
  function settled(timeoutMs = Infinity) {
    if (current.state !== 'migrating') return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer = null;
      const wake = () => { if (timer) clearTimeout(timer); resolve(true); };
      waiters.push(wake);
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => { waiters = waiters.filter((other) => other !== wake); resolve(false); }, Math.max(0, timeoutMs));
        timer.unref?.();
      }
    });
  }

  /** For work about to run on another thread: waits out a migration, and throws when the store stays closed. */
  async function forJobs() {
    await settled();
    if (current.state === 'failed') throw refusal();
  }

  /** Express middleware, in front of the routes. Costs one comparison unless the store is closed. */
  function requestGuard(req, res, next) {
    if (current.state === 'ready' || current.state === 'deferred') return next();
    if (!req.path.startsWith('/api/') || req.path === '/api/health') return next();
    const seen = { refused: null };
    const send = res.send;
    res.send = function guardedSend(body) {
      res.send = send;
      if (!seen.refused || res.headersSent) return send.call(this, body);
      const error = seen.refused;
      res.status(503).set('Retry-After', String(MEMORY_STORE_RETRY_AFTER_S));
      return res.json({
        error: error.message, code: error.code, migrating: error.code === MEMORY_STORE_MIGRATING,
        retryable: true, retryAfter: MEMORY_STORE_RETRY_AFTER_S, store: status(),
      });
    };
    return requests.run(seen, next);
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** The process is ending: the migrator goes with it, at once. */
  function stop() {
    if (stopped) return;
    stopped = true;
    clearRetry();
    const running = run;
    run = null;
    try { running?.kill(); } catch { /* already gone */ }
    for (const wake of waiters.splice(0)) wake();
  }

  return {
    active: true,
    beforeOpen, status, settled, forJobs, requestGuard, subscribe, stop,
    /** The store can be opened: its timers and caches may run. */
    open: () => current.state === 'ready' || current.state === 'deferred',
    /** What /api/health adds: null in the normal case, so its answer does not change. */
    reported: () => (current.state === 'ready' ? null : status()),
  };
}

/** A populated store with a migration pending. Reads only; a short wait, because it runs on the server's thread. */
export function storeNeedsMigration(dbPath, schema = schemaApi) {
  if (!existsSync(dbPath) || !statSync(dbPath).size) return false;
  const probe = new DatabaseSync(dbPath, { readOnly: true });
  try {
    probe.exec('PRAGMA busy_timeout = 250');
    return schema.pendingMemoryMigrations(probe).length > 0 && schema.memoryStorePopulated(probe);
  } finally { probe.close(); }
}

/** The migrator as a child process. Its log lines go to the server's log; it ends itself if the server disappears. */
export function forkMigrator(dbPath, { progress, done }, file = MIGRATOR) {
  const env = { ...process.env, SQLITE_DB_PATH: dbPath };
  delete env.SYNABUN_MIGRATION_WORKER;
  if (env.NODE_OPTIONS) env.NODE_OPTIONS = env.NODE_OPTIONS.split(/\s+/).filter((option) => option && !option.startsWith('--inspect')).join(' ');
  const child = fork(file, [], {
    env,
    execArgv: process.execArgv.filter((arg) => arg === '--experimental-sqlite'),
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  let outcome = null;
  child.on('message', (message) => {
    if (message?.type === 'waiting') progress({ holder: 'another-process' });
    else if (message?.type === 'upgrading') progress({ holder: 'this-server' });
    else if (message?.type === 'done') outcome = message.outcome;
  });
  child.once('error', (error) => done({ ok: false, error: { code: 'MEMORY_MIGRATION_COPY_FAILED', message: `The memory database upgrade could not be started: ${error.message}. Nothing was changed.` } }));
  // 'close', not 'exit': a message the child sent last is delivered before it.
  child.once('close', (code, signal) => done(outcome ?? { ok: false, error: {
    code: INTERRUPTED,
    message: `The memory database upgrade stopped before it finished (${signal || `exit ${code}`}). The database is as it was.`,
  } }));
  child.unref();
  child.channel?.unref();
  return { kill() { child.kill('SIGKILL'); } };
}

/**
 * The gate of this process, told to mcp-server. With a dist from before the host hook it never refuses anything, and
 * the server behaves as it did: `npm run mcp:build` and a restart are what turn it on.
 */
export function installMemoryStoreGate({ store = storeApi, schema = schemaApi, startMigrator = forkMigrator } = {}) {
  const supported = typeof store.setMemoryMigrationHost === 'function' && typeof schema.pendingMemoryMigrations === 'function';
  const gate = createMemoryStoreGate({
    needsMigration: supported ? (dbPath) => storeNeedsMigration(dbPath, schema) : () => false,
    startMigrator,
    message: supported && typeof store.memoryMigratingMessage === 'function' ? () => store.memoryMigratingMessage() : defaultMessage,
  });
  if (!supported) return { ...gate, active: false };
  store.setMemoryMigrationHost({ beforeOpen: gate.beforeOpen, status: gate.status, settled: gate.settled });
  process.once('exit', gate.stop);
  return gate;
}

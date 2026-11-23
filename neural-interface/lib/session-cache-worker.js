// Serialize cache passes and capture batches. SQLite handles and transcript bodies stay
// in the worker. A burst reuses the module imports, but each job closes its connections
// before replying so an idle worker cannot pin a restored or relocated database.
import { Worker, parentPort, workerData } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beginActivity } from './loop-stall.js';
import { createLimiter } from './launch-cache.js';
import { getDb, getDbPath } from '../../mcp-server/dist/services/sqlite.js';
import { warmChunkSearchLookup } from './session-search-index.js';

const serial = createLimiter(1);
let current = null;
let idleTimer;

// The server's memory store gate (memory-store-gate.js): a job waits out a migration before it takes its turn, because
// its worker opens the store on its own and would meet the migration there. Null while the store is open: the job then
// takes its place in the queue in this very call, which is what a file replacement's drain relies on.
let storeGate = null;
export function setSessionJobStoreGate(gate) { storeGate = gate; }

export function runSessionJob(task, options = {}) {
  const waited = storeGate?.();
  return waited ? waited.then(() => queueSessionJob(task, options)) : queueSessionJob(task, options);
}

function queueSessionJob(task, options) {
  return serial(async () => {
    // Open until the worker replies: the job runs off this thread, but a stall while it is in flight is often this
    // thread waiting for the write lock the job holds.
    const endActivity = beginActivity(`session-cache:${task}`);
    try { return await dispatch(task, options); }
    finally { endActivity(); }
  });
}

async function dispatch(task, options) {
  const dbPath = getDbPath();
  if (dbPath === ':memory:') return await execute(task, options);
  clearTimeout(idleTimer);
  if (current && current.dbPath !== dbPath) {
    await current.worker.terminate();
    current = null;
  }
  if (!current) {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { sessionCache: true },
      env: { ...process.env, SQLITE_DB_PATH: dbPath },
      execArgv: process.execArgv.filter(arg => arg === '--experimental-sqlite'),
    });
    current = { worker, dbPath };
    worker.once('exit', () => { if (current?.worker === worker) current = null; });
  }
  const { worker } = current;
  worker.ref();
  try {
    return await new Promise((resolve, reject) => {
      const cleanup = () => {
        worker.off('error', fail);
        worker.off('exit', exit);
        worker.off('message', reply);
      };
      const fail = error => { cleanup(); reject(error); };
      const exit = code => fail(new Error(`Session cache worker exited before replying (${code})`));
      const reply = message => {
        cleanup();
        if (message.error) reject(new Error(message.error));
        else resolve(message.result);
      };
      worker.once('error', fail);
      worker.once('exit', exit);
      worker.once('message', reply);
      try { worker.postMessage({ task, options }); } catch (error) { fail(error); }
    });
  } finally {
    worker.unref();
    idleTimer = setTimeout(() => {
      if (current?.worker === worker) {
        current = null;
        void worker.terminate();
      }
    }, 10_000);
    idleTimer.unref();
  }
}

// These administrative JSON handlers replace or remove a database file. Wait
// for the indexer's handle to close; jobs queued afterwards resolve the new
// database path. A dropped client does not mean the file operation has ended.
export function drainSessionJobs(req, res, next) {
  serial(() => new Promise(done => {
    if (res.destroyed) { done(); return; }
    const end = res.end;
    res.end = function (...args) {
      try { return end.apply(this, args); }
      finally { res.end = end; done(); }
    };
    next();
  })).catch(next);
}

async function execute(task, options) {
  const cache = await import('./session-cache-builder.js');
  switch (task) {
    case 'claude': return cache.rebuildClaudeCache(options);
    case 'codex': return cache.rebuildCodexCache(options);
    case 'opencode': {
      if (!existsSync(options.path)) return { sessions: 0, updated: 0 };
      const source = new DatabaseSync(options.path, { readOnly: true });
      try {
        source.exec('PRAGMA busy_timeout = 1000');
        return await cache.rebuildOpencodeCache({ getOpencodeDb: () => source, background: true });
      } finally {
        source.close();
      }
    }
    case 'antigravity': {
      const { antigravityStores } = await import('./antigravity/transcripts.js');
      return cache.rebuildAntigravityCache({ stores: antigravityStores({ homesRoot: options.homesRoot }), only: options.only });
    }
    case 'capture': {
      const { capturePendingFile } = await import('./memory-session-capture.js');
      return capturePendingFile(options.target, {
        reportProgress: options.reportProgress,
        warmLookup: workerData?.sessionCache ? warmChunkSearchLookup : undefined,
      });
    }
    case 'queue-capture': {
      const { queueMemoryCapture } = await import('./memory-session-capture.js');
      return queueMemoryCapture(options);
    }
    case 'capture-chunks':
      return getDb().prepare('SELECT chunk_id FROM memory_session_sources WHERE host=? AND session_id=?')
        .all(options.host, options.sessionId).map(row => row.chunk_id);
    default: throw new Error(`Unknown session cache job: ${task}`);
  }
}

if (workerData?.sessionCache && parentPort) {
  // Only the server's migrator makes the safety copy: this thread opens the store as it is, or is told it cannot.
  const { setMemoryMigrationHost } = await import('../../mcp-server/dist/services/sqlite.js');
  setMemoryMigrationHost?.({ beforeOpen() {}, status: () => ({ state: 'ready' }), settled: async () => true });
  const { getDb, closeDb } = await import('./db.js');
  parentPort.on('message', async ({ task, options }) => {
    let reply;
    try {
      const db = getDb();
      if (task === 'opencode') await warmChunkSearchLookup(db);
      reply = { result: await execute(task, options) };
    } catch (error) {
      reply = { error: error.message };
    } finally {
      closeDb();
    }
    parentPort.postMessage(reply);
  });
}

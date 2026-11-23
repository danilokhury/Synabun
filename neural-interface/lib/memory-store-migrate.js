// The child process that upgrades the memory store for the Neural Interface (memory-store-gate.js forkMigrator).
//
// It waits for another process that holds the migration lock, then runs the one migration path there is:
// ensureDatabase() in mcp-server, with its cross-process lock, verified safety copy and leftovers sweep. The copy runs
// on that function's worker, so this thread stays free to hear that the server is gone: it then ends at once, the
// operating system lets go of the lock, and the next holder removes the partial copy.
import { DatabaseSync } from 'node:sqlite';
import { closeDatabase, ensureDatabase, getDbPath, memoryStoreStatus } from '../../mcp-server/dist/services/sqlite.js';
import { pendingMemoryMigrations } from '../../mcp-server/dist/services/memory-schema.js';
import { LOCK_WAIT_MS, tryMigrationLock } from '../../mcp-server/dist/services/memory-migration-copy.js';

const POLL_MS = 500;
let finished = false;

process.on('disconnect', () => { if (!finished) process.kill(process.pid, 'SIGKILL'); });

const send = (message) => new Promise((resolve) => {
  if (!process.connected) { resolve(); return; }
  process.send(message, () => resolve());
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pendingNow(dbPath) {
  const look = new DatabaseSync(dbPath, { readOnly: true });
  try {
    look.exec('PRAGMA busy_timeout = 1000');
    return pendingMemoryMigrations(look);
  } finally { look.close(); }
}

/**
 * Out of the way of another process's copy. An optional migration would otherwise be put off the moment the lock is
 * seen taken, and the server would write to the store while that process holds it.
 */
async function waitForOtherHolder(dbPath) {
  const started = Date.now();
  let told = false;
  while (pendingNow(dbPath).length) {
    const lock = tryMigrationLock(dbPath);
    if (lock) { lock.release(); return; }
    if (!told) { told = true; await send({ type: 'waiting' }); }
    if (Date.now() - started >= LOCK_WAIT_MS) {
      throw Object.assign(new Error(`The memory database was not upgraded: another SynaBun process has been upgrading it for more than ${Math.round(LOCK_WAIT_MS / 1000)} s. Nothing was changed.`), { code: 'MEMORY_MIGRATION_BUSY' });
    }
    await sleep(POLL_MS);
  }
}

let outcome;
try {
  const dbPath = getDbPath();
  await waitForOtherHolder(dbPath);
  await send({ type: 'upgrading' });
  await ensureDatabase();
  const left = pendingNow(dbPath);
  outcome = left.length
    ? { ok: true, deferred: { versions: left, reason: memoryStoreStatus().note || `Migration(s) ${left.join(', ')} were put off.` } }
    : { ok: true };
} catch (error) {
  outcome = { ok: false, error: { code: error?.code, message: error?.message || String(error) } };
}
try { closeDatabase(); } catch { /* it ends with this process */ }
await send({ type: 'done', outcome });
finished = true;
process.exit(0);

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

process.env.SYNABUN_TYPESAFE = 'off';

// Never the live store: point every memory path at a temp dir BEFORE any
// mcp-server module is imported.
const dir = mkdtempSync(join(tmpdir(), 'synabun-timers-'));
process.env.SQLITE_DB_PATH = join(dir, 'memory.db');
process.env.MEMORY_DATA_DIR = dir;
process.env.SYNABUN_DATA_HOME = dir;

const storage = await import('../../mcp-server/dist/services/sqlite.js');
const { maintenancePaused, maintenanceHasWork, startGatedMemoryMaintenance, stopGatedMemoryMaintenance } = await import('../lib/memory-timers.js');
const { pauseMaintenance } = await import('../../mcp-server/dist/services/memory-maintenance.js');

test.after(() => {
  stopGatedMemoryMaintenance();
  try { storage.closeDatabase(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('gates read the paused flag and mirror the maintenance claim query', () => {
  const d = storage.getDb();
  assert.ok(storage.getDbPath().startsWith(dir), 'test must run against the temp DB');
  d.exec('DELETE FROM memory_jobs');

  assert.equal(maintenancePaused(d), false);
  pauseMaintenance(true);
  assert.equal(maintenancePaused(d), true);
  pauseMaintenance(false);
  assert.equal(maintenancePaused(d), false);

  assert.equal(maintenanceHasWork(d), false, 'no jobs → no work');
  const now = new Date().toISOString();
  const ins = d.prepare("INSERT INTO memory_jobs(id,kind,entity_id,status,attempts,updated_at) VALUES(?,?,?,?,?,?)");
  ins.run('j1', 'judge', 'm1', 'pending', 0, now);
  assert.equal(maintenanceHasWork(d), false, 'judge jobs belong to the backfill runner');
  ins.run('j2', 'index', 'm2', 'pending', 3, now);
  assert.equal(maintenanceHasWork(d), false, 'jobs past the retry limit are not claimable');
  ins.run('j3', 'index', 'm3', 'running', 1, now);
  assert.equal(maintenanceHasWork(d), false, 'a fresh running claim is not work');
  d.prepare("UPDATE memory_jobs SET updated_at=? WHERE id='j3'").run(new Date(Date.now() - 400_000).toISOString());
  assert.equal(maintenanceHasWork(d), true, 'a stale running claim is reset by the batch');
  d.exec("DELETE FROM memory_jobs WHERE id='j3'");
  ins.run('j4', 'index', 'm4', 'pending', 0, now);
  assert.equal(maintenanceHasWork(d), true);
  d.exec('DELETE FROM memory_jobs');
});

test('idle ticks never run the batch, never take the write lock, and stay fast while another process holds it', async () => {
  const d = storage.getDb();
  d.exec('DELETE FROM memory_jobs');
  let batches = 0;
  startGatedMemoryMaintenance({ intervalMs: 20, runBatch: async () => { batches++; } });

  // Another connection holds the write lock the old batch would have waited on.
  const other = new DatabaseSync(storage.getDbPath());
  other.exec('PRAGMA busy_timeout=5000');
  other.exec('BEGIN IMMEDIATE');
  try {
    const t0 = performance.now();
    await sleep(150);
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 400, `idle ticks must not block on the lock (${elapsed.toFixed(0)} ms)`);
    assert.equal(batches, 0, 'nothing to do → the batch never runs');
  } finally {
    other.exec('ROLLBACK');
    other.close();
  }

  d.prepare("INSERT INTO memory_jobs(id,kind,entity_id,status,attempts,updated_at) VALUES('w1','index','m1','pending',0,?)").run(new Date().toISOString());
  await sleep(120);
  assert.ok(batches >= 1, 'claimable work runs the batch');
  pauseMaintenance(true);
  const before = batches;
  await sleep(120);
  assert.equal(batches, before, 'paused → no batches');
  pauseMaintenance(false);
  stopGatedMemoryMaintenance();
  d.exec('DELETE FROM memory_jobs');
});

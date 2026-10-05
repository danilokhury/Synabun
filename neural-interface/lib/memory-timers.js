// Cheap gates for the background memory timers that share the Neural
// Interface event loop with terminal I/O.
//
// maintenanceStatus() (mcp-server) runs ~9 queries — GROUP BYs over every
// memory_jobs row, relation lists, retrieval and TypeSafe stats — and the 2 s
// maintenance and capture timers each called it just to read the paused flag,
// stalling the loop ~30-40 ms twice every 2 s. runMaintenanceBatch() also
// opened a BEGIN IMMEDIATE transaction on every tick, which waits synchronously
// (busy_timeout) whenever another process holds the write lock.
//
// These gates read one kv row and probe idx_memory_jobs_status_kind, so an idle
// tick costs microseconds and never takes the write lock. The probes mirror
// runMaintenanceBatch's own claim query: pending non-judge jobs under the retry
// limit, or a `running` claim older than 5 minutes (which the batch resets).

import { getDb } from '../../mcp-server/dist/services/sqlite.js';
import { runMaintenanceBatch } from '../../mcp-server/dist/services/memory-maintenance.js';

const STALE_RUNNING_MS = 300_000;

export function maintenancePaused(d = getDb()) {
  const row = d.prepare("SELECT value FROM kv_config WHERE key='memory_maintenance_paused'").get();
  return row?.value === 'true';
}

export function maintenanceHasWork(d = getDb(), now = Date.now()) {
  if (d.prepare("SELECT 1 FROM memory_jobs WHERE status='pending' AND kind!='judge' AND attempts<3 LIMIT 1").get()) return true;
  const staleBefore = new Date(now - STALE_RUNNING_MS).toISOString();
  return !!d.prepare("SELECT 1 FROM memory_jobs WHERE status='running' AND updated_at<? LIMIT 1").get(staleBefore);
}

let maintenanceTimer = null;
let batchInFlight = false;

/**
 * Drop-in replacement for mcp-server's startMemoryMaintenance(): same batch,
 * same cadence, but a tick with nothing to do returns before touching the
 * expensive status queries or the write lock.
 */
export function startGatedMemoryMaintenance({ intervalMs = 2000, runBatch = runMaintenanceBatch } = {}) {
  if (maintenanceTimer) return;
  maintenanceTimer = setInterval(() => {
    if (batchInFlight) return;
    try {
      const d = getDb();
      if (maintenancePaused(d) || !maintenanceHasWork(d)) return;
    } catch {
      return;
    }
    batchInFlight = true;
    Promise.resolve()
      .then(() => runBatch())
      .catch((error) => console.error('[memory maintenance]', error?.message || error))
      .finally(() => { batchInFlight = false; });
  }, intervalMs);
  maintenanceTimer.unref?.();
}

export function stopGatedMemoryMaintenance() {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  maintenanceTimer = null;
}

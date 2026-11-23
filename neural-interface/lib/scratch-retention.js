// Scratch retention, the server's side: when a pass runs and what it may do. The pass itself runs in a worker thread
// (scratch-retention-worker.js), so the walk, the measuring and the deletes never block this thread. Only one compact
// in-memory ownership check per folder runs here, right before that folder is touched.
//
// The first pass on a data home is a preview that deletes nothing. Real deletion starts at the next scheduled pass,
// 24 hours later. That state is saved in DATA_HOME/runtime, so a restart neither skips the preview nor repeats it.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';

const workerFile = new URL('./scratch-retention-worker.js', import.meta.url);
const terminal = new Set(['completed', 'stopped', 'failed', 'interrupted']);
export const PASS_INTERVAL_MS = 24 * 60 * 60_000;
export const STARTUP_DELAY_MS = 5 * 60_000;
const WORKER_HEAP_MB = 2048;

export function releasedByOwners({ dispatcher, runtime, scheduled, closing }, { check: id, task, finished }) {
  if (closing || !dispatcher || !runtime || scheduled.has(id)) return false;
  const native = runtime.get(id);
  const end = Date.parse(native?.completedAt);
  return terminal.has(native?.status) && (!native.turnState || native.turnState === 'terminal')
    && native.runMode === (task ? 'task' : 'loop')
    && Number.isFinite(end) && end <= finished
    && dispatcher.scratchReleased(id, task, finished);
}

/**
 * One pass in a worker thread.
 * @param {object} o
 * @param {string} o.dataHome
 * @param {boolean} [o.dryRun] only report
 * @param {(row: object) => boolean} [o.confirm] the live owners' last word before a delete
 * @param {(row: object) => void} [o.candidate] one row per folder on a dry run
 * @param {boolean} [o.background] do not hold the process open for this pass (the server's own schedule)
 */
export function scratchPass({ dataHome, dryRun = true, confirm = () => false, candidate = () => {}, background = false }) {
  return new Promise((done, fail) => {
    let summary = null;
    let failure = null;
    const worker = new Worker(workerFile, {
      workerData: { dataHome, dryRun }, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
    if (background) worker.unref();
    worker.on('message', (message) => {
      if (message.summary) summary = message.summary;
      else if (message.failed) failure = message.failed;
      else if (message.folder) candidate(message.folder);
      else if (message.confirm) {
        let ok = false;
        try { ok = !dryRun && confirm(message.confirm) === true; } catch { ok = false; }
        worker.postMessage({ id: message.confirm.id, ok });
      }
    });
    worker.once('error', fail);
    worker.once('exit', () => {
      if (summary) done(summary);
      else fail(new Error(failure || 'scratch worker unavailable'));
    });
  });
}

const megabytes = (bytes) => (bytes / 1e6).toFixed(2);
const folders = (count) => `${count} folder${count === 1 ? '' : 's'}`;

/** The one-line summary of a pass. */
export function scratchSummary(row) {
  const kept = Object.entries(row.kept || {});
  const count = kept.reduce((sum, [, n]) => sum + n, 0);
  const reasons = kept.map(([reason, n]) => `${reason}=${n}`).join(', ') || 'none';
  const tail = `kept ${count} (${reasons})${row.passReason ? `, ${row.passReason}` : ''}`;
  return row.dryRun
    ? `[scratch-retention] preview, nothing deleted: would remove ${folders(row.wouldRemove || 0)}, prune ${row.wouldPrune || 0}, free ${megabytes(row.wouldFreeBytes || 0)} MB, ${tail}`
    : `[scratch-retention] removed ${folders(row.removed || 0)}, pruned ${row.pruned || 0}, freed ${megabytes(row.freedBytes || 0)} MB, ${tail}`;
}

/** Why folders stay, largest first, one line per reason (the dry-run CLI). */
export function scratchKeptReport(row) {
  return Object.entries(row.kept || {})
    .map(([reason, count]) => ({ reason, count, bytes: row.keptBytes?.[reason] || 0 }))
    .sort((a, b) => b.bytes - a.bytes || a.reason.localeCompare(b.reason))
    .map(({ reason, count, bytes }) => `  ${reason}: ${folders(count)}, ${megabytes(bytes)} MB`);
}

// ── What the schedule remembers ─────────────────────────────────────────────

export const retentionStatePath = (dataHome) => join(dataHome, 'runtime', 'scratch-retention-state.json');

/** The saved state for this data home. Anything unreadable or foreign reads as "no preview yet", the safe side. */
export function readRetentionState(dataHome, at = Date.now()) {
  try {
    const row = JSON.parse(readFileSync(retentionStatePath(dataHome), 'utf8'));
    if (row?.version !== 1 || row.dataHome !== resolve(dataHome)) return null;
    const time = (value) => (Number.isFinite(value) && value > 0 && value <= at ? value : null);
    return { previewedAt: time(row.previewedAt), lastPassAt: time(row.lastPassAt) };
  } catch { return null; }
}

function writeRetentionState(dataHome, state) {
  const path = retentionStatePath(dataHome);
  const temporary = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, dataHome: resolve(dataHome), ...state })}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* nothing to tidy */ }
    throw error;
  }
}

/** The next pass: a preview until one has finished, then real deletion from 24 hours after it. */
export function nextScratchPass(state, earliest = 0) {
  if (!state?.previewedAt) {
    return { mode: 'preview', at: Math.max(earliest, state?.lastPassAt ? state.lastPassAt + PASS_INTERVAL_MS : 0) };
  }
  return { mode: 'apply', at: Math.max(earliest, state.previewedAt + PASS_INTERVAL_MS, (state.lastPassAt || 0) + PASS_INTERVAL_MS) };
}

export function scheduleScratchRetention(dataHome, owners, { pass = scratchPass, delay = setTimeout, log = console.log, now = Date.now } = {}) {
  let attemptedAt = 0; // holds the cadence in this process when the state file cannot be written

  const arm = (earliest) => {
    const next = nextScratchPass(readRetentionState(dataHome, now()), Math.max(earliest, attemptedAt ? attemptedAt + PASS_INTERVAL_MS : 0));
    delay(run, Math.max(0, next.at - now())).unref?.();
  };

  const run = async () => {
    const state = readRetentionState(dataHome, now());
    const next = nextScratchPass(state, attemptedAt ? attemptedAt + PASS_INTERVAL_MS : 0);
    if (next.at > now()) { arm(0); return; } // a state saved since this timer was set says it is not due yet
    const dryRun = next.mode === 'preview';
    let previewed = false;
    try {
      const row = await pass({ dataHome, dryRun, background: true, confirm: (item) => releasedByOwners(owners(), item) });
      previewed = dryRun && !row.passReason;
      const start = previewed ? `; real deletion starts with the pass after ${new Date(now() + PASS_INTERVAL_MS).toISOString()}` : '';
      log(scratchSummary(row) + start);
    } catch (error) {
      log(`[scratch-retention] pass did not finish, nothing more removed (${error.message})`);
    }
    attemptedAt = now();
    try {
      writeRetentionState(dataHome, { previewedAt: previewed ? attemptedAt : (state?.previewedAt ?? null), lastPassAt: attemptedAt });
    } catch (error) {
      log(`[scratch-retention] could not save the schedule (${error.message}); deletion waits until it can be saved`);
    }
    arm(0);
  };

  arm(now() + STARTUP_DELAY_MS);
}

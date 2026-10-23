// SQLite's PRAGMA integrity_check on each database copy of an upgrade snapshot, off the snapshot's main thread
// (backup-service.js checkSqliteIntegrity): the archive is written and read back meanwhile. workerData: { paths };
// posts [{ path, ok, lines, ms }] once, in the same order. A file that cannot be opened is not ok.
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

const results = [];
for (const path of workerData?.paths || []) {
  const started = Date.now();
  let db = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    // The check `synabun restore-backup` runs (scripts/restore-data-home-from-backup.mjs); 20 findings are plenty to say why.
    const lines = db.prepare('PRAGMA integrity_check(20)').all().map(row => String(Object.values(row)[0]));
    results.push({ path, ok: lines.length === 1 && lines[0] === 'ok', lines: lines.slice(0, 20), ms: Date.now() - started });
  } catch (error) {
    results.push({ path, ok: false, lines: [String(error?.message || error)], ms: Date.now() - started });
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}
parentPort.postMessage(results);

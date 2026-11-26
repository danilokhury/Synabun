import { runSessionJob } from './session-cache-worker.js';
import { captureStartOffset, fileIdentityOf, mtimeIsoOf } from './session-capture-gate.js';
import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { getDb } from '../../mcp-server/dist/services/sqlite.js';
import { detectProject } from '../../mcp-server/dist/config.js';
import { normalizeMemoryEvents, ingestMemoryEvents, CAPTURE_TRANSACTION_MS, CAPTURE_PAUSE_MS } from '../../mcp-server/dist/services/memory-sessions.js';
import { maintenancePaused } from './memory-timers.js';

/** The hosts whose transcripts are captured from a file (OpenCode's rows are taken in session-cache-builder.js). */
export const CAPTURE_HOSTS = Object.freeze(['claude-code', 'codex', 'antigravity']);

const migratedDbs = new WeakSet();
const CAPTURE_EXTRA_COLUMNS = Object.freeze([
  ['file_size', 'INTEGER'],
  ['file_mtime', 'TEXT'],
  ['file_identity', 'TEXT'],
]);

function ensureCaptureMetadataColumns(d) {
  if (migratedDbs.has(d)) return;
  for (const [name, type] of CAPTURE_EXTRA_COLUMNS) {
    const hasColumn = () => d.prepare('PRAGMA table_info(memory_capture_files)').all().some(c => c.name === name);
    if (!hasColumn()) {
      try { d.exec(`ALTER TABLE memory_capture_files ADD COLUMN ${name} ${type}`); }
      catch (err) { if (!hasColumn()) throw err; }
    }
  }
  migratedDbs.add(d);
}

function readStatBestEffort(filePath, providedStat) {
  if (providedStat && providedStat.size != null && (providedStat.dev != null || providedStat.ino != null || providedStat.mtimeNs != null)) {
    return providedStat;
  }
  try {
    return statSync(filePath, { bigint: true });
  } catch {
    return providedStat || null;
  }
}

// Compare the actual checkpoint in SQL on every transition: a scan or worker
// that yielded to another capture cannot overwrite its newer offset or status.
const checkpointWhere = `host = ? AND session_id = ? AND status = ? AND byte_offset = ?
  AND file_path = ? AND cwd IS ? AND file_size IS ? AND file_mtime IS ? AND file_identity IS ?`;
function checkpointKey(row) {
  return [row.host, row.session_id, row.status, row.byte_offset, row.file_path, row.cwd,
    row.file_size, row.file_mtime, row.file_identity];
}

export function queueMemoryCapture({ host, sessionId, filePath, project, cwd, size = null, stat = null,
  fileMtime = null, fileIdentity = null }) {
  if (!filePath || !sessionId || !CAPTURE_HOSTS.includes(host)) return;
  const d = getDb();
  ensureCaptureMetadataColumns(d);
  const read = d.prepare('SELECT * FROM memory_capture_files WHERE host = ? AND session_id = ?');
  const projectName = () => cwd ? detectProject(cwd) : project || 'global';
  // A worker can finish between the read and the update. Re-evaluate that checkpoint.
  for (;;) {
    const row = read.get(host, sessionId);
    const st = readStatBestEffort(filePath, stat);
    const currentSize = st ? Number(st.size) : size;
    const mtime = mtimeIsoOf(st) ?? fileMtime;
    const identity = fileIdentityOf(st) ?? fileIdentity;
    if (!row) {
      const added = d.prepare(`INSERT INTO memory_capture_files
        (host, session_id, file_path, project, cwd, byte_offset, status, file_size, file_mtime, file_identity)
        VALUES (?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?) ON CONFLICT(host, session_id) DO NOTHING`)
        .run(host, sessionId, filePath, projectName(), cwd || null, currentSize, mtime, identity);
      if (added.changes) return;
      stat = null;
      continue;
    }

    const sameCwd = (host !== 'antigravity' && !cwd) || row.cwd === (cwd || null);
    const sameSource = row.file_path === filePath && (host !== 'antigravity' || sameCwd);
    const offset = sameSource ? captureStartOffset(row, currentSize, identity, mtime) : 0;
    const complete = row.status === 'complete' && sameSource && sameCwd && offset === currentSize;
    const status = complete ? 'complete' : 'pending';
    // If the stat failed, preserve the known checkpoint for the worker's next open.
    const nextSize = currentSize ?? (sameSource ? row.file_size : null);
    const nextMtime = mtime ?? (sameSource ? row.file_mtime : null);
    const nextIdentity = identity ?? (sameSource ? row.file_identity : null);
    const nextCwd = sameCwd && sameSource ? row.cwd : cwd || null;
    if (sameSource && sameCwd && status === row.status && offset === row.byte_offset
        && row.file_size === nextSize && row.file_mtime === nextMtime && row.file_identity === nextIdentity
        && (complete || row.project === projectName())) return;

    const changed = d.prepare(`UPDATE memory_capture_files SET file_path = ?, project = ?, cwd = ?,
      status = ?, error = NULL, byte_offset = ?, file_size = ?, file_mtime = ?, file_identity = ?
      WHERE ${checkpointWhere}`).run(filePath, complete ? row.project : projectName(), nextCwd,
        status, offset, nextSize, nextMtime, nextIdentity, ...checkpointKey(row));
    if (changed.changes) return;
    stat = null; // Resample if a worker committed a newer checkpoint.
  }
}

let running = false;
let timer = null;
export async function captureMemoryFileBatch(target, { reportProgress = false } = {}) {
  if (running) return { busy: true };
  running = true;
  try {
    return await runSessionJob('capture', { target, reportProgress });
  } finally {
    running = false;
  }
}

export async function capturePendingFile(target, { reportProgress, warmLookup } = {}) {
  const d = getDb();
  ensureCaptureMetadataColumns(d);
  if (maintenancePaused(d)) return { paused: true };
  const select = target
    ? d.prepare('SELECT * FROM memory_capture_files WHERE host=? AND session_id=?')
    : d.prepare("SELECT * FROM memory_capture_files WHERE status='pending' ORDER BY byte_offset LIMIT 1");
  const keys = target ? [target.host, target.sessionId] : [];
  let job = select.get(...keys);
  if (job?.status === 'pending' && warmLookup) {
    // Backfill can yield to a pause or a newer checkpoint. Pick again before reading the file.
    await warmLookup(d);
    if (maintenancePaused(d)) return { paused: true };
    job = select.get(...keys);
  }
  if (job?.status === 'pending') await readCaptureFile(d, job);
  if (target && reportProgress) {
    const after = select.get(...keys);
    return { status: after?.status, error: after?.error, advanced: after?.byte_offset !== job?.byte_offset };
  }
}

async function readCaptureFile(d, job) {
  let file;
  try {
    file = await open(job.file_path, 'r');
    const stat = await file.stat({ bigint: true });
    const fileSize = Number(stat.size);
    const identity = fileIdentityOf(stat);
    const mtime = mtimeIsoOf(stat);
    const offset = captureStartOffset(job, fileSize, identity, mtime);
    const saveCheckpoint = (end) => d.prepare(`
      UPDATE memory_capture_files SET byte_offset = ?, status = ?, error = NULL,
        file_size = ?, file_mtime = ?, file_identity = ? WHERE ${checkpointWhere}
    `).run(end, end >= fileSize ? 'complete' : 'pending', fileSize, mtime, identity, ...checkpointKey(job));

    // Bounded file reads keep large transcripts off the UI request path.
    let buffer = Buffer.alloc(256 * 1024);
    let { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) {
      saveCheckpoint(offset);
      return;
    }
    while (buffer.subarray(0, bytesRead).lastIndexOf(10) < 0 && bytesRead === buffer.length && buffer.length < 8 * 1024 * 1024) {
      buffer = Buffer.alloc(buffer.length * 2);
      ({ bytesRead } = await file.read(buffer, 0, buffer.length, offset));
    }
    const bytes = buffer.subarray(0, bytesRead);
    const newline = bytes.lastIndexOf(10);
    let consumed = newline + 1;
    if (newline < 0) {
      if (bytesRead === buffer.length) throw new Error('Transcript record exceeds 8 MiB; original source retained.');
      // A valid final JSON record need not end in a newline. Incomplete tails
      // remain pending until the writer finishes them.
      try { JSON.parse(bytes.toString('utf8')); consumed = bytesRead; } catch { return; }
    }
    const records = [];
    let position = offset;
    for (const line of bytes.subarray(0, consumed).toString('utf8').split('\n')) {
      if (line.trim()) {
        try {
          const record = JSON.parse(line);
          records.push({ ...record, id: record.id || record.uuid || `byte:${position}` });
        } catch {}
      }
      position += Buffer.byteLength(line) + 1;
    }
    const sourceCwd = job.cwd || records.find(r => r.cwd)?.cwd || records.find(r => r.type === 'session_meta')?.payload?.cwd;
    const project = sourceCwd ? detectProject(sourceCwd) : job.project;
    const events = normalizeMemoryEvents(job.host, records, { session_id: job.session_id, project, cwd: sourceCwd });
    if (maintenancePaused()) return;
    // Short transactions with the write lock left free between them (memory-sessions.ts CAPTURE_*): the server's
    // own writes wait for this lock on its event loop.
    for (let i = 0; i < events.length;) {
      if (maintenancePaused()) return; // replay from the previous checkpoint on resume
      const batch = ingestMemoryEvents(events.slice(i, i + 25), { maxTransactionMs: CAPTURE_TRANSACTION_MS });
      i += Math.max(1, batch.consumed);
      if (batch.indexed && i < events.length) await new Promise(done => setTimeout(done, CAPTURE_PAUSE_MS));
    }
    // Replaying after a crash between intake and checkpoint is idempotent.
    saveCheckpoint(offset + consumed);
  } catch (error) {
    d.prepare(`UPDATE memory_capture_files SET status='failed', error=? WHERE ${checkpointWhere}`)
      .run(error.message, ...checkpointKey(job));
  } finally {
    await file?.close();
  }
}

let startTimer = null;
// offsetMs keeps this tick out of phase with the 2 s maintenance timer so the
// two never stack on the same event-loop turn.
export function startMemoryCapture({ offsetMs = 1000, intervalMs = 2000 } = {}) {
  if (timer || startTimer) return;
  const tick = () => captureMemoryFileBatch().catch(error => console.error('[memory capture]', error.message));
  startTimer = setTimeout(() => {
    startTimer = null;
    timer = setInterval(tick, intervalMs);
    timer.unref();
  }, offsetMs);
  startTimer.unref();
}
export function stopMemoryCapture() {
  if (startTimer) clearTimeout(startTimer);
  if (timer) clearInterval(timer);
  startTimer = null;
  timer = null;
}

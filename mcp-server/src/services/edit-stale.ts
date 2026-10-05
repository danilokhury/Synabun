/**
 * Edit-time stale check (surface `edit-stale`).
 *
 * When Claude Code edits a file, memories that list that file in
 * `related_files` may stop being true. The PostToolUse hook reports the edit
 * here (fire-and-forget); after a quiet period the burst of edits is judged
 * once: for the few memories most likely affected, does the memory still
 * describe the file as it is now? Verdicts are stored on the memory, shown as a
 * recall flag, and handed back to the session that made the edit at its next
 * prompt or Stop — once.
 *
 * Nothing here runs on a request path: `noteEdit` answers immediately, the
 * judgments run from a bounded queue, and the only SQLite write is a short
 * read-modify-write of one metadata row with no network call inside it.
 */

import { isAbsolute, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getDb } from './sqlite.js';
import { projectRoot } from '../config.js';
import { judgeStaleMemory } from './memory-judgments.js';
import { fileExcerpt, isDeniedFile } from './file-excerpt.js';
import { surfaceConfig, annotateTypeSafeLog, cleanSessionId } from './typesafe-config.js';
import { typesafeEnabled, typesafeRetryAfterMs } from './typesafe.js';
import { readStaleVerdicts, type StaleVerdictRecord } from './memory-verification.js';

export interface EditNotice {
  sessionId: string; cwd?: string | null; project?: string | null; filePath: string;
  tool?: string | null; oldExcerpt?: string | null; newExcerpt?: string | null;
}

export interface StaleVerdict {
  memory_id: string; file: string; probability: number; category: string; importance: number;
  excerpt: string; judged_at: string;
}

interface Burst {
  sessionId: string; cwd: string | null; project: string | null; absPath: string;
  changes: { old: string; new: string }[]; startedAt: string; timer: ReturnType<typeof setTimeout> | null;
}

const bursts = new Map<string, Burst>();
const queue: Burst[] = [];
const inflight = new Map<string, Promise<void>[]>();
const pending = new Map<string, { verdict: StaleVerdict; at: number }[]>();
const judgedThisHour = new Map<string, { hourStart: number; count: number }>();

const MAX_QUEUE = 50;
const CONCURRENCY = 2;
const MAX_PENDING_PER_SESSION = 20;
const PENDING_TTL_MS = 2 * 3600_000;
const MAX_CANDIDATES = 400;
const MAX_VERDICT_FILES = 10;
const EXCERPT_CHARS = 1500;
let running = 0;

const caseFold = process.platform === 'darwin' || process.platform === 'win32';
const norm = (p: string) => { const r = resolve(p).replace(/\\/g, '/'); return caseFold ? r.toLowerCase() : r; };

/** Why an edit was not scheduled, or null when it was. */
function refusal(notice: EditNotice, judgeFlag: unknown): string | null {
  if (judgeFlag === false || !typesafeEnabled()) return 'judgments-off';
  if (!surfaceConfig('edit-stale').enabled) return 'disabled';
  if (!cleanSessionId(notice.sessionId) || typeof notice.filePath !== 'string' || !notice.filePath.trim()) return 'invalid';
  if (!isAbsolute(notice.filePath) && !notice.cwd) return 'invalid';
  if (isDeniedFile(notice.filePath)) return 'denied-file';
  return null;
}

/**
 * Record one edit. Answers at once; the judgment runs after the surface's
 * quiet period (`debounceMs`) with every edit of the same file in the burst.
 */
export function noteEdit(notice: EditNotice, judgeFlag?: unknown): { scheduled: boolean; reason?: string } {
  const reason = refusal(notice, judgeFlag);
  if (reason) return { scheduled: false, reason };
  const absPath = isAbsolute(notice.filePath) ? notice.filePath : resolve(String(notice.cwd), notice.filePath);
  if (!findMemoriesForFile(absPath, { cwd: notice.cwd ?? null, project: notice.project ?? null }).length) return { scheduled: false, reason: 'no-memories' };
  const key = `${notice.sessionId}\0${norm(absPath)}`;
  const burst = bursts.get(key) ?? { sessionId: notice.sessionId, cwd: notice.cwd ?? null, project: notice.project ?? null, absPath, changes: [], startedAt: new Date().toISOString(), timer: null };
  if (notice.oldExcerpt || notice.newExcerpt) {
    burst.changes.push({ old: String(notice.oldExcerpt ?? '').slice(0, EXCERPT_CHARS), new: String(notice.newExcerpt ?? '').slice(0, EXCERPT_CHARS) });
    if (burst.changes.length > 5) burst.changes.shift();
  }
  if (burst.timer) clearTimeout(burst.timer);
  const debounce = Math.max(0, surfaceConfig('edit-stale').debounceMs ?? 15000);
  burst.timer = setTimeout(() => enqueue(key), debounce);
  burst.timer.unref?.();
  bursts.set(key, burst);
  return { scheduled: true };
}

function enqueue(key: string): void {
  const burst = bursts.get(key);
  if (!burst) return;
  bursts.delete(key);
  if (burst.timer) { clearTimeout(burst.timer); burst.timer = null; }
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(burst);
  pump();
}

function pump(): void {
  while (running < CONCURRENCY && queue.length) {
    const burst = queue.shift()!;
    running++;
    const job = judgeBurst(burst).catch(() => {}).finally(() => {
      running--;
      const list = inflight.get(burst.sessionId);
      if (list) { const i = list.indexOf(job); if (i >= 0) list.splice(i, 1); if (!list.length) inflight.delete(burst.sessionId); }
      pump();
    });
    const list = inflight.get(burst.sessionId) ?? [];
    list.push(job);
    inflight.set(burst.sessionId, list);
  }
}

/**
 * Judge the session's quiet-period bursts now (the Stop hook calls this) and
 * resolve when this session's queued judgments have finished.
 */
export async function flushEditChecks(sessionId?: string | null): Promise<void> {
  for (const [key, burst] of [...bursts]) if (!sessionId || burst.sessionId === sessionId) enqueue(key);
  const jobs = sessionId ? (inflight.get(sessionId) ?? []) : [...inflight.values()].flat();
  await Promise.all(jobs);
}

/** Memories (live, any project) that list this absolute path in related_files. */
export function findMemoriesForFile(absPath: string, context: { cwd?: string | null; project?: string | null } = {}): Array<{ id: string; project: string; category: string; importance: number; content: string; updated_at: string; files: string[] }> {
  const tokens = basename(absPath).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!tokens.length) return [];
  const phrase = `"${tokens.join(' ').replace(/"/g, '""')}"`;
  const target = norm(absPath);
  const out: ReturnType<typeof findMemoriesForFile> = [];
  try {
    const rows = getDb().prepare(`SELECT m.id, m.project, m.category, m.importance, m.content, m.related_files, m.updated_at
      FROM memory_search f JOIN memories m ON m.id=f.id WHERE memory_search MATCH ? AND m.trashed_at IS NULL LIMIT ?`)
      .all(`files : ${phrase}`, MAX_CANDIDATES);
    const sessionRoot = context.cwd ? resolve(context.cwd) : null;
    for (const row of rows) {
      let files: string[];
      try { files = JSON.parse(String(row.related_files || '[]')); } catch { files = []; }
      if (!Array.isArray(files)) continue;
      const root = projectRoot(String(row.project || ''));
      const matching = files.filter(f => {
        if (typeof f !== 'string' || !f) return false;
        if (isAbsolute(f)) return norm(f) === target;
        if (root && norm(resolve(root, f)) === target) return true;
        // The session's own working directory anchors relative paths of its project.
        return Boolean(sessionRoot && (!context.project || String(row.project).toLowerCase() === String(context.project).toLowerCase()) && norm(resolve(sessionRoot, f)) === target);
      });
      if (!matching.length) continue;
      out.push({ id: String(row.id), project: String(row.project), category: String(row.category), importance: Number(row.importance) || 5, content: String(row.content), updated_at: String(row.updated_at || ''), files: matching });
    }
  } catch { /* FTS unavailable: no candidates */ }
  return out;
}

/** Identifiers worth matching: backticked spans, camelCase, snake_case and words of 5+ characters. */
function identifiers(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]{3,60})`/g)) ids.add(m[1].trim());
  for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{4,}/g)) ids.add(m[0]);
  return ids;
}

function memoryRevision(id: string): number {
  return Number((getDb().prepare('SELECT MAX(revision) AS n FROM memory_revisions WHERE memory_id=?').get(id) as { n: number } | undefined)?.n || 1);
}

function fileHash(absPath: string): string | null {
  try { return createHash('sha256').update(readFileSync(absPath)).digest('hex'); } catch { return null; }
}

/** The per-session hourly cap: the log keeps 20k rows and one file can be listed by hundreds of memories. */
function underHourlyCap(sessionId: string, maxItems: number): boolean {
  const hourStart = Math.floor(Date.now() / 3600_000);
  const entry = judgedThisHour.get(sessionId);
  if (!entry || entry.hourStart !== hourStart) { judgedThisHour.set(sessionId, { hourStart, count: 0 }); return true; }
  return entry.count < maxItems * 10;
}

async function judgeBurst(burst: Burst): Promise<void> {
  const settings = surfaceConfig('edit-stale');
  if (!settings.enabled || !typesafeEnabled()) return;
  if (typesafeRetryAfterMs() > 0) return;
  const maxItems = Math.max(1, Math.min(50, settings.maxItems ?? 3));
  if (!underHourlyCap(burst.sessionId, maxItems)) return;
  const hash = fileHash(burst.absPath);
  const candidates = findMemoriesForFile(burst.absPath, { cwd: burst.cwd, project: burst.project });
  if (!candidates.length) return;
  const removed = new Set<string>(), touched = new Set<string>();
  for (const change of burst.changes) {
    const before = identifiers(change.old), after = identifiers(change.new);
    for (const id of before) { touched.add(id); if (!after.has(id)) removed.add(id); }
    for (const id of after) touched.add(id);
  }
  const d = getDb();
  const readMeta = d.prepare('SELECT stale_verdicts FROM memory_metadata WHERE memory_id=?');
  const ranked = candidates
    // Updated after the burst began: the writer may already have folded the change in.
    .filter(c => !c.updated_at || c.updated_at <= burst.startedAt)
    .map(c => {
      const revision = memoryRevision(c.id);
      const verdicts = readStaleVerdicts((readMeta.get(c.id) as { stale_verdicts?: string } | undefined)?.stale_verdicts);
      // Judged already for this exact content of the file at this revision.
      const fresh = c.files.every(f => verdicts[f]?.hash === hash && verdicts[f]?.rev === revision);
      let score = 0;
      for (const id of removed) if (c.content.includes(id)) score += 2;
      for (const id of touched) if (c.content.includes(id)) score += 1;
      return { ...c, revision, fresh, score: score + c.importance / 10 };
    })
    .filter(c => !c.fresh)
    .sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at))
    .slice(0, maxItems);
  if (!ranked.length) return;
  const floor = settings.minProbability ?? 0.4;
  const entry = judgedThisHour.get(burst.sessionId);
  await Promise.all(ranked.map(async memory => {
    const excerpt = fileExcerpt(burst.absPath, memory.content);
    if (!excerpt) return;
    if (entry) entry.count++;
    let logId: number | null = null;
    const p = await judgeStaleMemory(memory.content, { path: memory.files[0], excerpt: excerpt.excerpt, truncated: excerpt.truncated }, {
      surface: 'edit-stale', origin: 'hook', sessionId: burst.sessionId, project: memory.project, entityId: memory.id,
      onLogged: id => { logId = id; },
    });
    if (p === null) return;
    const stale = p < floor;
    annotateTypeSafeLog(logId, { file: memory.files[0], probability: p, stale });
    for (const file of memory.files) recordStaleVerdict(memory.id, file, { p, hash, rev: memory.revision, at: new Date().toISOString(), session: burst.sessionId });
    if (stale) addPending(burst.sessionId, {
      memory_id: memory.id, file: memory.files[0], probability: p, category: memory.category, importance: memory.importance,
      excerpt: memory.content.replace(/\s+/g, ' ').slice(0, 240), judged_at: new Date().toISOString(),
    });
  }));
}

/**
 * Store one file's verdict on the memory. Read-modify-write inside a short
 * BEGIN IMMEDIATE with no network call in it; a revision that moved since the
 * judgment means the verdict is about text that no longer exists, so it is
 * dropped. At most MAX_VERDICT_FILES files are kept per memory.
 */
export function recordStaleVerdict(memoryId: string, file: string, verdict: StaleVerdictRecord): void {
  const d = getDb();
  let locked = false;
  try { d.exec('BEGIN IMMEDIATE'); locked = true; } catch { locked = false; }
  try {
    if (memoryRevision(memoryId) !== verdict.rev) { if (locked) d.exec('COMMIT'); return; }
    const current = readStaleVerdicts((d.prepare('SELECT stale_verdicts FROM memory_metadata WHERE memory_id=?').get(memoryId) as { stale_verdicts?: string } | undefined)?.stale_verdicts);
    current[file] = verdict;
    const kept = Object.entries(current).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, MAX_VERDICT_FILES);
    d.prepare(`INSERT INTO memory_metadata(memory_id,stale_verdicts,stale_checked_at) VALUES(?,?,?)
      ON CONFLICT(memory_id) DO UPDATE SET stale_verdicts=excluded.stale_verdicts,stale_checked_at=excluded.stale_checked_at`)
      .run(memoryId, JSON.stringify(Object.fromEntries(kept)), verdict.at);
    if (locked) d.exec('COMMIT');
  } catch {
    if (locked) { try { d.exec('ROLLBACK'); } catch { /* already rolled back */ } }
  }
}

function addPending(sessionId: string, verdict: StaleVerdict): void {
  const now = Date.now();
  const list = (pending.get(sessionId) ?? []).filter(e => now - e.at < PENDING_TTL_MS && e.verdict.memory_id !== verdict.memory_id);
  list.push({ verdict, at: now });
  while (list.length > MAX_PENDING_PER_SESSION) list.shift();
  pending.set(sessionId, list);
  if (pending.size > 500) pending.delete(pending.keys().next().value as string);
}

/**
 * This session's undelivered stale verdicts. `peek` leaves them pending;
 * otherwise they are delivered now and never again. `ack` marks memory ids
 * delivered without returning them (the hook already showed them).
 */
export function takeStaleVerdicts(sessionId: string | null | undefined, options: { peek?: boolean; ack?: string[] } = {}): StaleVerdict[] {
  if (!sessionId) return [];
  const now = Date.now();
  const acked = new Set(options.ack ?? []);
  const list = (pending.get(sessionId) ?? []).filter(e => now - e.at < PENDING_TTL_MS && !acked.has(e.verdict.memory_id));
  if (options.peek) { pending.set(sessionId, list); return list.map(e => e.verdict); }
  pending.delete(sessionId);
  return list.map(e => e.verdict);
}

/** A judged verdict for this revision that says the memory no longer holds. */
export function judgedStale(rawVerdicts: unknown, revision: number): boolean {
  const floor = surfaceConfig('edit-stale').minProbability ?? 0.4;
  return Object.values(readStaleVerdicts(rawVerdicts)).some(v => v.rev === revision && typeof v.p === 'number' && v.p < floor);
}

/** Tests only. */
export function resetEditStale(): void {
  for (const burst of bursts.values()) if (burst.timer) clearTimeout(burst.timer);
  bursts.clear(); queue.length = 0; inflight.clear(); pending.clear(); judgedThisHour.clear(); running = 0;
}

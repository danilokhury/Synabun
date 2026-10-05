/**
 * Trash triage: rank forget candidates by how little they would be missed.
 *
 * Candidates come from cheap local signals — exact duplicate groups, the
 * duplicate side of a judged `duplicate_of` relation, and old low-importance
 * memories that were never recalled. The judgment scores each one on the
 * expendability rubric so the list leads with the safest deletions. Nothing
 * here deletes: the `memories` tool action `triage` and the Judgments tab
 * render the list, and a person decides.
 *
 * Batches of candidates are judged in parallel and each fails alone. A score
 * is stored beside the memory's metadata with a fingerprint of what was
 * judged, and reused until that changes or a week passes, so a repeat triage
 * only asks about new or changed candidates.
 */

import { getDb } from './sqlite.js';
import { projectAliases } from '../config.js';
import { judgeExpendability, expendabilityBasis, EXPENDABILITY_LEVELS, type ExpendabilityCandidate } from './memory-judgments.js';
import { surfaceConfig, typesafeConfig } from './typesafe-config.js';
import { typesafeEnabled, typesafeRetryAfterMs } from './typesafe.js';

export interface TriageRow {
  id: string; project: string; category: string; importance: number; created_at: string; access_count: number;
  preview: string; reasons: string[];
  /** 0 (irreplaceable) … 4 (expendable), or null when unjudged. */
  expendability: number | null;
  level: string | null;
}

const LEVEL_NAMES = EXPENDABILITY_LEVELS.map(l => l.split(':')[0]);
const BATCH = 10;
const JUDGE_CONCURRENCY = 6;
const SCORE_TTL_MS = 7 * 86_400_000;
/** Ceiling on candidates considered in one run: every one of them is judged and returned. */
export const MAX_TRIAGE_LIMIT = 2000;
/** Rows carried by a progress snapshot; the finished result carries all of them. */
const PROGRESS_ROWS = 50;

/** Local candidate discovery; no API calls. */
export function findTriageCandidates(options: { project?: string | null; limit?: number } = {}): Array<TriageRow & { content: string; duplicateOf: string | null }> {
  const d = getDb();
  const limit = Math.max(1, Math.min(MAX_TRIAGE_LIMIT, Math.floor(options.limit ?? 20)));
  const where: string[] = ['m.trashed_at IS NULL'];
  const params: string[] = [];
  if (options.project) {
    const aliases = projectAliases(options.project).map(p => p.toLowerCase());
    where.push(`lower(m.project) IN (${aliases.map(() => '?').join(',')})`);
    params.push(...aliases);
  }
  const scope = where.join(' AND ');
  const rows = new Map<string, TriageRow & { content: string; duplicateOf: string | null }>();
  const add = (row: Record<string, unknown>, reason: string, duplicateOf: string | null = null) => {
    const id = String(row.id);
    const existing = rows.get(id);
    if (existing) { if (!existing.reasons.includes(reason)) existing.reasons.push(reason); if (duplicateOf && !existing.duplicateOf) existing.duplicateOf = duplicateOf; return; }
    rows.set(id, {
      id, project: String(row.project), category: String(row.category), importance: Number(row.importance), created_at: String(row.created_at),
      access_count: Number(row.access_count ?? 0), preview: String(row.content).slice(0, 240), content: String(row.content),
      reasons: [reason], expendability: null, level: null, duplicateOf,
    });
  };
  // Exact copies: every member but the oldest. CROSS JOIN pins the join order so
  // the oldest-copy lookup starts from the content_hash index; left to itself the
  // planner scanned the whole project once per copy (3.3 s on 24k memories).
  for (const row of d.prepare(`SELECT m.id,m.project,m.category,m.importance,m.created_at,m.access_count,m.content,
      (SELECT o.id FROM memory_metadata om CROSS JOIN memories o ON o.id=om.memory_id WHERE om.content_hash=md.content_hash AND o.trashed_at IS NULL AND o.project=m.project ORDER BY o.created_at,o.id LIMIT 1) AS oldest
    FROM memories m JOIN memory_metadata md ON md.memory_id=m.id
    WHERE ${scope} AND md.content_hash IN (SELECT md2.content_hash FROM memory_metadata md2 JOIN memories m2 ON m2.id=md2.memory_id WHERE m2.trashed_at IS NULL GROUP BY md2.content_hash,m2.project HAVING count(*)>1)
    ORDER BY m.created_at DESC LIMIT ?`).all(...params, limit)) {
    if (String(row.oldest) !== String(row.id)) add(row, `exact copy of ${String(row.oldest).slice(0, 8)}`, String(row.oldest));
  }
  // The newer side of a judged duplicate relation.
  for (const row of d.prepare(`SELECT m.id,m.project,m.category,m.importance,m.created_at,m.access_count,m.content,r.to_id AS canonical
    FROM memory_relations r JOIN memories m ON m.id=r.from_id JOIN memories t ON t.id=r.to_id
    WHERE r.kind='duplicate_of' AND r.active=1 AND t.trashed_at IS NULL AND ${scope} ORDER BY r.created_at DESC LIMIT ?`).all(...params, limit)) {
    add(row, `judged duplicate of ${String(row.canonical).slice(0, 8)}`, String(row.canonical));
  }
  // Old, unimportant, never recalled.
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  for (const row of d.prepare(`SELECT m.id,m.project,m.category,m.importance,m.created_at,m.access_count,m.content FROM memories m
    WHERE ${scope} AND m.importance<=3 AND m.access_count=0 AND m.created_at<? ORDER BY m.importance,m.created_at LIMIT ?`).all(...params, cutoff, limit)) {
    add(row, 'importance ≤ 3, never recalled, older than 90 days');
  }
  return [...rows.values()]
    .sort((a, b) => b.reasons.length - a.reasons.length || a.importance - b.importance || a.created_at.localeCompare(b.created_at))
    .slice(0, limit);
}

type Candidate = ReturnType<typeof findTriageCandidates>[number];

export interface TriageResult {
  rows: TriageRow[]; judged: boolean; candidates: number;
  /** Candidates still waiting on a judgment; above 0 only in progress snapshots. */
  pending: number;
  /** Candidates whose stored score was reused instead of asked again. */
  saved: number;
}

const toCandidate = (c: Candidate): ExpendabilityCandidate => ({ id: c.id, content: c.content, category: c.category, importance: c.importance, createdAt: c.created_at, accessCount: c.access_count, duplicateOf: c.duplicateOf });

function setScore(c: Candidate, s: number): void {
  c.expendability = Number(s.toFixed(2));
  c.level = LEVEL_NAMES[Math.max(0, Math.min(LEVEL_NAMES.length - 1, Math.round(s)))];
}

function rank(candidates: Candidate[], limit: number): TriageRow[] {
  return [...candidates].sort((a, b) => {
    if (a.expendability !== null && b.expendability !== null && a.expendability !== b.expendability) return b.expendability - a.expendability;
    if ((a.expendability === null) !== (b.expendability === null)) return a.expendability === null ? 1 : -1;
    return b.reasons.length - a.reasons.length || a.importance - b.importance || a.created_at.localeCompare(b.created_at);
  }).slice(0, limit).map(({ content: _content, duplicateOf: _dup, ...row }) => row);
}

/** Reuse stored scores whose basis matches what would be sent now and that are younger than the TTL. */
function applySavedScores(candidates: Candidate[], bases: Map<string, string>): number {
  if (!candidates.length) return 0;
  const stored = new Map(getDb().prepare(`SELECT memory_id,expendability,expendability_at,expendability_basis FROM memory_metadata
    WHERE memory_id IN (${candidates.map(() => '?').join(',')}) AND expendability IS NOT NULL`).all(...candidates.map(c => c.id)).map(row => [String(row.memory_id), row]));
  const cutoff = Date.now() - SCORE_TTL_MS;
  let saved = 0;
  for (const c of candidates) {
    const row = stored.get(c.id);
    if (!row || row.expendability_basis !== bases.get(c.id) || !(Date.parse(String(row.expendability_at)) > cutoff)) continue;
    setScore(c, Number(row.expendability));
    saved++;
  }
  return saved;
}

/** Store a batch's fresh scores. Update-only: a busy database or a missing metadata row costs a re-judgment next time, never the ranking. */
function saveScores(batch: Candidate[], bases: Map<string, string>): void {
  const d = getDb();
  try { d.exec('BEGIN IMMEDIATE'); } catch { return; }
  try {
    const update = d.prepare('UPDATE memory_metadata SET expendability=?,expendability_at=?,expendability_basis=? WHERE memory_id=?');
    const at = new Date().toISOString();
    for (const c of batch) if (c.expendability !== null) update.run(c.expendability, at, bases.get(c.id) ?? null, c.id);
    d.exec('COMMIT');
  } catch {
    try { d.exec('ROLLBACK'); } catch { /* already rolled back */ }
  }
}

/**
 * Candidates ranked by judged expendability, or by the local ordering when the
 * judgment is unavailable. Stored scores are reused; the rest are judged in
 * parallel batches that fail alone, and nothing new is sent while a 429's
 * retry-after holds. `onProgress` gets the ranking so far as batches land.
 */
export async function triageMemories(options: { project?: string | null; limit?: number; onProgress?: (snapshot: TriageResult) => void; origin?: 'tool' | 'ui' } = {}): Promise<TriageResult> {
  const limit = Math.max(1, Math.min(MAX_TRIAGE_LIMIT, Math.floor(options.limit ?? 20)));
  const candidates = findTriageCandidates({ project: options.project, limit });
  let saved = 0;
  let pending = 0;
  const snapshot = (rowCap = limit): TriageResult => ({ rows: rank(candidates, Math.min(limit, rowCap)), judged: candidates.some(c => c.expendability !== null), candidates: candidates.length, pending, saved });
  const emit = () => { try { options.onProgress?.(snapshot(PROGRESS_ROWS)); } catch { /* a closed stream must not stop the judging */ } };
  if (typesafeEnabled() && surfaceConfig('trash-triage').enabled) {
    const model = typesafeConfig().model;
    const bases = new Map(candidates.map(c => [c.id, expendabilityBasis(toCandidate(c), model)]));
    saved = applySavedScores(candidates, bases);
    const todo = candidates.filter(c => c.expendability === null);
    const batches: Candidate[][] = [];
    for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
    pending = todo.length;
    if (pending && !typesafeRetryAfterMs()) emit();
    for (let i = 0; i < batches.length; i += JUDGE_CONCURRENCY) {
      if (typesafeRetryAfterMs() > 0) break;
      await Promise.allSettled(batches.slice(i, i + JUDGE_CONCURRENCY).map(async batch => {
        const scores = await judgeExpendability(batch.map(toCandidate), { entityId: batch[0].id, origin: options.origin ?? 'tool', project: options.project ?? null, sessionId: null });
        if (scores) {
          for (const c of batch) { const s = scores.get(c.id); if (s !== undefined) setScore(c, s); }
          saveScores(batch, bases);
        }
        pending -= batch.length;
        if (pending > 0) emit();
      }));
    }
    pending = 0;
  }
  return snapshot();
}

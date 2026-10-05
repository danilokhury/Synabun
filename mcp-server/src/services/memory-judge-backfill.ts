/**
 * Backfill: judge the memories that were indexed before judgments existed.
 *
 * Migration v4 added the judged columns after every `index` job had already
 * completed, so only memories written since carry a judgment. This runner
 * enqueues a distinct `judge` job per unjudged memory and works through them
 * with its own pacing — a bounded batch per tick, only while nothing
 * interactive is waiting — using the vector already stored on the row rather
 * than re-embedding 24k memories.
 *
 * Rails: a dry-run estimate before anything is enqueued, an explicit start,
 * pause/resume/cancel, exponential backoff on failures, a lease so only one
 * Neural Interface drives it, and progress persisted in `typesafe_config`
 * so a restart resumes where it stopped. Judgments happen before the write
 * transaction and the revision is re-checked inside it, exactly like the
 * `index` job.
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { getDb, memoryVectors } from './sqlite.js';
import { projectAliases } from '../config.js';
import { applyJudgments, contentHash, memoryRevision, maintenanceStatus, relationCandidates, relationJudgeOptions, type RelationCandidate, type AppliedJudgments } from './memory-maintenance.js';
import { judgeMemory, judgeRelations, type RelationJudgment } from './memory-judgments.js';
import { typesafeConfig, invalidateTypeSafeConfig, mutateTypeSafeConfig, surfaceConfig, DEFAULT_BACKFILL_STATE, type BackfillState, type BackfillEstimate, type BackfillReport } from './typesafe-config.js';
import { typesafeEnabled, typesafeStats, typesafeRetryAfterMs, type JudgeUsage } from './typesafe.js';

const LEASE_KEY = 'typesafe_backfill_lease';
const LEASE_MS = 30_000;
const RUNNING_EXPIRY_MS = 300_000;
const FLUSH_EVERY_JOBS = 10;
const FLUSH_EVERY_MS = 5_000;
const BACKOFF_AFTER = 3;
const PAUSE_AFTER = 10;
const OWNER = `${process.pid}@${hostname()}#${randomUUID().slice(0, 8)}`;

export interface BackfillJobCounts { pending: number; running: number; complete: number; failed: number }
export interface BackfillStatus extends BackfillState { jobs: BackfillJobCounts; coverage: { judged: number; total: number }; retryAfterMs: number; owner: string; lease: { owner: string; until: string } | null }

// --- Selection ---

function unjudgedWhere(project?: string | null): { where: string; params: string[] } {
  const where = ['m.trashed_at IS NULL', 'NOT EXISTS (SELECT 1 FROM memory_metadata md WHERE md.memory_id=m.id AND md.judged_at IS NOT NULL)'];
  const params: string[] = [];
  if (project) {
    const aliases = projectAliases(project).map(p => p.toLowerCase());
    where.push(`lower(m.project) IN (${aliases.map(() => '?').join(',')})`);
    params.push(...aliases);
  }
  return { where: where.join(' AND '), params };
}

/** Live memories with a judgment / all live memories. */
export function judgedCoverage(): { judged: number; total: number } {
  const d = getDb();
  const total = Number((d.prepare('SELECT count(*) AS n FROM memories WHERE trashed_at IS NULL').get() as { n: number }).n);
  const judged = Number((d.prepare('SELECT count(*) AS n FROM memories m JOIN memory_metadata md ON md.memory_id=m.id WHERE m.trashed_at IS NULL AND md.judged_at IS NOT NULL').get() as { n: number }).n);
  return { judged, total };
}

export function countUnjudged(project?: string | null): number {
  const { where, params } = unjudgedWhere(project);
  return Number((getDb().prepare(`SELECT count(*) AS n FROM memories m WHERE ${where}`).get(...params) as { n: number }).n);
}

/** One `judge` job per unjudged live memory (newest first). Re-arms a stale non-running job; never touches a running one. */
export function enqueueJudgeBackfill(options: { limit?: number | null; project?: string | null } = {}): { enqueued: number; total: number } {
  const d = getDb();
  const { where, params } = unjudgedWhere(options.project);
  const total = countUnjudged(options.project);
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : total;
  const result = d.prepare(`INSERT INTO memory_jobs(id,kind,entity_id,updated_at)
    SELECT 'judge:'||m.id,'judge',m.id,? FROM memories m WHERE ${where} ORDER BY m.created_at DESC LIMIT ?
    ON CONFLICT(kind,entity_id) DO UPDATE SET status='pending',attempts=0,error=NULL,updated_at=excluded.updated_at WHERE memory_jobs.status!='running'`)
    .run(new Date().toISOString(), ...params, limit);
  return { enqueued: Number(result.changes), total: Math.min(total, limit) };
}

// --- Estimate (no API calls) ---

const blobVector = (blob: unknown): Float32Array | null => {
  if (!(blob instanceof Uint8Array) || blob.byteLength < 4) return null;
  return new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
};

/**
 * Tokens and cost from what is actually stored: content length for the
 * memory request, a local neighbour sample for how often a relations
 * request follows. Bench actuals replace the per-memory formula once a bench
 * has run. Nothing here talks to the API.
 */
export function estimateJudgeBackfill(options: { limit?: number | null; project?: string | null; sampleSize?: number } = {}): BackfillEstimate {
  const d = getDb();
  const cfg = typesafeConfig();
  const { where, params } = unjudgedWhere(options.project);
  const population = countUnjudged(options.project);
  const rows = options.limit && options.limit > 0 ? Math.min(population, Math.floor(options.limit)) : population;
  const meanChars = Number((d.prepare(`SELECT COALESCE(AVG(length(m.content)),0) AS n FROM memories m WHERE ${where}`).get(...params) as { n: number }).n);
  const sampleSize = Math.max(0, Math.min(1000, Math.floor(options.sampleSize ?? 200)));
  const sample = d.prepare(`SELECT m.id,m.project,m.category,m.vector FROM memories m WHERE ${where} ORDER BY random() LIMIT ?`).all(...params, sampleSize);
  let withCandidates = 0, candidateCount = 0, candidateChars = 0;
  for (const row of sample) {
    const vector = blobVector(row.vector);
    if (!vector) continue;
    const candidates = relationCandidates(d, row as Record<string, unknown>, vector);
    if (candidates.length) { withCandidates++; candidateCount += candidates.length; for (const c of candidates) candidateChars += c.content.length; }
  }
  const sampled = sample.length;
  const pCand = sampled ? withCandidates / sampled : 0;
  const meanCandidates = withCandidates ? candidateCount / withCandidates : 0;
  const meanCandidateChars = candidateCount ? candidateChars / candidateCount : 0;
  // Measured requests beat any formula: once a backfill has logged enough
  // rows, its own averages price the rest. The first run showed relation
  // requests at ~3.8k tokens where the size formula said ~1.5k — six long
  // questions per request cost more than the candidate text does.
  const measured = (surface: string): number | null => {
    try {
      const row = d.prepare("SELECT AVG(input_tokens) AS avg, count(*) AS n FROM typesafe_log WHERE surface=? AND origin='backfill' AND error IS NULL AND input_tokens>0").get(surface) as { avg: number | null; n: number } | undefined;
      return row && Number(row.n) >= 20 && row.avg ? Number(row.avg) : null;
    } catch { return null; }
  };
  const measuredMemory = measured('importance-kind');
  const measuredRelation = measured('relations');
  const benchAvg = cfg.bench.importance?.avgInputTokensPerItem ?? cfg.bench.kind?.avgInputTokensPerItem;
  const inputPerMemory = measuredMemory ?? (benchAvg && benchAvg > 0 ? benchAvg : Math.ceil(meanChars / 3.5) + 260);
  const outputPerMemory = 40;
  const relationsEnabled = surfaceConfig('relations').enabled;
  const relationCalls = relationsEnabled ? Math.round(rows * pCand) : 0;
  const inputPerRelation = measuredRelation ?? (Math.ceil((meanChars + meanCandidates * meanCandidateChars) / 3.5) + 150 + 600 * meanCandidates);
  const outputPerRelation = Math.ceil(25 * meanCandidates);
  const input = Math.round(rows * inputPerMemory + relationCalls * inputPerRelation);
  const output = Math.round(rows * outputPerMemory + relationCalls * outputPerRelation);
  const rates = { input: cfg.costPerMillionInput, output: cfg.costPerMillionOutput };
  const costUsd = rates.input > 0 || rates.output > 0 ? Number((input / 1e6 * rates.input + output / 1e6 * rates.output).toFixed(4)) : null;
  const concurrency = Math.max(1, cfg.backfillConcurrency);
  const avgMs = typesafeStats().avgMs || 1200;
  const wallClockMs = Math.ceil((rows + relationCalls) / concurrency) * Math.max(1000, avgMs);
  return {
    rows, meanChars: Math.round(meanChars),
    sample: { size: sampled, withCandidates, meanCandidates: Number(meanCandidates.toFixed(2)), meanCandidateChars: Math.round(meanCandidateChars) },
    calls: { importanceKind: rows, relations: relationCalls },
    tokens: { input, output },
    costUsd, rates, basis: measuredMemory || measuredRelation ? 'log' : benchAvg && benchAvg > 0 ? 'bench' : 'formula',
    wallClockMs, concurrency, at: new Date().toISOString(),
  };
}

// --- State ---

function jobCounts(d: DatabaseSync): BackfillJobCounts {
  const counts: BackfillJobCounts = { pending: 0, running: 0, complete: 0, failed: 0 };
  for (const row of d.prepare("SELECT status,count(*) AS n FROM memory_jobs WHERE kind='judge' GROUP BY status").all()) {
    const status = String(row.status) as keyof BackfillJobCounts;
    if (status in counts) counts[status] = Number(row.n);
  }
  return counts;
}

function readLease(d: DatabaseSync): { owner: string; until: string } | null {
  try {
    const row = d.prepare('SELECT value FROM kv_config WHERE key=?').get(LEASE_KEY) as { value?: string } | undefined;
    if (!row?.value) return null;
    const parsed = JSON.parse(String(row.value)) as { owner?: string; until?: string };
    return parsed?.owner && parsed?.until ? { owner: String(parsed.owner), until: String(parsed.until) } : null;
  } catch { return null; }
}

export function backfillStatus(): BackfillStatus {
  invalidateTypeSafeConfig();
  const d = getDb();
  return { ...typesafeConfig().backfill, jobs: jobCounts(d), coverage: judgedCoverage(), retryAfterMs: typesafeRetryAfterMs(), owner: OWNER, lease: readLease(d) };
}

function buildReport(state: BackfillState, finishedAt: string): BackfillReport {
  const cfg = typesafeConfig();
  const judged = Math.max(0, state.judged);
  const costUsd = cfg.costPerMillionInput > 0 || cfg.costPerMillionOutput > 0
    ? Number((state.tokensIn / 1e6 * cfg.costPerMillionInput + state.tokensOut / 1e6 * cfg.costPerMillionOutput).toFixed(4)) : null;
  return {
    startedAt: state.startedAt, finishedAt,
    wallClockMs: state.startedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(state.startedAt)) : 0,
    total: state.total, judged, skipped: state.skipped, failures: state.failures,
    relationsCreated: { ...state.relationsCreated },
    disagreements: { kind: state.disagreements.kind, kindRate: judged ? state.disagreements.kind / judged : 0, importance: state.disagreements.importance, importanceRate: judged ? state.disagreements.importance / judged : 0 },
    tokensIn: state.tokensIn, tokensOut: state.tokensOut, costUsd,
    avgLatencyMs: judged ? Math.round(state.latencyMsTotal / judged) : 0,
    coverageAfter: judgedCoverage(),
  };
}

export type BackfillAction = 'estimate' | 'start' | 'pause' | 'resume' | 'cancel';

/**
 * Drive the state machine. `start` is the only action that costs money and
 * it needs the API reachable; it enqueues, snapshots the estimate it was
 * confirmed against, and zeroes the counters.
 */
export function controlBackfill(action: BackfillAction, options: { limit?: number | null; project?: string | null; estimate?: BackfillEstimate | null } = {}): BackfillStatus {
  const d = getDb();
  const now = new Date().toISOString();
  if (action === 'estimate') {
    const estimate = estimateJudgeBackfill(options);
    mutateTypeSafeConfig(() => ({ backfill: { estimate } }));
    return backfillStatus();
  }
  if (action === 'start') {
    if (!typesafeEnabled()) throw new Error('TypeSafe is not enabled: check the kill switch, the master switch and the API key before starting a backfill.');
    if (!surfaceConfig('importance-kind').enabled) throw new Error('The importance-kind surface is off; the backfill has nothing to judge.');
    const current = typesafeConfig().backfill;
    if (current.status === 'running') throw new Error('A backfill is already running.');
    const estimate = options.estimate ?? estimateJudgeBackfill(options);
    flushProgress(true);
    const { total } = enqueueJudgeBackfill(options);
    resetJudgeBackfillRunner();
    mutateTypeSafeConfig(() => ({ backfill: { ...DEFAULT_BACKFILL_STATE, status: 'running', startedAt: now, limit: options.limit ?? null, project: options.project ?? null, total, estimate } }));
    return backfillStatus();
  }
  if (action === 'pause') {
    flushProgress(true);
    mutateTypeSafeConfig(current => ({ backfill: { status: current.backfill.status === 'running' ? 'paused' : current.backfill.status, pausedAt: now, pausedReason: 'user' } }));
    return backfillStatus();
  }
  if (action === 'resume') {
    const current = typesafeConfig().backfill;
    if (current.status !== 'paused') throw new Error('Nothing to resume: the backfill is not paused.');
    if (!typesafeEnabled()) throw new Error('TypeSafe is not enabled; fix the key or the switches before resuming.');
    if (!current.limit) enqueueJudgeBackfill({ project: current.project });
    resetJudgeBackfillRunner();
    mutateTypeSafeConfig(() => ({ backfill: { status: 'running', pausedAt: null, pausedReason: null, consecutiveFailures: 0 } }));
    return backfillStatus();
  }
  if (action === 'cancel') {
    flushProgress(true);
    d.prepare("DELETE FROM memory_jobs WHERE kind='judge' AND status IN ('pending','failed')").run();
    mutateTypeSafeConfig(current => ({ backfill: { status: 'cancelled', finishedAt: now, report: buildReport(current.backfill, now) } }));
    return backfillStatus();
  }
  throw new Error(`Unknown backfill action: ${String(action)}`);
}

// --- One job ---

export type JudgeJobOutcome =
  | { outcome: 'judged'; applied: AppliedJudgments; usage: { input: number; output: number; ms: number } }
  | { outcome: 'unavailable' | 'skipped' | 'stale' | 'deferred'; usage: { input: number; output: number; ms: number } };

/**
 * Judge one memory from its stored vector. Reads and both judgments happen
 * before BEGIN IMMEDIATE; the revision re-check inside discards anything
 * judged against content that changed meanwhile. Never re-embeds.
 */
export async function runJudgeJob(d: DatabaseSync, job: Record<string, unknown>): Promise<JudgeJobOutcome> {
  const usage = { input: 0, output: 0, ms: 0 };
  const onUsage = (u: JudgeUsage) => { usage.input += u.inputTokens; usage.output += u.outputTokens; usage.ms += u.latencyMs; };
  const complete = () => d.prepare("UPDATE memory_jobs SET status='complete',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), String(job.id));
  const row = d.prepare('SELECT * FROM memories WHERE id=?').get(String(job.entity_id)) as Record<string, any> | undefined;
  if (!row || row.trashed_at) { d.prepare('DELETE FROM memory_jobs WHERE id=?').run(String(job.id)); return { outcome: 'skipped', usage }; }
  const already = d.prepare('SELECT judged_at FROM memory_metadata WHERE memory_id=?').get(String(row.id)) as { judged_at?: string | null } | undefined;
  if (already?.judged_at) { complete(); return { outcome: 'skipped', usage }; }
  const id = String(row.id);
  const content = String(row.content);
  const hash = contentHash(content);
  const revision = memoryRevision(id);
  const context = { origin: 'backfill' as const, entityId: id, project: String(row.project), sessionId: null, onUsage };
  const judgment = await judgeMemory(content, { category: String(row.category), project: String(row.project) }, context);
  if (!judgment) return { outcome: 'unavailable', usage };
  let candidates: RelationCandidate[] = [];
  let verdicts: Map<string, RelationJudgment> | null = null;
  const vector = blobVector(row.vector);
  if (vector && surfaceConfig('relations').enabled) {
    candidates = relationCandidates(d, row, vector);
    if (candidates.length) verdicts = await judgeRelations({ content, recordedAt: String(row.created_at) }, candidates, { ...context, ...relationJudgeOptions() });
  }
  if (maintenanceStatus().paused) { d.prepare("UPDATE memory_jobs SET status='pending' WHERE id=?").run(String(job.id)); return { outcome: 'deferred', usage }; }
  d.exec('BEGIN IMMEDIATE');
  try {
    if (memoryRevision(id) !== revision) {
      d.prepare("UPDATE memory_jobs SET status='pending' WHERE id=?").run(String(job.id));
      d.exec('COMMIT');
      return { outcome: 'stale', usage };
    }
    const applied = applyJudgments(d, row, { hash, judgment, candidates, verdicts });
    complete();
    d.exec('COMMIT');
    return { outcome: 'judged', applied, usage };
  } catch (error) { d.exec('ROLLBACK'); memoryVectors.invalidate(); throw error; }
}

// --- The tick ---

interface Delta { judged: number; skipped: number; failures: number; relations: { similar: number; possible_conflict: number; duplicate_of: number }; disagreements: { kind: number; importance: number }; tokensIn: number; tokensOut: number; latencyMsTotal: number; lastError: string | null; lastErrorAt: string | null }
const emptyDelta = (): Delta => ({ judged: 0, skipped: 0, failures: 0, relations: { similar: 0, possible_conflict: 0, duplicate_of: 0 }, disagreements: { kind: 0, importance: 0 }, tokensIn: 0, tokensOut: 0, latencyMsTotal: 0, lastError: null, lastErrorAt: null });

let delta = emptyDelta();
let jobsSinceFlush = 0;
let lastFlushAt = 0;
let consecutiveFailures = 0;
let nextTickAt = 0;
let tickRunning = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** Forget in-memory pacing state (start/resume, and tests). Persisted counters are untouched. */
export function resetJudgeBackfillRunner(): void { consecutiveFailures = 0; nextTickAt = 0; }

function flushProgress(force = false): void {
  const due = force || jobsSinceFlush >= FLUSH_EVERY_JOBS || Date.now() - lastFlushAt >= FLUSH_EVERY_MS;
  if (!due) return;
  const pending = delta;
  const hasChanges = pending.judged || pending.skipped || pending.failures || pending.lastError;
  delta = emptyDelta(); jobsSinceFlush = 0; lastFlushAt = Date.now();
  if (!hasChanges && !force) return;
  try {
    mutateTypeSafeConfig(current => {
      const b = current.backfill;
      return { backfill: {
        judged: b.judged + pending.judged, skipped: b.skipped + pending.skipped, failures: b.failures + pending.failures,
        consecutiveFailures,
        relationsCreated: { similar: b.relationsCreated.similar + pending.relations.similar, possible_conflict: b.relationsCreated.possible_conflict + pending.relations.possible_conflict, duplicate_of: b.relationsCreated.duplicate_of + pending.relations.duplicate_of },
        disagreements: { kind: b.disagreements.kind + pending.disagreements.kind, importance: b.disagreements.importance + pending.disagreements.importance },
        tokensIn: b.tokensIn + pending.tokensIn, tokensOut: b.tokensOut + pending.tokensOut, latencyMsTotal: b.latencyMsTotal + pending.latencyMsTotal,
        lastError: pending.lastError ?? b.lastError, lastErrorAt: pending.lastErrorAt ?? b.lastErrorAt,
      } };
    });
  } catch (error) { console.error('[judge backfill] progress flush failed:', (error as Error).message); }
}

/** Claim up to `n` pending judge jobs under the lease. Returns [] when another runner holds it. */
function claimJudgeJobs(d: DatabaseSync, n: number): Record<string, unknown>[] {
  const now = Date.now();
  d.exec('BEGIN IMMEDIATE');
  try {
    const lease = readLease(d);
    if (lease && lease.owner !== OWNER && Date.parse(lease.until) > now) { d.exec('COMMIT'); return []; }
    d.prepare('INSERT INTO kv_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(LEASE_KEY, JSON.stringify({ owner: OWNER, until: new Date(now + LEASE_MS).toISOString() }));
    d.prepare("UPDATE memory_jobs SET status='pending' WHERE kind='judge' AND status='running' AND updated_at<?").run(new Date(now - RUNNING_EXPIRY_MS).toISOString());
    const jobs = d.prepare("SELECT * FROM memory_jobs WHERE kind='judge' AND status='pending' AND attempts<3 ORDER BY updated_at,id LIMIT ?").all(Math.max(1, n)) as Record<string, unknown>[];
    const stamp = new Date().toISOString();
    const claim = d.prepare("UPDATE memory_jobs SET status='running',attempts=attempts+1,updated_at=? WHERE id=?");
    for (const job of jobs) claim.run(stamp, String(job.id));
    d.exec('COMMIT');
    return jobs;
  } catch (error) { d.exec('ROLLBACK'); throw error; }
}

function releaseLease(d: DatabaseSync): void {
  try {
    const lease = readLease(d);
    if (lease?.owner === OWNER) d.prepare('DELETE FROM kv_config WHERE key=?').run(LEASE_KEY);
  } catch { /* best effort */ }
}

function finishIfDone(d: DatabaseSync): boolean {
  const counts = jobCounts(d);
  if (counts.pending || counts.running) return false;
  flushProgress(true);
  const now = new Date().toISOString();
  mutateTypeSafeConfig(current => current.backfill.status === 'running'
    ? { backfill: { status: 'done', finishedAt: now, report: buildReport(current.backfill, now) } }
    : {});
  releaseLease(d);
  return true;
}

export interface TickResult { claimed: number; outcomes: Record<string, number>; reason?: string }

/**
 * One bounded batch. Returns without claiming when the backfill is not
 * running, TypeSafe is off, a 429 asked us to wait, maintenance is paused,
 * an interactive job is pending (starvation guard), backoff is in effect,
 * or another runner holds the lease.
 */
export async function runJudgeBackfillTick(): Promise<TickResult> {
  const result: TickResult = { claimed: 0, outcomes: {} };
  if (tickRunning) return { ...result, reason: 'busy' };
  if (Date.now() < nextTickAt) return { ...result, reason: 'backoff' };
  invalidateTypeSafeConfig();
  const cfg = typesafeConfig();
  if (cfg.backfill.status !== 'running') return { ...result, reason: `status ${cfg.backfill.status}` };
  if (!typesafeEnabled()) return { ...result, reason: 'typesafe disabled' };
  if (!surfaceConfig('importance-kind').enabled) return { ...result, reason: 'importance-kind surface off' };
  if (typesafeRetryAfterMs() > 0) return { ...result, reason: 'retry-after' };
  const d = getDb();
  if (maintenanceStatus().paused) return { ...result, reason: 'maintenance paused' };
  if (d.prepare("SELECT 1 FROM memory_jobs WHERE status='pending' AND attempts<3 AND kind IN ('index','verify') LIMIT 1").get()) return { ...result, reason: 'interactive job pending' };
  tickRunning = true;
  try {
    const jobs = claimJudgeJobs(d, Math.max(1, cfg.backfillConcurrency));
    result.claimed = jobs.length;
    if (!jobs.length) { if (finishIfDone(d)) result.reason = 'done'; else result.reason = 'nothing claimable'; return result; }
    const settled = await Promise.allSettled(jobs.map(job => runJudgeJob(d, job)));
    const stamp = new Date().toISOString();
    settled.forEach((outcome, i) => {
      const job = jobs[i];
      if (outcome.status === 'fulfilled') {
        const value = outcome.value;
        result.outcomes[value.outcome] = (result.outcomes[value.outcome] ?? 0) + 1;
        delta.tokensIn += value.usage.input; delta.tokensOut += value.usage.output; delta.latencyMsTotal += value.usage.ms;
        if (value.outcome === 'judged') {
          delta.judged++; consecutiveFailures = 0;
          for (const kind of ['similar', 'possible_conflict', 'duplicate_of'] as const) delta.relations[kind] += value.applied.relations[kind];
          if (value.applied.disagreement.kind) delta.disagreements.kind++;
          if (value.applied.disagreement.importance) delta.disagreements.importance++;
        } else if (value.outcome === 'skipped') {
          delta.skipped++;
        } else if (value.outcome === 'unavailable') {
          // An API blip must not burn one of the three attempts.
          d.prepare("UPDATE memory_jobs SET status='pending',attempts=MAX(0,attempts-1),error=?,updated_at=? WHERE id=?").run(typesafeStats().lastError ?? 'judgment unavailable', stamp, String(job.id));
          delta.failures++; consecutiveFailures++;
          delta.lastError = typesafeStats().lastError ?? 'judgment unavailable'; delta.lastErrorAt = stamp;
        }
        // 'stale' and 'deferred' already put the job back to pending.
      } else {
        const message = (outcome.reason as Error)?.message ?? String(outcome.reason);
        result.outcomes.error = (result.outcomes.error ?? 0) + 1;
        d.prepare("UPDATE memory_jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,error=?,updated_at=? WHERE id=?").run(message, stamp, String(job.id));
        delta.failures++; consecutiveFailures++;
        delta.lastError = message; delta.lastErrorAt = stamp;
      }
    });
    jobsSinceFlush += jobs.length;
    if (consecutiveFailures >= PAUSE_AFTER) {
      flushProgress(true);
      mutateTypeSafeConfig(() => ({ backfill: { status: 'paused', pausedAt: stamp, pausedReason: 'failures' } }));
      releaseLease(d);
      result.reason = 'paused after repeated failures';
    } else {
      if (consecutiveFailures >= BACKOFF_AFTER) nextTickAt = Date.now() + Math.min(120_000, 30_000 * 2 ** (consecutiveFailures - BACKOFF_AFTER));
      flushProgress();
    }
    return result;
  } finally { tickRunning = false; }
}

/** Start the runner in this process. Only the Neural Interface should call this; stdio MCP servers must not. */
export function startJudgeBackfill(options: { intervalMs?: number } = {}): void {
  if (timer) return;
  timer = setInterval(() => { runJudgeBackfillTick().catch(error => console.error('[judge backfill]', (error as Error).message)); }, Math.max(250, options.intervalMs ?? 1000));
  timer.unref();
}

/**
 * Stop the runner in this process: flush the last counters and give up the
 * lease so a respawned server claims immediately instead of waiting out the
 * 30 s. Pending jobs stay pending; the persisted status is untouched.
 */
export function stopJudgeBackfill(): void {
  if (timer) clearInterval(timer);
  timer = null;
  flushProgress(true);
  try { releaseLease(getDb()); } catch { /* best effort */ }
}

/** Exposed for tests. */
export const _backfillInternals = {
  get consecutiveFailures() { return consecutiveFailures; },
  get nextTickAt() { return nextTickAt; },
  /** Clear only the backoff clock; the failure streak stays. */
  clearBackoff() { nextTickAt = 0; },
  OWNER, LEASE_KEY, flushProgress,
};

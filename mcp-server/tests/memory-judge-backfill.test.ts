import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
vi.mock('../src/services/local-embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => [1, 0, 0]), EMBEDDING_VERSION: 'test:3',
  embedPassages: vi.fn(async (content: string) => [{ content, vector: [1, 0, 0] }]),
}));
import { getDb, closeDatabase, upsertMemory, memoryVectors } from '../src/services/sqlite.js';
import { runMaintenanceBatch, pauseMaintenance } from '../src/services/memory-maintenance.js';
import {
  enqueueJudgeBackfill, estimateJudgeBackfill, runJudgeJob, runJudgeBackfillTick, controlBackfill, backfillStatus,
  judgedCoverage, resetJudgeBackfillRunner, startJudgeBackfill, stopJudgeBackfill, _backfillInternals,
} from '../src/services/memory-judge-backfill.js';
import { typesafeConfig, invalidateTypeSafeConfig, updateTypeSafeConfig } from '../src/services/typesafe-config.js';
import { resetTypeSafeKey, clearTypeSafeCache, resetTypeSafeMetrics } from '../src/services/typesafe.js';
import type { MemoryPayload } from '../src/types.js';

/**
 * The backfill judges from stored vectors, never re-embeds, and obeys every
 * rail: starvation guard, kill switch, pause, backoff, lease. These tests
 * drive it against a stubbed fetch; the live API is never reached.
 */

function add(content: string, overrides: Partial<MemoryPayload> = {}, vector = [1, 0, 0]) {
  const id = randomUUID();
  upsertMemory(id, vector, { content, project: 'synabun', category: 'development', tags: [], importance: 5,
    source: 'self-discovered', created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
    accessed_at: '2026-09-01T00:00:00.000Z', access_count: 0, ...overrides });
  return id;
}
const markJudged = (id: string) => getDb().prepare("INSERT INTO memory_metadata(memory_id,kind,judged_at) VALUES(?,'note','2026-09-19T00:00:00.000Z') ON CONFLICT(memory_id) DO UPDATE SET judged_at=excluded.judged_at").run(id);
const judgeJobs = () => getDb().prepare("SELECT id,entity_id,status,attempts,error FROM memory_jobs WHERE kind='judge' ORDER BY entity_id").all();
const ok = (answers: unknown) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 10 }, answers }) });
const memoryAnswers = { importance: { type: 'score', score: 3, confidence: 0.8, legend: {}, probabilities: {} }, kind: { type: 'choice', choice: 'decision', confidence: 0.9, probabilities: {} } };
const relationAnswers = { relation_0: { type: 'choice', choice: 'related', confidence: 0.8, probabilities: {} }, contradiction_0: { type: 'noul', noul: 0.05 } };
/** Answers whichever request arrives: the memory judgment carries `memory_text`, the relation one carries `candidates`. */
const smartFetch = () => vi.fn(async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  return ok(body.state.candidates ? relationAnswers : memoryAnswers);
});

beforeAll(() => getDb());
beforeEach(() => {
  // The index trigger enqueues an `index` job for every seeded row; those are
  // cleared so the starvation guard only sees what a test adds on purpose.
  getDb().exec('DELETE FROM memories; DELETE FROM memory_relations; DELETE FROM memory_metadata; DELETE FROM memory_revisions; DELETE FROM memory_jobs; DELETE FROM memory_passages; DELETE FROM kv_config; DELETE FROM typesafe_log;');
  memoryVectors.invalidate(); invalidateTypeSafeConfig(); resetJudgeBackfillRunner();
  delete process.env.SYNABUN_TYPESAFE; process.env.TYPESAFE_API_KEY = 'test-key'; process.env.DOTENV_PATH = '/nonexistent/.env';
  resetTypeSafeKey(); clearTypeSafeCache(); resetTypeSafeMetrics();
});
afterEach(() => { vi.unstubAllGlobals(); stopJudgeBackfill(); delete process.env.TYPESAFE_API_KEY; delete process.env.DOTENV_PATH; process.env.SYNABUN_TYPESAFE = 'off'; resetTypeSafeKey(); });
afterAll(() => closeDatabase());

const seed = () => { const ids = [add('a synabun fact'), add('another synabun fact'), add('a fact from another project', { project: 'other-project' })]; getDb().exec("DELETE FROM memory_jobs WHERE kind='index'"); return ids; };

describe('selection and estimate', () => {
  it('enqueues one judge job per unjudged live memory, honouring project aliases and limit', () => {
    const [a, b] = seed();
    markJudged(a);
    expect(judgedCoverage()).toEqual({ judged: 1, total: 3 });
    expect(enqueueJudgeBackfill({ project: 'SynaBun' })).toEqual({ enqueued: 1, total: 1 });
    expect(judgeJobs().map(j => j.entity_id)).toEqual([b]);
    expect(enqueueJudgeBackfill({})).toEqual({ enqueued: 2, total: 2 });
    expect(judgeJobs()).toHaveLength(2);
    // Re-running re-arms a failed job but never touches a running one.
    getDb().prepare("UPDATE memory_jobs SET status='failed',attempts=3 WHERE entity_id=?").run(b);
    getDb().prepare("UPDATE memory_jobs SET status='running' WHERE entity_id!=?").run(b);
    enqueueJudgeBackfill({});
    const rows = judgeJobs();
    expect(rows.find(j => j.entity_id === b)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(rows.filter(j => j.status === 'running')).toHaveLength(1);
  });

  it('estimates tokens, calls and cost without calling the API', () => {
    seed();
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const estimate = estimateJudgeBackfill({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(estimate.rows).toBe(3);
    expect(estimate.calls.importanceKind).toBe(3);
    expect(estimate.tokens.input).toBeGreaterThan(3 * 260);
    expect(estimate.costUsd).toBeGreaterThan(0);
    expect(estimate.basis).toBe('formula');
    expect(estimate.sample.size).toBe(3);
    // The two synabun rows share project+category and a vector, so each sees the other as a candidate.
    expect(estimate.sample.withCandidates).toBe(2);
    updateTypeSafeConfig({ bench: { importance: { at: 'x', n: 5, agreement: 1, file: null, avgInputTokensPerItem: 900 } }, costPerMillionInput: 0, costPerMillionOutput: 0 });
    const withBench = estimateJudgeBackfill({ limit: 2 });
    expect(withBench).toMatchObject({ rows: 2, basis: 'bench', costUsd: null });
    expect(withBench.tokens.input).toBeGreaterThanOrEqual(1800);
  });

  it('prices the rest of a run from its own logged requests once enough rows exist', () => {
    seed();
    const insert = getDb().prepare("INSERT INTO typesafe_log(created_at,surface,origin,model,question_count,state_preview,answers,latency_ms,input_tokens,output_tokens,cached,error) VALUES(?,?,'backfill','m',1,'',NULL,300,?,10,0,NULL)");
    for (let i = 0; i < 19; i++) insert.run(new Date().toISOString(), 'relations', 3800);
    expect(estimateJudgeBackfill({}).basis).not.toBe('log');
    insert.run(new Date().toISOString(), 'relations', 3800);
    for (let i = 0; i < 20; i++) insert.run(new Date().toISOString(), 'importance-kind', 1100);
    // Failed rows carry no usage and must not drag the average down.
    getDb().prepare("INSERT INTO typesafe_log(created_at,surface,origin,model,question_count,state_preview,answers,latency_ms,input_tokens,output_tokens,cached,error) VALUES(?,'relations','backfill','m',1,'',NULL,300,0,0,0,'HTTP 400')").run(new Date().toISOString());
    const estimate = estimateJudgeBackfill({});
    expect(estimate.basis).toBe('log');
    // 3 memories × 1,100 + relation calls (2 of 3 have a neighbour) × 3,800.
    expect(estimate.calls.relations).toBe(2);
    expect(estimate.tokens.input).toBe(3 * 1100 + 2 * 3800);
  });
});

describe('one judge job', () => {
  it('judges from the stored vector, writes judged_at and a relation, and never re-embeds', async () => {
    const [a] = seed();
    const fetchMock = smartFetch(); vi.stubGlobal('fetch', fetchMock);
    enqueueJudgeBackfill({});
    const passagesBefore = getDb().prepare('SELECT count(*) AS n FROM memory_passages').get()?.n;
    const job = judgeJobs().find(j => j.entity_id === a)!;
    const outcome = await runJudgeJob(getDb(), job);
    expect(outcome.outcome).toBe('judged');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const meta = getDb().prepare('SELECT kind,kind_judged,importance_judged,judged_at FROM memory_metadata WHERE memory_id=?').get(a);
    expect(meta).toMatchObject({ kind: 'decision', kind_judged: 'decision' });
    expect(meta?.judged_at).toBeTruthy();
    expect(Number(meta?.importance_judged)).toBeCloseTo(6.5);
    expect(getDb().prepare("SELECT kind FROM memory_relations WHERE active=1").all().map(r => r.kind)).toEqual(['similar']);
    expect(getDb().prepare('SELECT count(*) AS n FROM memory_passages').get()?.n).toBe(passagesBefore);
    expect(getDb().prepare("SELECT status FROM memory_jobs WHERE id=?").get(job.id)?.status).toBe('complete');
    // memories.importance is untouched: applying is gated behind the bench.
    expect(getDb().prepare('SELECT importance FROM memories WHERE id=?').get(a)?.importance).toBe(5);
    expect(getDb().prepare("SELECT origin,surface FROM typesafe_log ORDER BY id").all()).toEqual([{ origin: 'backfill', surface: 'importance-kind' }, { origin: 'backfill', surface: 'relations' }]);
  });

  it('skips trashed or already judged rows without a request', async () => {
    const [a, b] = seed();
    const fetchMock = smartFetch(); vi.stubGlobal('fetch', fetchMock);
    enqueueJudgeBackfill({});
    markJudged(a);
    getDb().prepare("UPDATE memories SET trashed_at='2026-09-19' WHERE id=?").run(b);
    const jobs = judgeJobs();
    expect((await runJudgeJob(getDb(), jobs.find(j => j.entity_id === a)!)).outcome).toBe('skipped');
    expect((await runJudgeJob(getDb(), jobs.find(j => j.entity_id === b)!)).outcome).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(judgeJobs().find(j => j.entity_id === b)).toBeUndefined();
  });
});

describe('the tick', () => {
  const startRunning = () => { vi.stubGlobal('fetch', smartFetch()); controlBackfill('start', {}); };

  it('start refuses without a working key and otherwise enqueues, estimates and zeroes the counters', () => {
    seed();
    process.env.SYNABUN_TYPESAFE = 'off';
    expect(() => controlBackfill('start', {})).toThrow(/not enabled/);
    delete process.env.SYNABUN_TYPESAFE;
    const status = controlBackfill('start', { limit: 2 });
    expect(status).toMatchObject({ status: 'running', total: 2, judged: 0, jobs: { pending: 2 } });
    expect(status.estimate?.rows).toBe(2);
    expect(() => controlBackfill('start', {})).toThrow(/already running/);
  });

  it('claims nothing while an interactive index or verify job is pending', async () => {
    const [a] = seed();
    startRunning();
    getDb().prepare("INSERT INTO memory_jobs(id,kind,entity_id,updated_at) VALUES('index:x','index',?,?)").run(a, new Date().toISOString());
    expect(await runJudgeBackfillTick()).toMatchObject({ claimed: 0, reason: 'interactive job pending' });
    getDb().exec("DELETE FROM memory_jobs WHERE kind='index'");
    const tick = await runJudgeBackfillTick();
    expect(tick.claimed).toBe(3);
    expect(tick.outcomes.judged).toBe(3);
  });

  it('is inert when not running, when maintenance is paused, and when the kill switch is on', async () => {
    seed();
    expect((await runJudgeBackfillTick()).reason).toBe('status idle');
    startRunning();
    pauseMaintenance(true);
    expect((await runJudgeBackfillTick()).reason).toBe('maintenance paused');
    pauseMaintenance(false);
    process.env.SYNABUN_TYPESAFE = 'off';
    expect((await runJudgeBackfillTick()).reason).toBe('typesafe disabled');
    delete process.env.SYNABUN_TYPESAFE;
    updateTypeSafeConfig({ surfaces: { 'importance-kind': { enabled: false } } });
    expect((await runJudgeBackfillTick()).reason).toBe('importance-kind surface off');
  });

  it('hands an unavailable judgment back to pending without consuming an attempt, then backs off and pauses', async () => {
    seed();
    startRunning();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    updateTypeSafeConfig({ backfillConcurrency: 1 });
    let tick = await runJudgeBackfillTick();
    expect(tick).toMatchObject({ claimed: 1, outcomes: { unavailable: 1 } });
    expect(judgeJobs().every(j => j.status === 'pending' && j.attempts === 0)).toBe(true);
    expect(_backfillInternals.consecutiveFailures).toBe(1);
    for (let i = 0; i < 2; i++) { resetJudgeBackfillRunnerKeepingFailures(); tick = await runJudgeBackfillTick(); }
    expect(_backfillInternals.consecutiveFailures).toBe(3);
    expect(_backfillInternals.nextTickAt).toBeGreaterThan(Date.now());
    expect((await runJudgeBackfillTick()).reason).toBe('backoff');
    for (let i = 0; i < 7; i++) { resetJudgeBackfillRunnerKeepingFailures(); tick = await runJudgeBackfillTick(); }
    expect(tick.reason).toBe('paused after repeated failures');
    const status = backfillStatus();
    expect(status).toMatchObject({ status: 'paused', pausedReason: 'failures', lastError: 'ECONNREFUSED' });
    expect(status.failures).toBe(10);
    // Resume clears the failure streak and continues once the API is back.
    vi.stubGlobal('fetch', smartFetch());
    expect(controlBackfill('resume', {}).status).toBe('running');
    tick = await runJudgeBackfillTick();
    expect(tick.outcomes.judged).toBe(1);
  });

  it('finishes with a report, and cancel removes the pending jobs', async () => {
    seed();
    startRunning();
    await runJudgeBackfillTick();
    const done = await runJudgeBackfillTick();
    expect(done.reason).toBe('done');
    const status = backfillStatus();
    expect(status).toMatchObject({ status: 'done', judged: 3, coverage: { judged: 3, total: 3 }, lease: null });
    expect(status.report).toMatchObject({ judged: 3, total: 3, relationsCreated: { similar: 2 }, coverageAfter: { judged: 3, total: 3 } });
    expect(status.report?.tokensIn).toBe(500);
    // A fresh run over new rows can be cancelled.
    add('late arrival'); getDb().exec("DELETE FROM memory_jobs WHERE kind='index'");
    controlBackfill('start', {});
    expect(backfillStatus().jobs.pending).toBe(1);
    expect(controlBackfill('cancel', {})).toMatchObject({ status: 'cancelled', jobs: { pending: 0 } });
  });

  it('claims nothing while another runner holds the lease, and resumes after a restart of this runner', async () => {
    seed();
    startRunning();
    getDb().prepare("INSERT INTO kv_config(key,value) VALUES(?,?)").run(_backfillInternals.LEASE_KEY, JSON.stringify({ owner: 'other@host#1', until: new Date(Date.now() + 60_000).toISOString() }));
    expect(await runJudgeBackfillTick()).toMatchObject({ claimed: 0, reason: 'nothing claimable' });
    getDb().prepare('DELETE FROM kv_config WHERE key=?').run(_backfillInternals.LEASE_KEY);
    // "Restart": the persisted status is still running and the jobs are still pending.
    stopJudgeBackfill(); invalidateTypeSafeConfig();
    expect(typesafeConfig().backfill.status).toBe('running');
    startJudgeBackfill({ intervalMs: 250 });
    expect((await runJudgeBackfillTick()).claimed).toBe(3);
  });

  it('stopJudgeBackfill releases this runner\'s lease and leaves a foreign one alone', async () => {
    seed();
    startRunning();
    await runJudgeBackfillTick();
    expect(backfillStatus().lease?.owner).toBe(_backfillInternals.OWNER);
    stopJudgeBackfill();
    expect(backfillStatus().lease).toBeNull();
    getDb().prepare('INSERT INTO kv_config(key,value) VALUES(?,?)').run(_backfillInternals.LEASE_KEY, JSON.stringify({ owner: 'other@host#1', until: new Date(Date.now() + 60_000).toISOString() }));
    stopJudgeBackfill();
    expect(backfillStatus().lease?.owner).toBe('other@host#1');
  });

  it('runMaintenanceBatch never claims a judge job', async () => {
    const [a] = seed();
    enqueueJudgeBackfill({});
    await runMaintenanceBatch();
    expect(judgeJobs().find(j => j.entity_id === a)).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

/** Clear only the backoff clock so the next tick runs; the failure streak is what the test is measuring. */
function resetJudgeBackfillRunnerKeepingFailures() { _backfillInternals.clearBackoff(); }

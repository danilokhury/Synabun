import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../src/services/local-embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => [1, 0, 0]), EMBEDDING_VERSION: 'test:3',
  embedPassages: vi.fn(async (content: string) => [{ content, vector: [1, 0, 0] }]),
}));
import { getDb, closeDatabase, upsertMemory, memoryVectors } from '../src/services/sqlite.js';
import {
  judgeRelevance, orderByJudgedScore, relevanceLevel, judgePromptTurn, judgeStopTurn, judgeRelations, mapRelation,
  judgeCompactDigest, judgePlanConflicts, RELEVANCE_QUERY_CLIP, RELEVANCE_CANDIDATE_CLIP, DEFAULT_RELATION_THRESHOLDS,
} from '../src/services/memory-judgments.js';
import { applyJudgments, setRelation } from '../src/services/memory-maintenance.js';
import { verifyMemorySources } from '../src/services/memory-verification.js';
import { noteEdit, flushEditChecks, takeStaleVerdicts, findMemoriesForFile, resetEditStale } from '../src/services/edit-stale.js';
import { retrieveMemory, resetPassageCache } from '../src/services/memory-retrieval.js';
import { fileExcerpt, isDeniedFile } from '../src/services/file-excerpt.js';
import {
  invalidateTypeSafeConfig, updateTypeSafeConfig, readTypeSafeLog, writeTypeSafeLog, annotateTypeSafeLog, relinkTypeSafeLog,
  typesafeLogStats, typesafeSessions, logSessionFromRef, validateTypeSafeConfigPatch, typesafeConfig, SURFACES, SURFACE_META,
} from '../src/services/typesafe-config.js';
import { resetTypeSafeKey, clearTypeSafeCache, resetTypeSafeMetrics } from '../src/services/typesafe.js';

/**
 * The coding-session surfaces (2026-09-23): relevance that fits a hook budget,
 * the prompt and Stop riders, log attribution, supersession, the edit-time
 * stale check, relative-path verification, the compaction digest and the plan
 * conflict check. A stubbed fetch answers by question id; the kill switch
 * proves every fallback sends nothing.
 */

const scenario = {
  relevance: (_i: number) => 3 as number | null, urgency: 'should', newTask: 0.9, pastSession: 0.1, preference: 0.8,
  claim: 0.95, worth: 0.9, blocker: 0.1, waiting: 0.1, relation: 'related', relationConfidence: 0.9, contradiction: 0.1,
  supersedes: 0.95, accurate: 0.2, label: (_i: number) => 'decision', conflict: (_i: number) => 0.9,
  importance: 2, kind: 'decision',
};
const requests: Array<{ state: any; questions: Record<string, any> }> = [];
function stubFetch() {
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    if (!String(url).includes('/v1/systemone')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const answers: Record<string, unknown> = {};
    for (const key of Object.keys(body.questions)) {
      const index = Number(key.split('_').pop());
      const noulOf = (p: number) => ({ type: 'noul', noul: p });
      if (key.startsWith('relevance_')) { const s = scenario.relevance(index); if (s !== null) answers[key] = { type: 'score', score: s, confidence: 0.8, legend: {}, probabilities: {} }; }
      else if (key === 'urgency') answers[key] = { type: 'choice', choice: scenario.urgency, confidence: 0.8, probabilities: {} };
      else if (key === 'new_task') answers[key] = noulOf(scenario.newTask);
      else if (key === 'past_session') answers[key] = noulOf(scenario.pastSession);
      else if (key === 'reveals_preference') answers[key] = noulOf(scenario.preference);
      else if (key === 'unsupported_claim') answers[key] = noulOf(scenario.claim);
      else if (key === 'worth_remembering') answers[key] = noulOf(scenario.worth);
      else if (key === 'human_blocker') answers[key] = noulOf(scenario.blocker);
      else if (key === 'waiting_for_user') answers[key] = noulOf(scenario.waiting);
      else if (key.startsWith('relation_')) answers[key] = { type: 'choice', choice: scenario.relation, confidence: scenario.relationConfidence, probabilities: {} };
      else if (key.startsWith('contradiction_')) answers[key] = noulOf(scenario.contradiction);
      else if (key.startsWith('supersedes_')) answers[key] = noulOf(scenario.supersedes);
      else if (key === 'accurate') answers[key] = noulOf(scenario.accurate);
      else if (key.startsWith('label_')) answers[key] = { type: 'choice', choice: scenario.label(index), confidence: 0.9, probabilities: {} };
      else if (key.startsWith('conflict_')) answers[key] = noulOf(scenario.conflict(index));
      else if (key === 'importance') answers[key] = { type: 'score', score: scenario.importance, confidence: 0.7, legend: {}, probabilities: {} };
      else if (key === 'kind') answers[key] = { type: 'choice', choice: scenario.kind, confidence: 0.7, probabilities: {} };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 50, output_tokens: 5 }, answers }) };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const apiCalls = (fn: ReturnType<typeof stubFetch>) => fn.mock.calls.filter(([url]) => String(url).includes('/v1/systemone'));
const killSwitch = () => { process.env.SYNABUN_TYPESAFE = 'off'; };

function add(content: string, overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  upsertMemory(id, [1, 0, 0], { content, project: 'coding-test', category: 'development', tags: [], importance: 5,
    source: 'self-discovered', created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
    accessed_at: '2026-09-01T00:00:00.000Z', access_count: 0, ...overrides } as any);
  return id;
}

let workDir = '';
function registerProject(label: string, root: string) {
  const dir = join(process.env.SYNABUN_DATA_HOME!, 'data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'claude-code-projects.json'), JSON.stringify([{ label, path: root }]));
}

beforeAll(() => { getDb(); });
beforeEach(() => {
  getDb().exec('DELETE FROM memories; DELETE FROM memory_relations; DELETE FROM memory_metadata; DELETE FROM memory_revisions; DELETE FROM memory_jobs; DELETE FROM memory_passages; DELETE FROM kv_config; DELETE FROM typesafe_log;');
  memoryVectors.invalidate(); resetPassageCache(); invalidateTypeSafeConfig(); resetEditStale();
  requests.length = 0;
  Object.assign(scenario, {
    relevance: () => 3, urgency: 'should', newTask: 0.9, pastSession: 0.1, preference: 0.8, claim: 0.95, worth: 0.9, blocker: 0.1, waiting: 0.1,
    relation: 'related', relationConfidence: 0.9, contradiction: 0.1, supersedes: 0.95, accurate: 0.2, label: () => 'decision', conflict: () => 0.9,
    importance: 2, kind: 'decision',
  });
  delete process.env.SYNABUN_TYPESAFE; process.env.TYPESAFE_API_KEY = 'test-key'; process.env.DOTENV_PATH = '/nonexistent/.env';
  resetTypeSafeKey(); clearTypeSafeCache(); resetTypeSafeMetrics();
  workDir = mkdtempSync(join(tmpdir(), 'synabun-coding-'));
});
afterEach(() => {
  vi.unstubAllGlobals(); delete process.env.TYPESAFE_API_KEY; delete process.env.DOTENV_PATH; process.env.SYNABUN_TYPESAFE = 'off'; resetTypeSafeKey();
  rmSync(workDir, { recursive: true, force: true });
  try { rmSync(join(process.env.SYNABUN_DATA_HOME!, 'data', 'claude-code-projects.json'), { force: true }); } catch { /* none */ }
});
afterAll(() => closeDatabase());

describe('surfaces config', () => {
  it('registers the eight coding surfaces with riders, budgets and limit knobs', () => {
    for (const name of ['task-boundary', 'session-lookup', 'user-learning', 'claim-check', 'edit-stale', 'supersession', 'compact-digest', 'plan-conflict']) {
      expect(SURFACES).toContain(name);
    }
    expect(SURFACE_META['task-boundary'].ridesWith).toBe('prompt-urgency');
    expect(SURFACE_META['claim-check'].ridesWith).toBe('agent-message');
    expect(SURFACE_META['supersession'].ridesWith).toBe('relations');
    const cfg = typesafeConfig();
    expect(cfg.surfaces.rerank.minScore).toBe(1.5);
    expect(cfg.surfaces['turn-worth'].bashOnlyMinProbability).toBe(0.8);
    expect(cfg.surfaces['edit-stale']).toMatchObject({ maxItems: 3, debounceMs: 15000, minProbability: 0.4 });
    expect(SURFACE_META.rerank.description).not.toMatch(/session boot recall\)/);
  });
  it('validates the limit knobs and persists them', () => {
    expect(() => validateTypeSafeConfigPatch({ surfaces: { rerank: { minScore: 5 } } })).toThrow(/minScore/);
    expect(() => validateTypeSafeConfigPatch({ surfaces: { 'edit-stale': { maxItems: 1.5 } } })).toThrow(/maxItems/);
    expect(() => validateTypeSafeConfigPatch({ surfaces: { 'edit-stale': { debounceMs: -1 } } })).toThrow(/debounceMs/);
    const patch = validateTypeSafeConfigPatch({ surfaces: { rerank: { minScore: 2 }, 'turn-worth': { bashOnlyMinProbability: 0.9 } } });
    updateTypeSafeConfig(patch);
    invalidateTypeSafeConfig();
    expect(typesafeConfig().surfaces.rerank.minScore).toBe(2);
    expect(typesafeConfig().surfaces['turn-worth'].bashOnlyMinProbability).toBe(0.9);
  });
});

describe('relevance (rerank / brief-rank)', () => {
  it('clips the query and every candidate so a task prompt fits the hook budget', async () => {
    stubFetch();
    const long = 'x'.repeat(16000);
    const candidates = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, content: `candidate ${i} `.repeat(3000) }));
    const scores = await judgeRelevance(long, candidates, { surface: 'brief-rank' });
    expect(scores?.size).toBe(10);
    expect(requests).toHaveLength(1);
    expect(requests[0].state.query.length).toBeLessThan(RELEVANCE_QUERY_CLIP + 80);
    for (const c of requests[0].state.candidates) expect(c.content.length).toBeLessThan(RELEVANCE_CANDIDATE_CLIP + 80);
  });
  it('judges a single candidate only when asked to (a relevance floor)', async () => {
    stubFetch();
    expect((await judgeRelevance('q', [{ id: 'a', content: 'a' }]))?.size).toBe(0);
    expect(requests).toHaveLength(0);
    expect((await judgeRelevance('q', [{ id: 'a', content: 'a' }], { single: true }))?.get('a')).toBe(3);
  });
  it('moves only judged items, keeps unjudged ones in place and ties in fusion order', () => {
    const items = ['a', 'b', 'c', 'd'].map(id => ({ id }));
    const ordered = orderByJudgedScore(items, new Map([['a', 1], ['c', 4], ['d', 1]]));
    expect(ordered.map(i => i.id)).toEqual(['c', 'b', 'a', 'd']);
    expect(relevanceLevel(3.2)).toBe('Direct');
    expect(relevanceLevel(0.4)).toBe('Irrelevant');
  });
  it('reranks a recall shortlist without reordering hits the judgment skipped', async () => {
    const ids = Array.from({ length: 4 }, (_, i) => add(`Rerank fixture ${i} about the hook budget`));
    scenario.relevance = (i: number) => (i === 2 ? 4 : i === 0 ? null : 1);
    stubFetch();
    const result = await retrieveMemory({ query: 'hook budget', project: 'coding-test', limit: 3, rerank: true, include_sessions: false }, async () => [1, 0, 0]);
    expect(result.results).toHaveLength(3);
    const judgedOrder = requests[0].state.candidates.map((c: { content: string }) => c.content);
    // The unjudged first hit keeps its place; the best-judged hit takes the first judged slot.
    expect(result.results[0].content).toBe(judgedOrder[0]);
    expect(result.results[0].reasons).not.toContain('judged relevance');
    expect(result.results[1].content).toBe(judgedOrder[2]);
    expect(result.results[1].reasons).toContain('judged relevance');
    expect(ids).toContain(result.results[1].id);
  });
});

describe('prompt turn (prompt-urgency + riders)', () => {
  it('asks urgency alone exactly as before when no rider is requested', async () => {
    stubFetch();
    const verdict = await judgePromptTurn({ prompt: 'add a flag', project: 'p' }, { urgency: true, newTask: false, pastSession: false, revealsPreference: false });
    expect(verdict).toEqual({ urgency: 'should', confidence: 0.8 });
    expect(Object.keys(requests[0].questions)).toEqual(['urgency']);
    expect(requests[0].state).toEqual({ prompt: 'add a flag', project: 'p' });
  });
  it('batches the requested riders, adds unsaved work only for the task boundary, and logs the riders', async () => {
    stubFetch();
    const verdict = await judgePromptTurn(
      { prompt: 'now fix the login bug', project: 'p', unsavedWork: { previousPrompt: 'refactor the parser', files: ['a.ts'], editCount: 3 } },
      { urgency: true, newTask: true, pastSession: true, revealsPreference: true },
      { origin: 'hook', sessionId: 'sess-1', project: 'p' },
    );
    expect(verdict).toMatchObject({ urgency: 'should', newTask: 0.9, pastSession: 0.1, revealsPreference: 0.8 });
    expect(Object.keys(requests[0].questions).sort()).toEqual(['new_task', 'past_session', 'reveals_preference', 'urgency']);
    expect(requests[0].state.unsaved_work).toEqual({ previous_prompt: 'refactor the parser', files_edited: ['a.ts'], edit_count: 3 });
    const [row] = readTypeSafeLog({ limit: 1 });
    expect(row).toMatchObject({ surface: 'prompt-urgency', origin: 'hook', session_id: 'sess-1', project: 'p' });
    expect(row.surfaces).toEqual(['prompt-urgency', 'task-boundary', 'session-lookup', 'user-learning']);
    requests.length = 0;
    await judgePromptTurn({ prompt: 'x', project: 'p', unsavedWork: { files: ['a'] } }, { urgency: true, newTask: false, pastSession: true, revealsPreference: false });
    expect(requests[0].state.unsaved_work).toBeUndefined();
  });
  it('rides alone under the first rider when urgency is off, and sends nothing with the kill switch', async () => {
    updateTypeSafeConfig({ surfaces: { 'prompt-urgency': { enabled: false } } }); invalidateTypeSafeConfig();
    stubFetch();
    await judgePromptTurn({ prompt: 'x' }, { urgency: false, newTask: false, pastSession: true, revealsPreference: false });
    expect(readTypeSafeLog({ limit: 1 })[0].surface).toBe('session-lookup');
    killSwitch();
    const fn = stubFetch();
    expect(await judgePromptTurn({ prompt: 'x' }, { urgency: true, newTask: true, pastSession: true, revealsPreference: true })).toBeNull();
    expect(apiCalls(fn)).toHaveLength(0);
  });
});

describe('stop turn (agent-message + turn-worth + claim-check)', () => {
  it('adds the claim question and what ran; the worth question reads the commands', async () => {
    stubFetch();
    const verdict = await judgeStopTurn(
      { message: 'All tests pass.', filesEdited: [], editCount: 0, commands: [{ command: 'npm test', exit: 'ok', output_tail: '12 passing' }], toolResults: [{ tool: 'Bash', is_error: false, tail: 'ok' }] },
      { agentMessage: true, turnWorth: true, claimCheck: true },
      { origin: 'hook', sessionId: 'sess-2' },
    );
    expect(verdict).toMatchObject({ humanBlocker: false, waitingForUser: false, worthRemembering: true, claimProbability: 0.95 });
    expect(Object.keys(requests[0].questions).sort()).toEqual(['human_blocker', 'unsupported_claim', 'waiting_for_user', 'worth_remembering']);
    expect(requests[0].state.bash_commands).toEqual([{ command: 'npm test', exit: 'ok', output_tail: '12 passing' }]);
    expect(requests[0].questions.worth_remembering.instructions).toMatch(/bash_commands/);
    const [row] = readTypeSafeLog({ limit: 1 });
    expect(row.surfaces).toEqual(['agent-message', 'turn-worth', 'claim-check']);
  });
  it('keeps the old state when the hook sends no commands and no claim question', async () => {
    stubFetch();
    await judgeStopTurn({ message: 'done', filesEdited: ['a'], editCount: 1 }, { agentMessage: true, turnWorth: true });
    expect(requests[0].state).toEqual({ assistant_message: 'done', files_edited: ['a'], edit_count: 1 });
    expect(requests[0].questions.worth_remembering.instructions).not.toMatch(/bash_commands/);
  });
});

describe('judgment log attribution', () => {
  it('writes session, project and riders, annotates outcomes and relinks provisional ids', () => {
    const id = writeTypeSafeLog({ surface: 'rerank', origin: 'hook', entity_id: 'tmp', model: 'm', question_count: 3, state_preview: 'p', answers: {}, latency_ms: 10, input_tokens: 5, output_tokens: 0, cached: 0, error: null, session_id: 'sess-3', project: 'p', surfaces: ['rerank'] });
    expect(typeof id).toBe('number');
    annotateTypeSafeLog(id, { injected: ['a'], dropped: ['b'] });
    relinkTypeSafeLog('tmp', 'final');
    const [row] = readTypeSafeLog({ sessionId: 'sess-3' });
    expect(row).toMatchObject({ entity_id: 'final', session_id: 'sess-3', project: 'p', outcome: { injected: ['a'], dropped: ['b'] } });
    writeTypeSafeLog({ surface: 'importance-kind', origin: 'backfill', entity_id: null, model: 'm', question_count: 2, state_preview: '', answers: null, latency_ms: 1, input_tokens: 1, output_tokens: 0, cached: 0, error: null });
    expect(readTypeSafeLog({ origin: 'live' }).map(r => r.surface)).toEqual(['rerank']);
    expect(readTypeSafeLog({ origin: 'backfill' })).toHaveLength(1);
  });
  it('finds riders by their own name and counts them in the stats and the sessions view', () => {
    writeTypeSafeLog({ surface: 'prompt-urgency', origin: 'hook', entity_id: null, model: 'm', question_count: 2, state_preview: '', answers: {}, latency_ms: 700, input_tokens: 90, output_tokens: 0, cached: 0, error: null, session_id: 'sess-4', project: 'p', surfaces: ['prompt-urgency', 'task-boundary'] });
    writeTypeSafeLog({ surface: 'agent-message', origin: 'hook', entity_id: null, model: 'm', question_count: 3, state_preview: '', answers: null, latency_ms: 1200, input_tokens: 0, output_tokens: 0, cached: 0, error: 'timeout', session_id: 'sess-4', project: 'p' });
    expect(readTypeSafeLog({ surface: 'task-boundary' })).toHaveLength(1);
    const stats = typesafeLogStats();
    expect(stats.surfaces['task-boundary'].h24.calls).toBe(1);
    expect(stats.surfaces['task-boundary'].h24.inputTokens).toBe(0);
    expect(stats.surfaces['prompt-urgency'].h24.inputTokens).toBe(90);
    expect(stats.surfaces['agent-message'].h24.failures).toBe(1);
    const [session] = typesafeSessions({});
    expect(session).toMatchObject({ session_id: 'sess-4', project: 'p', calls: 2, failures: 1 });
    expect(session.surfaces).toMatchObject({ 'prompt-urgency': 1, 'task-boundary': 1, 'agent-message': 1 });
    expect(logSessionFromRef('synabun-compaction:abc-123:gen')).toBe('abc-123');
    expect(logSessionFromRef('plain-session')).toBe('plain-session');
    expect(logSessionFromRef('has spaces')).toBeNull();
  });
});

describe('supersession (rides relations)', () => {
  const row = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({ ...getDb().prepare('SELECT * FROM memories WHERE id=?').get(id), created_at: createdAt, ...extra });
  it('asks only when enabled and maps duplicates with the relations knob', async () => {
    stubFetch();
    const verdicts = await judgeRelations({ content: 'new' }, [{ id: 'x', content: 'old' }], { askSupersession: true });
    expect(verdicts?.get('x')?.supersedes).toBe(0.95);
    expect(Object.keys(requests[0].questions)).toContain('supersedes_0');
    requests.length = 0;
    await judgeRelations({ content: 'new' }, [{ id: 'x', content: 'old' }]);
    expect(Object.keys(requests[0].questions)).not.toContain('supersedes_0');
    expect(mapRelation('duplicate', 0.8, null)).toBe('duplicate_of');
    expect(mapRelation('duplicate', 0.8, null, { ...DEFAULT_RELATION_THRESHOLDS, duplicate: 0.95 })).toBe('similar');
  });
  it('writes newer→older at the bar, never below it, and respects an undo', () => {
    const older = add('The deploy target is staging-1.', { created_at: '2026-09-01T00:00:00.000Z' });
    const newer = add('The deploy target is now staging-2.', { created_at: '2026-09-10T00:00:00.000Z' });
    const candidate = { id: older, content: 'The deploy target is staging-1.', score: 0.9, recordedAt: '2026-09-01T00:00:00.000Z' };
    const verdicts = new Map([[older, { relation: 'possible_conflict' as const, confidence: 0.9, contradiction: 0.9, supersedes: 0.85 }]]);
    const d = getDb();
    let applied = applyJudgments(d, row(newer, '2026-09-10T00:00:00.000Z'), { hash: 'h', judgment: null, candidates: [candidate], verdicts });
    expect(applied.relations.supersedes).toBe(0);
    expect(applied.relations.possible_conflict).toBe(1);
    d.exec('DELETE FROM memory_relations');
    verdicts.get(older)!.supersedes = 0.95;
    applied = applyJudgments(d, row(newer, '2026-09-10T00:00:00.000Z'), { hash: 'h', judgment: null, candidates: [candidate], verdicts });
    expect(applied.relations.supersedes).toBe(1);
    // A newer statement of the same thing is related as similar, not as a conflict.
    expect(applied.relations.similar).toBe(1);
    const rel = d.prepare("SELECT id,from_id,to_id,automatic,active FROM memory_relations WHERE kind='supersedes'").get() as any;
    expect(rel).toMatchObject({ from_id: newer, to_id: older, automatic: 1, active: 1 });
    d.prepare('UPDATE memory_relations SET active=0 WHERE id=?').run(rel.id);
    applied = applyJudgments(d, row(newer, '2026-09-10T00:00:00.000Z'), { hash: 'h', judgment: null, candidates: [candidate], verdicts });
    expect(applied.relations.supersedes).toBe(0);
    expect((d.prepare("SELECT active FROM memory_relations WHERE kind='supersedes'").get() as any).active).toBe(0);
  });
  it('never beside a duplicate, never demotes a user-told record, never on equal dates, and survives a cycle', () => {
    const d = getDb();
    const older = add('Rule A', { created_at: '2026-09-01T00:00:00.000Z', source: 'user-told' });
    const newer = add('Rule A, again', { created_at: '2026-09-10T00:00:00.000Z' });
    const cand = (id: string, at: string, content: string) => ({ id, content, score: 0.9, recordedAt: at });
    const v = (relation: 'duplicate_of' | 'similar') => new Map([[older, { relation, confidence: 0.9, contradiction: 0.1, supersedes: 0.99 }]]);
    expect(applyJudgments(d, row(newer, '2026-09-10T00:00:00.000Z'), { hash: 'h', judgment: null, candidates: [cand(older, '2026-09-01T00:00:00.000Z', 'Rule A')], verdicts: v('similar') }).relations.supersedes).toBe(0);
    d.prepare("UPDATE memories SET source='self-discovered' WHERE id=?").run(older);
    expect(applyJudgments(d, row(newer, '2026-09-10T00:00:00.000Z'), { hash: 'h', judgment: null, candidates: [cand(older, '2026-09-01T00:00:00.000Z', 'Rule A')], verdicts: v('duplicate_of') }).relations.supersedes).toBe(0);
    d.exec('DELETE FROM memory_relations');
    // A cycle (older already supersedes newer) must not fail the job.
    setRelation(older, newer, 'supersedes');
    expect(() => applyJudgments(d, row(newer, '2026-09-10T00:00:00.000Z'), { hash: 'h', judgment: null, candidates: [cand(older, '2026-09-01T00:00:00.000Z', 'Rule A')], verdicts: v('similar') })).not.toThrow();
  });
});

describe('edit-time stale check (surface edit-stale)', () => {
  it('finds memories by absolute and project-relative paths, and refuses key files', () => {
    registerProject('coding-test', workDir);
    const file = join(workDir, 'src', 'parser.ts');
    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(file, 'export function parseConfig() { return 1; }\n');
    const abs = add('parseConfig lives in src/parser.ts', { related_files: [file] });
    const rel = add('The parser entry point is parseConfig', { related_files: ['src/parser.ts'] });
    add('Unrelated file', { related_files: ['src/other.ts'] });
    expect(findMemoriesForFile(file).map(m => m.id).sort()).toEqual([abs, rel].sort());
    expect(isDeniedFile('/x/.env.local')).toBe(true);
    expect(isDeniedFile('/x/id_ed25519')).toBe(true);
    expect(isDeniedFile('/x/server.js')).toBe(false);
    expect(fileExcerpt('/x/.env', 'anything')).toBeNull();
  });
  it('judges a burst once, stores the verdict, flags recall and delivers it to the session once', async () => {
    registerProject('coding-test', workDir);
    updateTypeSafeConfig({ surfaces: { 'edit-stale': { debounceMs: 0 } } }); invalidateTypeSafeConfig();
    const file = join(workDir, 'lib.ts');
    writeFileSync(file, 'export function renamedThing() {}\n');
    const id = add('The helper is `oldThing` in lib.ts', { related_files: ['lib.ts'], file_checksums: { 'lib.ts': 'stale-hash' } });
    stubFetch();
    const noted = noteEdit({ sessionId: 'sess-5', cwd: workDir, project: 'coding-test', filePath: file, tool: 'Edit', oldExcerpt: 'function oldThing()', newExcerpt: 'function renamedThing()' });
    expect(noted).toEqual({ scheduled: true });
    await new Promise(r => setTimeout(r, 5));
    await flushEditChecks('sess-5');
    expect(requests).toHaveLength(1);
    expect(requests[0].state.file.current_content).toContain('renamedThing');
    const meta = getDb().prepare('SELECT stale_verdicts FROM memory_metadata WHERE memory_id=?').get(id) as any;
    expect(JSON.parse(meta.stale_verdicts)['lib.ts'].p).toBe(0.2);
    const [row] = readTypeSafeLog({ surface: 'edit-stale' });
    expect(row).toMatchObject({ origin: 'hook', session_id: 'sess-5', entity_id: id, outcome: { stale: true } });
    expect(takeStaleVerdicts('sess-5', { peek: true })).toHaveLength(1);
    const delivered = takeStaleVerdicts('sess-5');
    expect(delivered[0]).toMatchObject({ memory_id: id, file: 'lib.ts', probability: 0.2 });
    expect(takeStaleVerdicts('sess-5')).toHaveLength(0);
    const recall = await retrieveMemory({ query: 'oldThing helper lib.ts', project: 'coding-test', include_sessions: false }, async () => [1, 0, 0]);
    expect(recall.results.find(h => h.id === id)?.flags).toContain('judged stale');
    // Same file content and revision: not judged again.
    noteEdit({ sessionId: 'sess-5', cwd: workDir, project: 'coding-test', filePath: file, tool: 'Edit' });
    await new Promise(r => setTimeout(r, 5));
    await flushEditChecks('sess-5');
    expect(requests).toHaveLength(1);
  });
  it('schedules nothing with the kill switch, for denied files, or for files no memory lists', () => {
    registerProject('coding-test', workDir);
    killSwitch();
    const fn = stubFetch();
    expect(noteEdit({ sessionId: 's', cwd: workDir, filePath: join(workDir, 'a.ts') })).toEqual({ scheduled: false, reason: 'judgments-off' });
    delete process.env.SYNABUN_TYPESAFE; resetTypeSafeKey();
    expect(noteEdit({ sessionId: 's', cwd: workDir, filePath: join(workDir, '.env') })).toEqual({ scheduled: false, reason: 'denied-file' });
    expect(noteEdit({ sessionId: 's', cwd: workDir, filePath: join(workDir, 'nobody.ts') })).toEqual({ scheduled: false, reason: 'no-memories' });
    expect(noteEdit({ sessionId: 'bad id!', cwd: workDir, filePath: join(workDir, 'a.ts') })).toEqual({ scheduled: false, reason: 'invalid' });
    expect(apiCalls(fn)).toHaveLength(0);
  });
});

describe('source verification with project roots', () => {
  it('resolves relative paths against the registered root and honours a judged-accurate verdict', async () => {
    registerProject('coding-test', workDir);
    const file = join(workDir, 'cfg.json');
    writeFileSync(file, '{"a":1}');
    const hash = createHash('sha256').update('{"a":1}').digest('hex');
    const current = add('cfg.json holds a', { related_files: ['cfg.json'], file_checksums: { 'cfg.json': hash } });
    const d = getDb();
    await verifyMemorySources(d, current);
    expect((d.prepare('SELECT verification FROM memory_metadata WHERE memory_id=?').get(current) as any).verification).toBe('current');
    writeFileSync(file, '{"a":2}');
    await verifyMemorySources(d, current);
    expect((d.prepare('SELECT verification FROM memory_metadata WHERE memory_id=?').get(current) as any).verification).toBe('stale');
    const newHash = createHash('sha256').update('{"a":2}').digest('hex');
    d.prepare('UPDATE memory_metadata SET stale_verdicts=? WHERE memory_id=?').run(JSON.stringify({ 'cfg.json': { p: 0.9, hash: newHash, rev: 1, at: new Date().toISOString() } }), current);
    await verifyMemorySources(d, current);
    expect((d.prepare('SELECT verification FROM memory_metadata WHERE memory_id=?').get(current) as any).verification).toBe('current');
  });
  it('an unanchored or missing relative path is unknown, not stale', async () => {
    const orphan = add('rel path, no registry', { project: 'unregistered', related_files: ['x.ts'], file_checksums: { 'x.ts': 'h' } });
    await verifyMemorySources(getDb(), orphan);
    expect((getDb().prepare('SELECT verification FROM memory_metadata WHERE memory_id=?').get(orphan) as any).verification).toBe('unknown');
    registerProject('coding-test', workDir);
    const missing = add('missing file', { related_files: ['gone.ts'], file_checksums: { 'gone.ts': 'h' } });
    await verifyMemorySources(getDb(), missing);
    expect((getDb().prepare('SELECT verification FROM memory_metadata WHERE memory_id=?').get(missing) as any).verification).toBe('unknown');
  });
});

describe('compaction digest and plan conflicts', () => {
  it('labels messages in parallel batches and maps answers back to message indexes', async () => {
    stubFetch();
    const messages = Array.from({ length: 25 }, (_, i) => ({ i: i * 2, role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `message ${i}` }));
    const verdicts = await judgeCompactDigest(messages, { goal: 'ship it' });
    expect(requests).toHaveLength(2);
    expect(verdicts).toHaveLength(25);
    expect(verdicts![24]).toMatchObject({ i: 48, label: 'decision' });
    expect(requests[0].state.session_goal).toBe('ship it');
  });
  it('asks one contradiction question per decision and returns P(conflict) by id', async () => {
    scenario.conflict = (i: number) => (i === 1 ? 0.92 : 0.05);
    stubFetch();
    const verdicts = await judgePlanConflicts('Switch the store to Postgres.', [{ id: 'd0', content: 'Keep SQLite.' }, { id: 'd1', content: 'Never add a server database.' }]);
    expect(verdicts?.get('d1')).toBe(0.92);
    expect(verdicts?.get('d0')).toBe(0.05);
    expect(Object.keys(requests[0].questions)).toEqual(['conflict_0', 'conflict_1']);
  });
});

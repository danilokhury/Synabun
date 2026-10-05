import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../src/services/local-embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => [1, 0, 0]), EMBEDDING_VERSION: 'test:3',
  embedPassages: vi.fn(async (content: string) => [{ content, vector: [1, 0, 0] }]),
}));
import { getDb, closeDatabase, upsertMemory, memoryVectors, softDeleteMemory } from '../src/services/sqlite.js';
import { writeMemory } from '../src/services/memory-writer.js';
import { redactSecrets } from '../src/services/secret-gate.js';
import { judgeCategory, judgeStopTurn, judgeLoopGoal, judgeExpendability, judgeDuplicates } from '../src/services/memory-judgments.js';
import { triageMemories, findTriageCandidates, MAX_TRIAGE_LIMIT, type TriageResult } from '../src/services/memory-triage.js';
import { setRelation } from '../src/services/memory-maintenance.js';
import { retrieveMemory, resetPassageCache } from '../src/services/memory-retrieval.js';
import { handleRemember, categoryOptions } from '../src/tools/remember.js';
import { addCategory, categoryExists } from '../src/services/categories.js';
import { handleReflect } from '../src/tools/reflect.js';
import { handleSync, fileExcerpt } from '../src/tools/sync.js';
import { invalidateTypeSafeConfig, updateTypeSafeConfig } from '../src/services/typesafe-config.js';
import { resetTypeSafeKey, clearTypeSafeCache, resetTypeSafeMetrics, typesafeRetryAfterMs } from '../src/services/typesafe.js';
import type { MemoryPayload } from '../src/types.js';

/**
 * The nine Phase-5 surfaces. Every one is driven against a stubbed fetch that
 * answers by question id, so the shape handling and the thresholds are
 * exercised; the kill switch then proves each fallback path.
 */

const scenario = {
  duplicate: 0.1,
  secret: (value: string) => (value.startsWith('sk-') || value.startsWith('ghp_') ? 0.95 : 0.1),
  category: 'development', categoryConfidence: 0.8,
  accurate: 0.9, worth: 0.9, blocker: 0.1, waiting: 0.1, goal: 0.9, historical: 0.1,
  expendability: (_i: number) => 2,
};
const requests: Array<{ state: any; questions: Record<string, any> }> = [];
function stubFetch() {
  const fn = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const answers: Record<string, unknown> = {};
    for (const key of Object.keys(body.questions)) {
      const index = Number(key.split('_').pop());
      if (key.startsWith('duplicate_')) answers[key] = { type: 'noul', noul: scenario.duplicate };
      else if (key.startsWith('secret_')) answers[key] = { type: 'noul', noul: scenario.secret(body.state.spans[index].value) };
      else if (key === 'category') answers[key] = { type: 'choice', choice: scenario.category, confidence: scenario.categoryConfidence, probabilities: {} };
      else if (key === 'accurate') answers[key] = { type: 'noul', noul: scenario.accurate };
      else if (key === 'worth_remembering') answers[key] = { type: 'noul', noul: scenario.worth };
      else if (key === 'human_blocker') answers[key] = { type: 'noul', noul: scenario.blocker };
      else if (key === 'waiting_for_user') answers[key] = { type: 'noul', noul: scenario.waiting };
      else if (key === 'goal_met') answers[key] = { type: 'noul', noul: scenario.goal };
      else if (key.startsWith('expendability_')) answers[key] = { type: 'score', score: scenario.expendability(index), confidence: 0.7, legend: {}, probabilities: {} };
      else if (key.startsWith('relevance_')) answers[key] = { type: 'score', score: 3, confidence: 0.7, legend: {}, probabilities: {} };
      else if (key === 'importance') answers[key] = { type: 'score', score: 2, confidence: 0.7, legend: {}, probabilities: {} };
      else if (key === 'kind') answers[key] = { type: 'choice', choice: 'note', confidence: 0.7, probabilities: {} };
      else if (key === 'historical') answers[key] = { type: 'noul', noul: scenario.historical };
    }
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 50, output_tokens: 5 }, answers }) };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
const killSwitch = () => { process.env.SYNABUN_TYPESAFE = 'off'; };

function add(content: string, overrides: Partial<MemoryPayload> = {}, vector = [1, 0, 0]) {
  const id = randomUUID();
  upsertMemory(id, vector, { content, project: 'synabun', category: 'development', tags: [], importance: 5,
    source: 'self-discovered', created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
    accessed_at: '2026-09-01T00:00:00.000Z', access_count: 0, ...overrides });
  return id;
}
const stored = (id: string) => getDb().prepare('SELECT content,category,tags FROM memories WHERE id=?').get(id) as { content: string; category: string; tags: string };
const idOf = (response: any) => String(response.content[0].text).match(/\[([0-9a-f-]{36})\]/)![1];

beforeAll(() => getDb());
beforeEach(() => {
  getDb().exec('DELETE FROM memories; DELETE FROM memory_relations; DELETE FROM memory_metadata; DELETE FROM memory_revisions; DELETE FROM memory_jobs; DELETE FROM memory_passages; DELETE FROM kv_config; DELETE FROM typesafe_log;');
  memoryVectors.invalidate(); invalidateTypeSafeConfig();
  requests.length = 0;
  Object.assign(scenario, { duplicate: 0.1, category: 'development', categoryConfidence: 0.8, accurate: 0.9, worth: 0.9, blocker: 0.1, waiting: 0.1, goal: 0.9, historical: 0.1, expendability: () => 2 });
  delete process.env.SYNABUN_TYPESAFE; process.env.TYPESAFE_API_KEY = 'test-key'; process.env.DOTENV_PATH = '/nonexistent/.env';
  resetTypeSafeKey(); clearTypeSafeCache(); resetTypeSafeMetrics();
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.TYPESAFE_API_KEY; delete process.env.DOTENV_PATH; process.env.SYNABUN_TYPESAFE = 'off'; resetTypeSafeKey(); });
afterAll(() => closeDatabase());

const payload = (content: string): MemoryPayload => ({ content, project: 'synabun', category: 'development', tags: [], importance: 5, source: 'self-discovered',
  created_at: '2026-09-19T00:00:00.000Z', updated_at: '2026-09-19T00:00:00.000Z', accessed_at: '2026-09-19T00:00:00.000Z', access_count: 0 });

describe('duplicate gate (surface duplicate-gate)', () => {
  it('refuses a memory that restates a stored fact and points at it', async () => {
    const existing = add('The deploy uses WAL mode.');
    scenario.duplicate = 0.95;
    const fetchMock = stubFetch();
    const result = await writeMemory(payload('WAL mode is used for the deploy.'));
    expect(result).toEqual({ id: existing, existing: true, pending: false, duplicate: { probability: 0.95 } });
    expect(getDb().prepare('SELECT count(*) AS n FROM memories').get()?.n).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Object.keys(requests[0].questions)).toEqual(['duplicate_0']);
    expect(requests[0].state.candidates[0].content).toBe('The deploy uses WAL mode.');
  });
  it('stores when the judgment is not confident, and without a request when judgments are off', async () => {
    add('The deploy uses WAL mode.');
    scenario.duplicate = 0.4;
    stubFetch();
    const a = await writeMemory(payload('WAL mode is used for the deploy.'));
    expect(a.existing).toBe(false); expect(a.duplicate).toBeUndefined();
    killSwitch();
    const fetchMock = stubFetch();
    const b = await writeMemory(payload('WAL mode, again.'));
    expect(b.existing).toBe(false);
    // The only fetch allowed is the Neural Interface cache invalidation, never the API.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/v1/systemone'))).toHaveLength(0);
    expect(getDb().prepare('SELECT count(*) AS n FROM memories').get()?.n).toBe(3);
  });
  it('remember tells the caller which memory it duplicates', async () => {
    const existing = add('Use reflect to update an existing memory instead of storing twice.');
    scenario.duplicate = 0.91;
    stubFetch();
    const response = await handleRemember({ content: 'Instead of storing twice, update the existing memory with reflect.', category: 'development', project: 'synabun' });
    expect(response.content[0].text).toContain(`Not stored — duplicate of [${existing}] (P=0.91)`);
    expect(getDb().prepare('SELECT count(*) AS n FROM memories').get()?.n).toBe(1);
  });
  it('judgeDuplicates skips the request when there are no candidates', async () => {
    const fetchMock = stubFetch();
    await expect(judgeDuplicates('x', [])).resolves.toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('secret gate (surface secret-gate)', () => {
  const key = 'sk-live-abcdefghijklmnopqrstuvwxyz0123';
  it('redacts judged secrets and keeps values the judgment calls placeholders', async () => {
    stubFetch();
    const result = await redactSecrets(`The password: hunter2secret note and the key ${key} live in .env`);
    expect(result.text).toBe('The password: hunter2secret note and the key [redacted:api-key] live in .env');
    expect(result.redactions).toEqual([{ type: 'api-key', judged: true, probability: 0.95 }]);
    expect(result.judged).toBe(true); expect(result.refused).toBe(false);
    expect(requests[0].state.spans.map((s: any) => s.looks_like)).toEqual(['secret', 'api-key']);
    // Nothing secret leaves the machine: values are masked as spans and inside the text.
    const wire = JSON.stringify(requests[0]);
    expect(wire).not.toContain(key);
    expect(wire).not.toContain('hunter2secret');
    expect(requests[0].state.spans[1].value).toMatch(/^sk-l•+23 \(38 chars\)$/);
    expect(requests[0].state.text).toContain('sk-l');
    expect(requests[0].state.text).toContain('(38 chars)');
  });
  it('falls back to the precise patterns only when the judgment is unavailable', async () => {
    killSwitch(); stubFetch();
    const result = await redactSecrets(`password: hunter2secret and ${key}`);
    expect(result.text).toBe('password: hunter2secret and [redacted:api-key]');
    expect(result.judged).toBe(false);
  });
  it('refuses content that is nothing but a credential', async () => {
    killSwitch(); stubFetch();
    const result = await redactSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(result.refused).toBe(true);
    expect(await redactSecrets('nothing secret here')).toMatchObject({ refused: false, redactions: [] });
  });
  it('remember refuses a bare credential and tags a redacted one', async () => {
    stubFetch();
    const refused: any = await handleRemember({ content: `${key}`, category: 'development', project: 'synabun' });
    expect(refused.isError).toBe(true);
    expect(getDb().prepare('SELECT count(*) AS n FROM memories').get()?.n).toBe(0);
    const ok = await handleRemember({ content: `The CI token is ${key}, kept in the GitHub environment.`, category: 'development', project: 'synabun', tags: ['ci'] });
    expect(ok.content[0].text).toContain('redacted 1 credential-looking value');
    const row = stored(idOf(ok));
    expect(row.content).toBe('The CI token is [redacted:api-key], kept in the GitHub environment.');
    expect(JSON.parse(row.tags)).toEqual(['ci', 'redacted']);
    expect(getDb().prepare('SELECT count(*) AS n FROM typesafe_log WHERE state_preview LIKE ?').get(`%${key}%`)?.n).toBe(0);
  });
  it('reflect redacts content updates and embeds the redacted text', async () => {
    const id = add('old content');
    stubFetch();
    const response = await handleReflect({ memory_id: id, content: `new key ${key} for the api` });
    expect(response.content[0].text).toContain('redacted 1 credential-looking value');
    const row = stored(id);
    expect(row.content).toBe('new key [redacted:api-key] for the api');
    expect(JSON.parse(row.tags)).toContain('redacted');
  });
});

describe('category check (surface category-check)', () => {
  // A fresh data dir has no categories file; the check needs real leaves to choose from.
  beforeEach(() => {
    for (const [name, description] of [['development', 'Code changes, fixes and refactors.'], ['neural-interface', 'The Neural Interface UI, its settings and gotchas.'], ['conversations', 'Session summaries.']]) {
      if (!categoryExists(name)) addCategory(name, description);
    }
  });
  it('records the judged category and reports a disagreement without moving the memory', async () => {
    scenario.category = 'neural-interface'; scenario.categoryConfidence = 0.77;
    stubFetch();
    const response = await handleRemember({ content: 'Opening Settings never blocks on the MoreLogin probe because the tab is a shell.', category: 'development', project: 'synabun' });
    expect(response.content[0].text).toContain('category check: Jev suggests "neural-interface" (77%)');
    const id = idOf(response);
    expect(stored(id).category).toBe('development');
    expect(getDb().prepare('SELECT category_judged,category_confidence FROM memory_metadata WHERE memory_id=?').get(id)).toEqual({ category_judged: 'neural-interface', category_confidence: 0.77 });
    const request = requests.find(r => r.questions.category)!;
    expect(request.state.filed_under).toBe('development');
    expect(Object.keys(request.questions.category.criteria)).toEqual(expect.arrayContaining(['development', 'neural-interface', 'none-of-these']));
  });
  it('a no-match answer is reported but records nothing; agreement stays quiet', async () => {
    scenario.category = 'none-of-these';
    stubFetch();
    const a = await handleRemember({ content: 'A record that fits nowhere in particular.', category: 'development', project: 'synabun' });
    expect(a.content[0].text).toContain('no existing category fits well');
    expect(getDb().prepare('SELECT category_judged FROM memory_metadata WHERE memory_id=?').get(idOf(a))?.category_judged).toBeNull();
    scenario.category = 'development';
    const b = await handleRemember({ content: 'A record filed where the judgment agrees.', category: 'development', project: 'synabun' });
    expect(b.content[0].text).not.toContain('category check');
  });
  it('needs at least two options and includes the caller pick', async () => {
    const fetchMock = stubFetch();
    await expect(judgeCategory('x', 'a', { a: 'only one' })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Object.keys(categoryOptions('development'))).toContain('development');
    expect(categoryOptions('not-a-real-category')).toHaveProperty('not-a-real-category');
  });
});

describe('historical query (surface historical-query)', () => {
  const embed = async () => [1, 0, 0];
  it('is asked only when a superseded memory is among the candidates, and then decides whether it shows', async () => {
    resetPassageCache();
    const older = add('The score limit is 0.3.', { created_at: '2026-01-01T00:00:00.000Z' });
    const newer = add('The score limit is 0.4 now.', { created_at: '2026-02-01T00:00:00.000Z' });
    stubFetch();
    const plain = await retrieveMemory({ query: 'score limit', engine: 'hybrid', include_sessions: false }, embed);
    expect(plain.results.map(r => r.id).sort()).toEqual([older, newer].sort());
    expect(requests.filter(r => r.questions.historical)).toHaveLength(0);
    setRelation(newer, older, 'supersedes');
    // A Portuguese query the regex fallback would miss ("como era" has no keyword it knows).
    scenario.historical = 0.9;
    const past = await retrieveMemory({ query: 'como era o limite de score', engine: 'hybrid', include_sessions: false }, embed);
    expect(requests.filter(r => r.questions.historical)).toHaveLength(1);
    expect(past.results.map(r => r.id)).toContain(older);
    scenario.historical = 0.1; clearTypeSafeCache();
    const current = await retrieveMemory({ query: 'qual e o limite de score', engine: 'hybrid', include_sessions: false }, embed);
    expect(current.results.map(r => r.id)).toEqual([newer]);
    // Judgments off: the regex decides, and no request is made.
    killSwitch(); const fetchMock = stubFetch();
    const fallback = await retrieveMemory({ query: 'previous score limit', engine: 'hybrid', include_sessions: false }, embed);
    expect(fallback.results.map(r => r.id)).toContain(older);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/v1/systemone'))).toHaveLength(0);
  });
});

describe('stale check (surface stale-check)', () => {
  it('fileExcerpt bounds long files and keeps lines mentioning the memory\'s identifiers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'synabun-stale-'));
    const file = join(dir, 'big.ts');
    writeFileSync(file, 'x'.repeat(20_000) + '\nexport function computeChecksums() {}\n' + 'y'.repeat(5000));
    try {
      const excerpt = fileExcerpt(file, 'The `computeChecksums` helper hashes related files.')!;
      expect(excerpt.truncated).toBe(true);
      expect(excerpt.excerpt.length).toBeLessThan(8300);
      expect(excerpt.excerpt).toContain('computeChecksums');
      expect(fileExcerpt(join(dir, 'missing.ts'), 'x')).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('groups changed memories by whether the judgment says they still hold', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'synabun-sync-'));
    const file = join(dir, 'source.txt');
    writeFileSync(file, 'original file');
    const checksum = createHash('sha256').update('original file').digest('hex');
    add('The source file starts with the word original.', { related_files: [file], file_checksums: { [file]: checksum } });
    try {
      writeFileSync(file, 'original file, now with more');
      stubFetch();
      let text = (await handleSync({ project: 'synabun' })).content[0].text;
      expect(text).toContain('CHANGED BUT STILL ACCURATE (1)');
      expect(text).toContain('still accurate 90%');
      expect(requests.at(-1)!.state.file.current_content).toBe('original file, now with more');
      scenario.accurate = 0.2;
      clearTypeSafeCache();
      text = (await handleSync({ project: 'synabun' })).content[0].text;
      expect(text).toContain('STALE — judged no longer accurate (1)');
      killSwitch();
      text = (await handleSync({ project: 'synabun' })).content[0].text;
      expect(text).toContain('CHECKSUM CHANGED (1)');
      expect(text).not.toContain('judged');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('stop turn (surfaces agent-message + turn-worth)', () => {
  it('asks only the enabled questions and applies the worth threshold', async () => {
    stubFetch();
    const both = await judgeStopTurn({ message: 'Fixed the retry bug in the writer.', filesEdited: ['memory-writer.ts'], editCount: 2 }, { agentMessage: true, turnWorth: true });
    expect(both).toEqual({ humanBlocker: false, waitingForUser: false, worthRemembering: true, worthProbability: 0.9 });
    expect(Object.keys(requests[0].questions)).toEqual(['human_blocker', 'waiting_for_user', 'worth_remembering']);
    expect(requests[0].state).toMatchObject({ files_edited: ['memory-writer.ts'], edit_count: 2 });
    scenario.worth = 0.1;
    const trivial = await judgeStopTurn({ message: 'Fixed a typo.', filesEdited: ['README.md'], editCount: 1 }, { agentMessage: false, turnWorth: true });
    expect(trivial).toEqual({ worthRemembering: false, worthProbability: 0.1 });
    expect(Object.keys(requests[1].questions)).toEqual(['worth_remembering']);
    const fetchMock = stubFetch();
    await expect(judgeStopTurn({ message: 'x' }, { agentMessage: false, turnWorth: false })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('a disabled turn-worth surface leaves the blocker questions alone', async () => {
    updateTypeSafeConfig({ surfaces: { 'turn-worth': { enabled: false } } });
    stubFetch();
    const verdict = await judgeStopTurn({ message: 'Please log in to continue.' }, { agentMessage: true, turnWorth: false });
    expect(verdict).toEqual({ humanBlocker: false, waitingForUser: false });
  });
});

describe('loop goal (surface loop-goal)', () => {
  it('returns P(goal met) from the journal and refuses to judge without a task', async () => {
    const fetchMock = stubFetch();
    const p = await judgeLoopGoal({ task: 'Post the deal to all five groups.', journal: [{ iteration: 1, summary: 'posted to 3 groups' }, { iteration: 2, summary: 'posted to the last 2' }], lastMessage: 'All five groups have the post.', iteration: 2, total: 10 });
    expect(p).toBe(0.9);
    expect(requests[0].state).toMatchObject({ iterations_done: 2, iterations_total: 10 });
    expect(requests[0].state.journal).toHaveLength(2);
    await expect(judgeLoopGoal({ task: '  ', lastMessage: 'x', iteration: 1, total: 2 })).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    killSwitch();
    await expect(judgeLoopGoal({ task: 'anything', lastMessage: 'x', iteration: 1, total: 2 })).resolves.toBeNull();
  });
});

describe('trash triage (surface trash-triage)', () => {
  function seed() {
    const old = add('an old passing note nobody recalled', { importance: 2, created_at: '2025-01-01T00:00:00.000Z' });
    const original = add('the same fact stated once', { created_at: '2026-01-01T00:00:00.000Z' });
    const copy = add('the same fact stated once', { created_at: '2026-02-01T00:00:00.000Z' });
    const hash = createHash('sha256').update('the same fact stated once').digest('hex');
    for (const id of [original, copy]) getDb().prepare("INSERT INTO memory_metadata(memory_id,kind,content_hash) VALUES(?,'note',?)").run(id, hash);
    const canonical = add('a judged canonical record', { created_at: '2026-03-01T00:00:00.000Z' });
    const judgedDup = add('a judged duplicate record', { created_at: '2026-04-01T00:00:00.000Z' });
    setRelation(judgedDup, canonical, 'duplicate_of', true);
    const keeper = add('a recent important decision', { importance: 8 });
    return { old, original, copy, canonical, judgedDup, keeper };
  }
  it('finds candidates from exact copies, judged duplicates and old low-importance rows', () => {
    const ids = seed();
    const found = findTriageCandidates({});
    const byId = new Map(found.map(c => [c.id, c]));
    expect(byId.get(ids.copy)?.reasons[0]).toMatch(/exact copy of/);
    expect(byId.get(ids.judgedDup)?.reasons[0]).toMatch(/judged duplicate of/);
    expect(byId.get(ids.old)?.reasons[0]).toMatch(/never recalled/);
    for (const id of [ids.original, ids.canonical, ids.keeper]) expect(byId.has(id)).toBe(false);
  });
  it('ranks by judged expendability in batches, and by local signals when judgments are off', async () => {
    const ids = seed();
    scenario.expendability = (i) => [4, 1, 3][i] ?? 2;
    const fetchMock = stubFetch();
    const judged = await triageMemories({ limit: 20 });
    expect(judged.judged).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Object.keys(requests[0].questions)).toHaveLength(3);
    // The state and question wording the bench was calibrated on, unchanged.
    expect(Object.keys(requests[0].state.candidates[0])).toEqual(['content', 'category', 'importance', 'created_at', 'times_recalled', 'duplicate_of_another']);
    expect(JSON.stringify(requests[0].questions.expendability_0)).toContain('How expendable is `candidates[0]`: how much would be lost if it were deleted from this knowledge base? Weigh its content, whether `candidates[0].duplicate_of_another` names a surviving copy, and how often it has been recalled.');
    expect(judged.rows.map(r => r.expendability)).toEqual([4, 3, 1]);
    expect(judged.rows[0].level).toBe('Expendable');
    expect(judged.rows.every(r => !('content' in r))).toBe(true);
    expect([judged.pending, judged.saved]).toEqual([0, 0]);
    killSwitch();
    const fallback = await triageMemories({ limit: 2 });
    expect(fallback.judged).toBe(false);
    expect(fallback.rows).toHaveLength(2);
    expect(fallback.rows.every(r => r.expendability === null)).toBe(true);
    expect(fallback.rows.map(r => r.id)).toContain(ids.old);
  });

  const oldNotes = (n: number) => Array.from({ length: n }, (_, i) => add(`old note ${i}`, { importance: 2, created_at: new Date(Date.UTC(2025, 0, 1 + i)).toISOString() }));
  const failing = (answer: ReturnType<typeof stubFetch>, firstContent: string, status: number, retryAfter: string | null = null) => {
    let inFlight = 0;
    const mock = Object.assign(vi.fn(async (url: string, init: RequestInit) => {
      inFlight++; mock.peak = Math.max(mock.peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 20));
      inFlight--;
      if (JSON.parse(String(init.body)).state.candidates[0].content === firstContent) {
        return { ok: false, status, headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) }, json: async () => ({}) };
      }
      return answer(url, init);
    }), { peak: 0 });
    vi.stubGlobal('fetch', mock);
    return mock;
  };
  it('judges every batch at once, and a failed batch costs only its own candidates', async () => {
    const ids = oldNotes(25);
    const fetchMock = failing(stubFetch(), 'old note 10', 500);
    const result = await triageMemories({ limit: 30 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.peak).toBe(3);
    expect(result.judged).toBe(true);
    expect(result.rows).toHaveLength(25);
    expect(result.rows.slice(0, 15).every(r => r.expendability === 2)).toBe(true);
    expect(result.rows.slice(15).map(r => r.id)).toEqual(ids.slice(10, 20));
    expect(result.rows.slice(15).every(r => r.expendability === null)).toBe(true);
  });
  it('keeps the scores it got when a batch hits a 429, and sends nothing while retry-after holds', async () => {
    oldNotes(15);
    const fetchMock = failing(stubFetch(), 'old note 10', 429, '60');
    const first = await triageMemories({ limit: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.judged).toBe(true);
    expect(first.rows.filter(r => r.expendability !== null)).toHaveLength(10);
    expect(typesafeRetryAfterMs()).toBeGreaterThan(50_000);
    clearTypeSafeCache();
    const second = await triageMemories({ limit: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.judged).toBe(false);
  });
  it('reuses a stored score until what would be judged changes', async () => {
    const meta = (id: string, hash: string | null = null) => getDb().prepare('INSERT INTO memory_metadata(memory_id,content_hash) VALUES(?,?)').run(id, hash);
    const old = add('an old passing note nobody recalled', { importance: 2, created_at: '2025-01-01T00:00:00.000Z' });
    meta(old);
    const hash = createHash('sha256').update('the same fact stated thrice').digest('hex');
    const [first, second, third] = ['2026-01-01', '2026-02-01', '2026-03-01'].map(day => add('the same fact stated thrice', { created_at: `${day}T00:00:00.000Z` }));
    for (const id of [first, second, third]) meta(id, hash);
    const fetchMock = stubFetch();
    const initial = await triageMemories({ limit: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(initial.rows.map(r => r.id).sort()).toEqual([old, second, third].sort());
    expect(getDb().prepare('SELECT count(*) AS n FROM memory_metadata WHERE expendability IS NOT NULL AND expendability_basis IS NOT NULL').get()?.n).toBe(3);
    clearTypeSafeCache();
    const repeat = await triageMemories({ limit: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([repeat.judged, repeat.saved]).toEqual([true, 3]);
    expect(repeat.rows.map(r => [r.id, r.expendability])).toEqual(initial.rows.map(r => [r.id, r.expendability]));
    // An edit changes what would be sent: only that row is asked again.
    upsertMemory(old, [1, 0, 0], { content: 'an old passing note, edited', project: 'synabun', category: 'development', tags: [], importance: 2, source: 'self-discovered',
      created_at: '2025-01-01T00:00:00.000Z', updated_at: '2026-09-19T00:00:00.000Z', accessed_at: '2025-01-01T00:00:00.000Z', access_count: 0 });
    clearTypeSafeCache();
    const edited = await triageMemories({ limit: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests[1].state.candidates.map((c: any) => c.content)).toEqual(['an old passing note, edited']);
    expect(edited.saved).toBe(2);
    // Trashing the oldest copy moves the third's surviving copy: asked again.
    await softDeleteMemory(first);
    clearTypeSafeCache();
    await triageMemories({ limit: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requests[2].state.candidates.map((c: any) => c.duplicate_of_another)).toEqual([second]);
    // A week-old score is asked again.
    getDb().prepare("UPDATE memory_metadata SET expendability_at='2026-01-01T00:00:00.000Z' WHERE memory_id=?").run(old);
    clearTypeSafeCache();
    await triageMemories({ limit: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(requests[3].state.candidates.map((c: any) => c.content)).toEqual(['an old passing note, edited']);
    // A disabled surface ignores stored scores entirely.
    updateTypeSafeConfig({ surfaces: { 'trash-triage': { enabled: false } } });
    const off = await triageMemories({ limit: 20 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect([off.judged, off.saved, off.rows.every(r => r.expendability === null)]).toEqual([false, 0, true]);
  });
  it('judges a memory without a metadata row but does not store it', async () => {
    const [bare] = oldNotes(1);
    const fetchMock = stubFetch();
    expect((await triageMemories({ limit: 5 })).rows.map(r => [r.id, r.expendability])).toEqual([[bare, 2]]);
    expect(getDb().prepare('SELECT count(*) AS n FROM memory_metadata').get()?.n).toBe(0);
    clearTypeSafeCache();
    await triageMemories({ limit: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('judges and returns every candidate it finds, without over-fetching', async () => {
    oldNotes(25);
    const fetchMock = stubFetch();
    const capped = await triageMemories({ limit: 15 });
    // limit means consider-and-show: 15 discovered, 15 judged (10 + 5), 15 returned.
    expect(capped.rows).toHaveLength(15);
    expect(capped.candidates).toBe(15);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests.flatMap(r => Object.keys(r.questions))).toHaveLength(15);
    expect(capped.rows.every(r => r.expendability === 2)).toBe(true);
    expect(findTriageCandidates({ limit: 15 })).toHaveLength(15);
    expect(MAX_TRIAGE_LIMIT).toBe(2000);
    clearTypeSafeCache();
    const all = await triageMemories({ limit: 99_999 });
    expect(all.rows).toHaveLength(25);
    expect(all.candidates).toBe(25);
  });
  it('keeps progress snapshots small while the finished answer carries every row', async () => {
    oldNotes(60);
    stubFetch();
    const snapshots: TriageResult[] = [];
    const result = await triageMemories({ limit: 100, onProgress: s => snapshots.push(s) });
    expect(result.rows).toHaveLength(60);
    expect(snapshots.length).toBeGreaterThan(1);
    expect(snapshots.every(s => s.rows.length <= 50)).toBe(true);
    expect(snapshots.every(s => s.candidates === 60)).toBe(true);
  });
  it('reports the ranking as batches land, and a failing listener never stops the judging', async () => {
    oldNotes(25);
    stubFetch();
    const snapshots: TriageResult[] = [];
    const result = await triageMemories({ limit: 30, onProgress: s => snapshots.push(s) });
    expect(snapshots[0].pending).toBe(25);
    expect(snapshots.every((s, i) => s.pending > 0 && (i === 0 || s.pending < snapshots[i - 1].pending))).toBe(true);
    expect(snapshots.every(s => s.rows.length === 25)).toBe(true);
    expect([result.pending, result.judged, result.rows.every(r => r.expendability === 2)]).toEqual([0, true, true]);
    clearTypeSafeCache();
    const throwing = await triageMemories({ limit: 30, onProgress: () => { throw new Error('stream closed'); } });
    expect(throwing.rows.every(r => r.expendability === 2)).toBe(true);
  });
  it('judgeExpendability returns null on a wrong-typed answer set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ answers: { expendability_0: { type: 'noul', noul: 0.5 } } }) })));
    await expect(judgeExpendability([{ id: 'a', content: 'x', category: 'c', importance: 5, createdAt: '2026-01-01', accessCount: 0 }])).resolves.toBeNull();
  });
});

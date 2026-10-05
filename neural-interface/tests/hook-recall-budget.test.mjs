import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Never let an exported TYPESAFE_API_KEY turn this into a paid API call.
process.env.SYNABUN_TYPESAFE = 'off';
// Surface settings are read from kv_config; point any store this suite opens
// at a temp dir so it can never migrate the live one.
const storeDir = mkdtempSync(join(tmpdir(), 'synabun-hook-recall-'));
process.env.SQLITE_DB_PATH = join(storeDir, 'memory.db');
process.env.MEMORY_DATA_DIR = storeDir;
process.env.SYNABUN_DATA_HOME = storeDir;
const { hookRecall } = await import('../lib/memory-api.js');

test('hook recall keeps its default and admits 1200-token briefs up to a 2000-token ceiling', async () => {
  const results = Array.from({ length: 8 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, revision: 1,
    type: 'memory', score: 0.9, category: 'hooks', project: 'synabun', source: 'self-discovered',
    content: `Hook fix ${i}. ` + 'Preserve canonical handlers and exact file paths. '.repeat(12),
    created_at: '2026-09-15', flags: [], payload: { tags: ['hooks'], importance: 7, related_files: ['lib/claude-hooks.js'] },
  }));
  const retrieve = async () => ({ results, engine: 'hybrid', degraded: [] });
  const query = { query: 'hook fix', limit: 8 };
  const normal = await hookRecall(query, retrieve);
  const richer = await hookRecall({ ...query, token_budget: 1200 }, retrieve);
  const maximum = await hookRecall({ ...query, token_budget: 2000 }, retrieve);
  const capped = await hookRecall({ ...query, token_budget: 9000 }, retrieve);
  assert.ok(normal.estimated_tokens <= 600);
  assert.ok(richer.estimated_tokens > 600 && richer.estimated_tokens <= 1200);
  assert.ok(richer.results.length > normal.results.length);
  assert.ok(maximum.estimated_tokens <= 2000);
  assert.equal(capped.context, maximum.context);
  const dedup = { ...query, token_budget: 1200, caller: 'task-budget-test', session: 'one', context_generation: 'one' };
  const first = await hookRecall(dedup, async () => ({ results: results.slice(0, 1), engine: 'hybrid', degraded: [] }));
  const second = await hookRecall(dedup, async () => ({ results: results.slice(0, 1), engine: 'hybrid', degraded: [] }));
  assert.equal(first.results.length, 1); assert.equal(second.already_present, true); assert.equal(second.context, '');
});

test('rank widens the shortlist, cuts back to the limit, and reports ranked=false while judgments are off', async () => {
  const results = Array.from({ length: 8 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, revision: 1,
    type: 'memory', score: 0.9 - i / 100, category: 'hooks', project: 'synabun', source: 'self-discovered',
    content: `Worker brief ${i}.`, created_at: '2026-09-15', flags: [], reasons: [], payload: { tags: [], importance: 5, related_files: [] },
  }));
  let seen;
  const retrieve = async (opts) => { seen = opts; return { results, engine: 'hybrid', degraded: [] }; };
  const ranked = await hookRecall({ query: 'worker task', limit: 3, rank: true, rank_timeout_ms: 900, token_budget: 2000 }, retrieve);
  assert.equal(seen.limit, 10);
  assert.equal(ranked.ranked, false);
  assert.ok(ranked.results.length <= 3);
  assert.deepEqual(ranked.results.map(r => r.id), results.slice(0, 3).map(r => r.id));
  const plain = await hookRecall({ query: 'worker task', limit: 3, token_budget: 2000 }, retrieve);
  assert.equal(seen.limit, 3);
  assert.equal(plain.ranked, false);
});

test('with judgments on, ranking orders the brief, the floor drops what does not help, and the outcome is logged', async (t) => {
  const { resetTypeSafeKey, clearTypeSafeCache } = await import('../../mcp-server/dist/services/typesafe.js');
  const { readTypeSafeLog, invalidateTypeSafeConfig } = await import('../../mcp-server/dist/services/typesafe-config.js');
  const shellKey = process.env.TYPESAFE_API_KEY;
  delete process.env.SYNABUN_TYPESAFE; process.env.TYPESAFE_API_KEY = 'test-key'; process.env.DOTENV_PATH = join(storeDir, 'none.env');
  resetTypeSafeKey(); clearTypeSafeCache(); invalidateTypeSafeConfig();
  const realFetch = globalThis.fetch;
  const requests = [];
  let scores = [0.5, 3.5, 1, 4];
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('/v1/systemone')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    requests.push(body);
    const answers = {};
    for (const key of Object.keys(body.questions)) {
      const i = Number(key.split('_').pop());
      answers[key] = { type: 'score', score: scores[i], confidence: 0.8, legend: {}, probabilities: {} };
    }
    return new Response(JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 0 }, answers }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => {
    globalThis.fetch = realFetch; process.env.SYNABUN_TYPESAFE = 'off';
    if (shellKey) process.env.TYPESAFE_API_KEY = shellKey; else delete process.env.TYPESAFE_API_KEY;
    delete process.env.DOTENV_PATH; resetTypeSafeKey();
  });
  const results = Array.from({ length: 4 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`, revision: 1,
    type: 'memory', score: 0.9 - i / 100, category: 'hooks', project: 'synabun', source: 'self-discovered',
    content: `Parser note ${i}: ` + 'the parser reads config from the project root. '.repeat(40), created_at: '2026-09-15', flags: [], reasons: [],
    payload: { tags: [], importance: 5, related_files: [] },
  }));
  const ids = results.map(r => r.id);
  const retrieve = async () => ({ results, engine: 'hybrid', degraded: [] });
  const out = await hookRecall({ query: 'how is the parser configured', limit: 3, surface: 'rerank', floor: true, session_id: 'sess-hr', project: 'synabun', token_budget: 2000 }, retrieve);
  assert.equal(out.ranked, true);
  assert.equal(out.rank_surface, 'rerank');
  assert.equal(out.floor, 1.5);
  assert.deepEqual(out.dropped.map(d => d.id).sort(), [ids[0], ids[2]].sort());
  assert.deepEqual(out.results.map(r => r.id), [ids[3], ids[1]]);
  assert.equal(out.results[0].relevance_level, 'Decisive');
  // The judge saw excerpts, not whole memories.
  for (const c of requests[0].state.candidates) assert.ok(c.content.length <= 1100);
  const [row] = readTypeSafeLog({ surface: 'rerank', sessionId: 'sess-hr' });
  assert.equal(row.origin, 'hook');
  assert.equal(row.project, 'synabun');
  assert.deepEqual(row.outcome.injected, [ids[3], ids[1]]);
  assert.deepEqual(row.outcome.dropped.sort(), [ids[0], ids[2]].sort());
  // A short follow-up is judged instead of regex-skipped, and nothing relevant means nothing injected.
  scores = [0, 0.4, 1, 0.2];
  const follow = await hookRecall({ query: 'make that better instead', limit: 3, surface: 'rerank', floor: true, session_id: 'sess-hr', token_budget: 2000 }, retrieve);
  assert.notEqual(follow.skipped, 'referential-followup');
  assert.equal(follow.skipped, 'judged-irrelevant');
  assert.equal(follow.context, '');
  // judge:false: no request, and the follow-up regex is back in charge.
  const before = requests.length;
  const off = await hookRecall({ query: 'make that better instead', limit: 3, surface: 'rerank', floor: true, judge: false, token_budget: 2000 }, retrieve);
  assert.equal(off.skipped, 'referential-followup');
  assert.equal(requests.length, before);
});

// Judgments on against a stubbed API; every question answers with its candidate's score.
async function withStubbedJudge(t, scoreOf, { status = 200 } = {}) {
  const { resetTypeSafeKey, clearTypeSafeCache } = await import('../../mcp-server/dist/services/typesafe.js');
  const { invalidateTypeSafeConfig } = await import('../../mcp-server/dist/services/typesafe-config.js');
  const shellKey = process.env.TYPESAFE_API_KEY;
  delete process.env.SYNABUN_TYPESAFE; process.env.TYPESAFE_API_KEY = 'test-key'; process.env.DOTENV_PATH = join(storeDir, 'none.env');
  resetTypeSafeKey(); clearTypeSafeCache(); invalidateTypeSafeConfig();
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('/v1/systemone')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    requests.push(body);
    if (status !== 200) return new Response('{}', { status, headers: { 'content-type': 'application/json' } });
    const answers = {};
    for (const key of Object.keys(body.questions)) answers[key] = { type: 'score', score: scoreOf(Number(key.split('_').pop())), confidence: 0.8, legend: {}, probabilities: {} };
    return new Response(JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 0 }, answers }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => {
    globalThis.fetch = realFetch; process.env.SYNABUN_TYPESAFE = 'off';
    if (shellKey) process.env.TYPESAFE_API_KEY = shellKey; else delete process.env.TYPESAFE_API_KEY;
    delete process.env.DOTENV_PATH; resetTypeSafeKey(); clearTypeSafeCache();
  });
  return requests;
}
const noteRows = (base, n = 4) => Array.from({ length: n }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(base + i).padStart(12, '0')}`, revision: 1,
  type: 'memory', score: 0.9 - i / 100, category: 'hooks', project: 'synabun', source: 'self-discovered',
  content: `Parser note ${i}: ` + 'the parser reads config from the project root. '.repeat(40), created_at: '2026-09-15', flags: [], reasons: [],
  payload: { tags: [], importance: 5, related_files: [] },
}));

test('deferred (assistant): finish(null) withholds and commits nothing; finish(tier) renders that tier and commits; rows say origin assistant', async (t) => {
  const { readTypeSafeLog } = await import('../../mcp-server/dist/services/typesafe-config.js');
  await withStubbedJudge(t, (i) => [3, 2.5, 3.5, 2][i]);
  const results = noteRows(200);
  const retrieve = async () => ({ results, engine: 'hybrid', degraded: [] });
  const body = { query: 'how is the parser configured', limit: 5, min_score: 0.4, token_budget: 900, format: 'compact', caller: 'assistant', session: 'assistant-s1', context_generation: 1, surface: 'rerank', floor: true, budget_ms: 2500 };
  const first = await hookRecall(body, retrieve, { origin: 'assistant', defer: true });
  assert.equal(first.deferred, true);
  assert.equal(first.ranked, true);
  assert.equal(first.candidates, 4);
  assert.equal(first.context, undefined, 'nothing is rendered before finish');
  const withheld = first.finish(null);
  assert.equal(withheld.context, '');
  assert.deepEqual(withheld.results, []);
  assert.equal(withheld.withheld, 'prompt-urgency');
  assert.equal(first.finish({ limit: 2, tokenBudget: 400 }), withheld, 'finish runs once');
  const [row] = readTypeSafeLog({ surface: 'rerank', sessionId: 'assistant-s1' });
  assert.equal(row.origin, 'assistant');
  assert.equal(row.outcome.withheld, 'prompt-urgency');
  assert.deepEqual(row.outcome.injected, []);
  assert.equal(row.outcome.candidates.length, 4);
  // Nothing was committed, so the next turn is not told they were already supplied.
  const second = await hookRecall(body, retrieve, { origin: 'assistant', defer: true });
  assert.equal(second.already_present, false);
  assert.equal(second.candidates, 4);
  const out = second.finish({ name: 'consider', limit: 2, tokenBudget: 400 });
  assert.ok(out.results.length >= 1 && out.results.length <= 2, `${out.results.length} results`);
  assert.ok(out.estimated_tokens <= 400);
  assert.equal(out.results[0].id, results[2].id, 'judged order: the most relevant first');
  const [latest] = readTypeSafeLog({ surface: 'rerank', sessionId: 'assistant-s1' });
  assert.equal(latest.outcome.tier, 'consider');
  assert.deepEqual(latest.outcome.injected, out.results.map((r) => r.id));
  // Committed: those memories are filtered out for the same identity now.
  const third = await hookRecall(body, retrieve, { origin: 'assistant', defer: true });
  assert.equal(third.candidates, 4 - out.results.length);
  third.finish(null);
});

test('the classic path is untouched by the options, and a failed ranking falls back to fusion order instead of throwing', async (t) => {
  const requests = await withStubbedJudge(t, () => 3, { status: 500 });
  const results = noteRows(300);
  const retrieve = async () => ({ results, engine: 'hybrid', degraded: [] });
  const out = await hookRecall({ query: 'how is the parser configured', limit: 3, surface: 'rerank', floor: true, session_id: 'sess-fail', token_budget: 2000 }, retrieve);
  assert.equal(requests.length, 1, 'the ranking was asked');
  assert.equal(out.ranked, false);
  assert.equal(out.deferred, undefined);
  assert.deepEqual(out.results.map((r) => r.id), results.slice(0, 3).map((r) => r.id), 'fusion order');
  assert.ok(out.context.length > 0);
});

test('end to end (dist judgments, stubbed API): the assistant recall gate logs urgency and rerank under origin assistant', async (t) => {
  const { resetTypeSafeKey, clearTypeSafeCache, typesafeEnabled, typesafeRetryAfterMs } = await import('../../mcp-server/dist/services/typesafe.js');
  const { invalidateTypeSafeConfig, readTypeSafeLog, surfaceConfig, annotateTypeSafeLog } = await import('../../mcp-server/dist/services/typesafe-config.js');
  const { judgePrompt } = await import('../../mcp-server/dist/services/memory-judgments.js');
  const { createAssistantJev } = await import('../lib/assistant-jev.js');
  const { createAssistantMemory } = await import('../lib/assistant-memory.js');
  const shellKey = process.env.TYPESAFE_API_KEY;
  delete process.env.SYNABUN_TYPESAFE; process.env.TYPESAFE_API_KEY = 'test-key'; process.env.DOTENV_PATH = join(storeDir, 'none.env');
  resetTypeSafeKey(); clearTypeSafeCache(); invalidateTypeSafeConfig();
  const realFetch = globalThis.fetch;
  let urgency = 'must';
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('/v1/systemone')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    const answers = {};
    for (const key of Object.keys(body.questions)) {
      answers[key] = key === 'urgency' ? { type: 'choice', choice: urgency, confidence: 0.9, probabilities: {} }
        : { type: 'score', score: 3, confidence: 0.8, legend: {}, probabilities: {} };
    }
    return new Response(JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 0 }, answers }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => {
    globalThis.fetch = realFetch; process.env.SYNABUN_TYPESAFE = 'off';
    if (shellKey) process.env.TYPESAFE_API_KEY = shellKey; else delete process.env.TYPESAFE_API_KEY;
    delete process.env.DOTENV_PATH; resetTypeSafeKey(); clearTypeSafeCache();
  });
  // Short memories, so the tier's limit (not its token budget) is what binds.
  const results = noteRows(400, 6).map((row, i) => ({ ...row, content: `Parser note ${i}: config is read from the project root.` }));
  const retrieve = async () => ({ results, engine: 'hybrid', degraded: [] });
  const judge = createAssistantJev({ judgePrompt, surfaceConfig, enabled: typesafeEnabled, retryAfterMs: typesafeRetryAfterMs, annotate: annotateTypeSafeLog });
  const memory = createAssistantMemory({ hookRecall: (body, _retrieve, options) => hookRecall(body, retrieve, options), judge });
  const out = await memory.recallForPrompt({ prompt: 'What did we decide about the parser config last week?', project: 'synabun', session: 'assistant-e2e', generation: 1 });
  assert.equal(out.decision, 'must');
  assert.equal(out.results.length, 5, 'must: limit + 2');
  assert.match(out.block, /\[ranked by Jev\]/);
  assert.match(out.block, /call recall with a focused query/);
  const [urgencyRow] = readTypeSafeLog({ surface: 'prompt-urgency', sessionId: 'assistant-e2e' });
  const [rankRow] = readTypeSafeLog({ surface: 'rerank', sessionId: 'assistant-e2e' });
  assert.equal(urgencyRow.origin, 'assistant');
  assert.equal(urgencyRow.project, 'synabun');
  assert.deepEqual(urgencyRow.outcome, { decision: 'must', fallback: false, tier: 'must', injected: out.results.map((r) => r.id) });
  assert.equal(rankRow.origin, 'assistant');
  assert.equal(rankRow.outcome.tier, 'must');
  // A judged skip: nothing is injected, the recall is withheld (rerank row) and nothing is committed.
  urgency = 'skip';
  const skipped = await memory.recallForPrompt({ prompt: 'Write a haiku about the parser in autumn', project: 'synabun', session: 'assistant-e2e', generation: 2 });
  assert.equal(skipped.skipped, 'judged');
  await new Promise((r) => setTimeout(r, 50));
  const rows = readTypeSafeLog({ surface: 'rerank', sessionId: 'assistant-e2e' });
  assert.ok(rows.some((row) => row.outcome?.withheld === 'prompt-urgency'), 'the background recall was withheld');
});

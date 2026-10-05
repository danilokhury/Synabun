import test from 'node:test';
import assert from 'node:assert/strict';
// Never let an exported TYPESAFE_API_KEY turn this into a paid API call.
process.env.SYNABUN_TYPESAFE = 'off';
const {
  createAssistantMemory,
  formatMemoryBlock,
  shouldSkipRecall,
  MEMORY_BLOCK_START,
  ALREADY_PRESENT_LINE,
} = await import('../lib/assistant-memory.js');

test('shouldSkipRecall mirrors the hook skip patterns', () => {
  assert.equal(shouldSkipRecall('ok'), true);
  assert.equal(shouldSkipRecall('/dispatch codex do it'), true);
  assert.equal(shouldSkipRecall('[SynaBun Mailbox] 2 events'), true);
  assert.equal(shouldSkipRecall('Refactor the hooks so they load faster'), false);
  // Ack / command / "open file" rules only describe short messages.
  assert.equal(shouldSkipRecall('run the tests'), true);
  assert.equal(shouldSkipRecall('open src/app.ts'), true);
  assert.equal(shouldSkipRecall('Run a live acceptance test of the Jev changes shipped on 2026-09-24 and report every result'), false);
  assert.equal(shouldSkipRecall('No, the bug is in the parser because the tokenizer drops the trailing quote'), false);
  assert.equal(shouldSkipRecall('Next, refactor the auth module\nand keep the old API'), false);
  assert.equal(shouldSkipRecall('check the whole flow again, especially the retry path in src/app.ts'), false);
});

test('formatMemoryBlock renders compact context, already-present and empty cases', () => {
  assert.equal(formatMemoryBlock({ results: [] }), '');
  assert.equal(formatMemoryBlock({ already_present: true, results: [] }), ALREADY_PRESENT_LINE);
  const block = formatMemoryBlock({ results: [{ id: 'a', category: 'development', importance: 6, score: 0.8, content: 'X', tags: ['t'] }], context: '[a] X' });
  assert.ok(block.startsWith(MEMORY_BLOCK_START));
  assert.match(block, /\[a\] X/);
});

test('recallForPrompt forwards identity and budget, and skips trivial prompts', async () => {
  const calls = [];
  const memory = createAssistantMemory({
    hookRecall: async (body) => { calls.push(body); return { results: [{ id: 'm1', category: 'dev', importance: 5, score: 0.9, content: 'C', tags: [] }], context: '[m1] C' }; },
    config: { tokenBudget: 400 },
  });
  const skipped = await memory.recallForPrompt({ prompt: 'thanks', session: 'assistant-1', generation: 1 });
  assert.equal(skipped.skipped, 'trivial', 'the free pre-filter (prompt-origin.mjs) runs first');
  const recalled = await memory.recallForPrompt({ prompt: 'How does the hook system work?', project: 'synabun', session: 'assistant-1', generation: 2 });
  assert.match(recalled.block, /\[m1\] C/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].caller, 'assistant');
  assert.equal(calls[0].session, 'assistant-1');
  assert.equal(calls[0].context_generation, 2);
  assert.equal(calls[0].token_budget, 400);
  assert.equal(calls[0].project, 'synabun');
  // Without a judge the old skip regex still decides, before any search.
  const regex = await memory.recallForPrompt({ prompt: 'run the linter over the whole repository please', session: 'assistant-1', generation: 2 });
  assert.equal(regex.skipped, 'pattern');
  assert.equal(calls.length, 1);
});

test('claudeHooks inject recall, bump generation on compaction, and nudge once per turn', async () => {
  const memory = createAssistantMemory({
    hookRecall: async () => ({ results: [{ id: 'm2', category: 'dev', importance: 5, score: 0.7, content: 'Z', tags: [] }], context: '[m2] Z' }),
  });
  let generation = 1;
  let remembered = 0;
  let pending = true;
  const hooks = memory.claudeHooks({
    session: 'assistant-9', project: 'p',
    getGeneration: () => generation, bumpGeneration: () => { generation += 1; },
    markRemembered: () => { remembered += 1; }, hasPendingObligations: () => pending,
  });
  const prompt = await hooks.UserPromptSubmit[0].hooks[0]({ prompt: 'Explain the loop runtime design' });
  assert.match(prompt.hookSpecificOutput.additionalContext, /\[m2\] Z/);
  await hooks.PreCompact[0].hooks[0]({});
  assert.equal(generation, 2);
  await hooks.PostToolUse[0].hooks[0]({});
  assert.equal(remembered, 1);
  const first = await hooks.Stop[0].hooks[0]({ stop_hook_active: false });
  assert.equal(first.decision, 'block');
  const second = await hooks.Stop[0].hooks[0]({ stop_hook_active: false });
  assert.deepEqual(second, {}, 'nudges at most once per turn');
  pending = false;
  await hooks.UserPromptSubmit[0].hooks[0]({ prompt: 'ok' });
  const third = await hooks.Stop[0].hooks[0]({ stop_hook_active: false });
  assert.deepEqual(third, {}, 'no nudge without pending obligations');
});

test('rememberDispatch stores one memory per run with contract fields and honors existing worker memories', async () => {
  const stored = [];
  const ensured = [];
  const memory = createAssistantMemory({
    rememberFn: async (args) => { stored.push(args); return { content: [{ type: 'text', text: 'Remembered [123e4567-e89b-12d3-a456-426614174000] (agent-runs/synabun)' }] }; },
    ensureCategoryFn: async (name, description, parent) => { ensured.push([name, parent]); },
    memoryStoredForRun: (runId) => runId === 'already',
    detectProject: () => 'detected',
  });
  const id = await memory.rememberDispatch({
    runId: 'run-1', title: 'Docs for hooks', task: 'Write docs', provider: 'codex', model: 'gpt-5.4-mini', cwd: '/tmp/x',
    status: 'completed', completionReason: 'complete', costUsd: 0.12, elapsedMs: 65000, tags: ['docs'],
    lastResult: { status: 'done', summary: 'Wrote docs', files: ['docs/hooks.md'], changes: [{ path: 'docs/hooks.md', note: 'new' }], follow_ups: [] },
  });
  assert.equal(id, '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].category, 'agent-runs');
  assert.equal(stored[0].project, 'detected');
  assert.equal(stored[0].source_ref, 'run-1');
  assert.equal(stored[0].idempotency_key, 'dispatch:run-1');
  assert.deepEqual(stored[0].related_files, ['docs/hooks.md']);
  assert.ok(stored[0].tags.includes('agent-run') && stored[0].tags.includes('codex') && stored[0].tags.includes('docs'));
  assert.match(stored[0].content, /\[Dispatch\] Docs for hooks via codex\/gpt-5.4-mini on detected/);
  assert.match(stored[0].content, /Outcome: done \(complete\) in 65s, cost \$0.12/);
  assert.deepEqual(ensured, [['agent-runs', 'automation']]);
  const skipped = await memory.rememberDispatch({ runId: 'already', provider: 'codex', task: 't' });
  assert.equal(skipped, null);
  assert.equal(stored.length, 1);
});

// ── Recall gate: Jev urgency beside a ranked, floored recall ──
const { recallTier, MUST_RECALL_NUDGE, classifyTurn, isTrivialTurn } = await import('../lib/assistant-memory.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MEM = (id) => ({ id, category: 'dev', importance: 5, score: 0.8, content: `memory ${id}`, tags: [] });

/** A deferred hookRecall stub: records the body and every finish(tier). */
function deferredRecall({ candidates = 3, delayMs = 0, ranked = true, dropped = [] } = {}) {
  const calls = [];
  const finishes = [];
  const fn = async (body, retrieve, options) => {
    calls.push({ body, retrieve, options });
    if (delayMs) await sleep(delayMs);
    return {
      deferred: true, ranked, rank_surface: ranked ? 'rerank' : null, judged: candidates, dropped, floor: 1.5, already_present: false, degraded: [], candidates,
      finish: (tier) => {
        finishes.push(tier);
        if (!tier) return { results: [], context: '', withheld: 'prompt-urgency' };
        const results = Array.from({ length: Math.min(tier.limit, candidates) }, (_, i) => MEM(`m${i + 1}`));
        return { results, context: results.map((r) => `[${r.id}] ${r.content}`).join('\n'), already_present: false, ranked, dropped };
      },
    };
  };
  return { fn, calls, finishes };
}
/** A promptUrgency stub with the wrapper's shape. */
function urgencyJudge(answer, { delayMs = 0 } = {}) {
  const calls = [];
  const notes = [];
  return {
    calls, notes,
    available: () => true,
    retryAfterMs: () => 0,
    async promptUrgency(args) { calls.push(args); if (delayMs) await sleep(delayMs); return answer === null ? { urgency: null, confidence: 0, logId: 7 } : { ...answer, logId: 7 }; },
    annotate: (logId, outcome) => notes.push({ logId, outcome }),
  };
}

test('recall gate: system and trivial prompts cost no judgment and no recall; "no, the bug is in X" is judged', async () => {
  const recall = deferredRecall();
  const judge = urgencyJudge({ urgency: 'should', confidence: 0.9 });
  const memory = createAssistantMemory({ hookRecall: recall.fn, judge });
  for (const prompt of ['[SynaBun Mailbox] 1 event\n1. result · run abc', '[SynaBun Router] Route mode: never.\n\nFix the login', '<task-notification>\n<task-id>x</task-id>\n</task-notification>']) {
    assert.equal((await memory.recallForPrompt({ prompt, session: 'assistant-1', generation: 1 })).skipped, 'system', prompt.slice(0, 20));
  }
  for (const prompt of ['ok', 'thanks!', '/compact', '   ']) {
    assert.equal((await memory.recallForPrompt({ prompt, session: 'assistant-1', generation: 1 })).skipped, 'trivial', prompt);
  }
  assert.equal(judge.calls.length + recall.calls.length, 0);
  const judged = await memory.recallForPrompt({ prompt: 'no, the bug is in the session writer', session: 'assistant-1', generation: 1 });
  assert.equal(judge.calls.length, 1);
  assert.equal(judge.calls[0].prompt, 'no, the bug is in the session writer');
  assert.equal(judge.calls[0].sessionId, 'assistant-1');
  assert.equal(judged.decision, 'should');
  assert.equal(classifyTurn('[SynaBun Mailbox] x').origin, 'system');
  assert.equal(isTrivialTurn('no, the bug is in X'), false);
});

test('recall gate: hookRecall gets the ranked, floored, budgeted request and the assistant origin', async () => {
  const recall = deferredRecall();
  const memory = createAssistantMemory({ hookRecall: recall.fn, judge: urgencyJudge({ urgency: 'should', confidence: 0.8 }), config: { recallBudgetMs: 99999, minScore: 0.45 } });
  await memory.recallForPrompt({ prompt: 'How does the loop runtime pick a provider?', project: 'synabun', session: 'assistant-2', generation: 4 });
  const { body, options } = recall.calls[0];
  assert.equal(body.surface, 'rerank');
  assert.equal(body.floor, true);
  assert.equal(body.budget_ms, 5000, 'recallBudgetMs is clamped to 500–5000');
  assert.equal(body.min_score, 0.45);
  assert.equal(body.caller, 'assistant');
  assert.equal(body.session, 'assistant-2');
  assert.equal(body.context_generation, 4);
  assert.equal(body.project, 'synabun');
  assert.equal(body.judge, undefined);
  assert.deepEqual(options, { origin: 'assistant', defer: true });
  assert.equal(memory.settings.recallBudgetMs, 5000);
  assert.equal(createAssistantMemory({ config: { recallBudgetMs: 10 } }).settings.recallBudgetMs, 500);
  assert.equal(createAssistantMemory().settings.recallBudgetMs, 2500);
});

test('recall gate: must / should / consider size the injection; must adds the nudge; a weak skip is a consider', async () => {
  const cases = [
    [{ urgency: 'must', confidence: 0.9 }, { name: 'must', limit: 5, tokenBudget: 900 }],
    [{ urgency: 'should', confidence: 0.9 }, { name: 'should', limit: 3, tokenBudget: 600 }],
    [{ urgency: 'consider', confidence: 0.9 }, { name: 'consider', limit: 2, tokenBudget: 400 }],
    [{ urgency: 'skip', confidence: 0.4 }, { name: 'consider', limit: 2, tokenBudget: 400 }],
  ];
  for (const [answer, tier] of cases) {
    const recall = deferredRecall({ candidates: 6 });
    const judge = urgencyJudge(answer);
    const memory = createAssistantMemory({ hookRecall: recall.fn, judge });
    const out = await memory.recallForPrompt({ prompt: 'What did we decide about the retry policy last week?', session: 'assistant-3', generation: 1 });
    assert.deepEqual(recall.finishes, [tier], `${answer.urgency} ${answer.confidence}`);
    assert.equal(out.results.length, tier.limit);
    assert.match(out.block, /^=== SynaBun: Related Memories ===/);
    assert.match(out.block, /\[ranked by Jev\]/);
    assert.equal(out.block.endsWith(MUST_RECALL_NUDGE), tier.name === 'must');
    assert.deepEqual(judge.notes[0], { logId: 7, outcome: { decision: tier.name, fallback: false, tier: tier.name, injected: out.results.map((r) => r.id) } });
  }
  assert.deepEqual(recallTier('must', { limit: 9, tokenBudget: 600 }), { name: 'must', limit: 10, tokenBudget: 900 });
  const dropped = deferredRecall({ candidates: 2, dropped: [{ id: 'x', relevance: 0.2 }, { id: 'y', relevance: 1 }] });
  const tagged = await createAssistantMemory({ hookRecall: dropped.fn, judge: urgencyJudge({ urgency: 'should', confidence: 0.9 }) })
    .recallForPrompt({ prompt: 'How is the parser configured in this repo?', session: 'assistant-3', generation: 1 });
  assert.match(tagged.block, /\[ranked by Jev; 2 low-relevance matches dropped\]/);
});

test('recall gate: a confident skip returns without waiting for a slow recall, which is withheld, not committed', async () => {
  const recall = deferredRecall({ delayMs: 500 });
  const judge = urgencyJudge({ urgency: 'skip', confidence: 0.8 });
  const memory = createAssistantMemory({ hookRecall: recall.fn, judge });
  const started = Date.now();
  const out = await memory.recallForPrompt({ prompt: 'Write a haiku about autumn leaves', session: 'assistant-4', generation: 1 });
  assert.ok(Date.now() - started < 300, `returned in ${Date.now() - started} ms`);
  assert.equal(out.skipped, 'judged');
  assert.equal(out.block, '');
  assert.deepEqual(judge.notes[0].outcome, { decision: 'skip', fallback: false, tier: null, injected: [] });
  await sleep(600);
  assert.deepEqual(recall.finishes, [null], 'the recall finishes in the background, withheld');
});

test('recall gate: nothing left after the floor returns at once; the urgency row says nothing was retrieved', async () => {
  const recall = deferredRecall({ candidates: 0 });
  const judge = urgencyJudge({ urgency: 'must', confidence: 0.9 }, { delayMs: 400 });
  const memory = createAssistantMemory({ hookRecall: recall.fn, judge });
  const started = Date.now();
  const out = await memory.recallForPrompt({ prompt: 'What did we decide about the cache eviction policy?', session: 'assistant-5', generation: 1 });
  assert.ok(Date.now() - started < 300, `returned in ${Date.now() - started} ms`);
  assert.equal(out.skipped, 'nothing-retrieved');
  await sleep(500);
  assert.equal(judge.notes[0].outcome.decision, 'nothing-retrieved');
  assert.deepEqual(recall.finishes, [null]);
});

test('recall gate: no judgment (off, failed, retry-after) falls back to the skip regex, else the should tier', async () => {
  const recall = deferredRecall();
  const failed = urgencyJudge(null);
  const memory = createAssistantMemory({ hookRecall: recall.fn, judge: failed });
  const out = await memory.recallForPrompt({ prompt: 'Explain how the dispatcher queues runs', session: 'assistant-6', generation: 1 });
  assert.equal(out.decision, 'should');
  assert.deepEqual(recall.finishes, [{ name: 'should', limit: 3, tokenBudget: 600 }]);
  assert.equal(failed.notes[0].outcome.fallback, true);
  const skipped = await memory.recallForPrompt({ prompt: 'run the whole test suite one more time', session: 'assistant-6', generation: 1 });
  assert.equal(skipped.skipped, 'pattern', 'a failed judgment leaves the regex in charge');
  // Retry-after: no urgency request, no ranking, the regex decides before any search.
  const waiting = { ...urgencyJudge({ urgency: 'must', confidence: 1 }), available: () => false, retryAfterMs: () => 5000 };
  const later = deferredRecall();
  const gated = createAssistantMemory({ hookRecall: later.fn, judge: waiting });
  const plain = await gated.recallForPrompt({ prompt: 'Explain how the dispatcher queues runs', session: 'assistant-6', generation: 1 });
  assert.equal(waiting.calls.length, 0);
  assert.equal(later.calls[0].body.judge, false, 'no ranking while a 429 is pending');
  assert.equal(plain.decision, 'should');
  assert.equal((await gated.recallForPrompt({ prompt: 'run the whole test suite one more time', session: 'assistant-6', generation: 1 })).skipped, 'pattern');
  assert.equal(later.calls.length, 1);
});

test('claudeHooks: describeTurn skips system turns and recalls on the user\'s own words', async () => {
  const recall = deferredRecall();
  const judge = urgencyJudge({ urgency: 'should', confidence: 0.9 });
  const memory = createAssistantMemory({ hookRecall: recall.fn, judge });
  const turns = new Map([
    ['[SynaBun Mailbox] 1 event', { system: true, prompt: null }],
    ['[SynaBun Router] Route mode: never.\n\nHow do the hooks load?', { system: false, prompt: 'How do the hooks load?' }],
  ]);
  const hooks = memory.claudeHooks({ session: 'assistant-7', project: 'p', getGeneration: () => 1, describeTurn: (text) => turns.get(text) || null });
  assert.deepEqual(await hooks.UserPromptSubmit[0].hooks[0]({ prompt: '[SynaBun Mailbox] 1 event' }), {});
  assert.equal(judge.calls.length, 0);
  const stamped = await hooks.UserPromptSubmit[0].hooks[0]({ prompt: '[SynaBun Router] Route mode: never.\n\nHow do the hooks load?' });
  assert.equal(judge.calls[0].prompt, 'How do the hooks load?');
  assert.equal(recall.calls[0].body.query, 'How do the hooks load?');
  assert.match(stamped.hookSpecificOutput.additionalContext, /Related Memories/);
  // A turn the CLI started itself (no record): classified from its text.
  assert.deepEqual(await hooks.UserPromptSubmit[0].hooks[0]({ prompt: '<task-notification>\n<task-id>a</task-id>\n</task-notification>' }), {});
  assert.equal(judge.calls.length, 1);
});

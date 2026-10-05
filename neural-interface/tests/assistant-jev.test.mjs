import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantJev } from '../lib/assistant-jev.js';

// Every judgment function is injected, so nothing here can reach the paid API.
const SURFACES = {
  'prompt-urgency': { enabled: true, timeoutMs: 1200 },
  'worker-outcome': { enabled: true, timeoutMs: 2500, minConfidence: 0.7 },
  'worker-claim': { enabled: true, timeoutMs: 2500, minProbability: 0.9 },
};
function harness({ surfaces = SURFACES, enabled = () => true, retryAfterMs = () => 0, prompt = { urgency: 'must', confidence: 0.83 }, worker = { status: 'done', statusConfidence: 0.91, cause: 'access', causeConfidence: 0.88, claimProbability: 0.95 } } = {}) {
  const calls = { prompt: [], worker: [], notes: [] };
  const jev = createAssistantJev({
    judgePrompt: async (text, project, options) => { calls.prompt.push({ text, project, options }); options.onLogged?.(41); return prompt; },
    judgeWorkerOutcome: async (input, ask, options) => { calls.worker.push({ input, ask, options }); options.onLogged?.(42); return worker; },
    surfaceConfig: (name) => surfaces[name] || { enabled: false, timeoutMs: 1000 },
    enabled, retryAfterMs,
    annotate: (id, outcome) => calls.notes.push({ id, outcome }),
  });
  return { jev, calls };
}

test('promptUrgency: same question as the hooks, origin assistant, timeout = the caller\'s recall budget', async () => {
  const { jev, calls } = harness();
  const verdict = await jev.promptUrgency({ prompt: 'What did we decide about retries?', project: 'synabun', sessionId: 'assistant-1', timeoutMs: 800 });
  assert.deepEqual(verdict, { urgency: 'must', confidence: 0.83, logId: 41 });
  assert.equal(calls.prompt[0].text, 'What did we decide about retries?');
  assert.equal(calls.prompt[0].project, 'synabun');
  assert.equal(calls.prompt[0].options.origin, 'assistant');
  assert.equal(calls.prompt[0].options.sessionId, 'assistant-1');
  assert.equal(calls.prompt[0].options.timeoutMs, 800);
  // The hook-tuned surface timeout (1200 ms) no longer caps it: live Assistant calls
  // sit at ~1.0–1.1 s and a long prompt timed out at 1200 ms in the acceptance run.
  await jev.promptUrgency({ prompt: 'x y z', timeoutMs: 2500 });
  assert.equal(calls.prompt[1].options.timeoutMs, 2500, 'the Assistant\'s recall budget, not the hook\'s surface timeout');
  assert.equal(calls.prompt[1].project, undefined);
  await jev.promptUrgency({ prompt: 'no budget given' });
  assert.equal(calls.prompt[2].options.timeoutMs, 1200, 'without a caller budget the surface timeout applies');
  jev.annotate(41, { decision: 'must' });
  jev.annotate(null, { ignored: true });
  assert.deepEqual(calls.notes, [{ id: 41, outcome: { decision: 'must' } }]);
});

test('gates: master switch / key, retry-after and the surface switch ask nothing', async () => {
  for (const options of [
    { enabled: () => false },
    { retryAfterMs: () => 12_000 },
    { surfaces: { ...SURFACES, 'prompt-urgency': { enabled: false }, 'worker-outcome': { enabled: false }, 'worker-claim': { enabled: false } } },
  ]) {
    const { jev, calls } = harness(options);
    assert.equal(await jev.promptUrgency({ prompt: 'What did we decide?' }), null);
    assert.equal(await jev.workerOutcome({ task: 't', message: 'm' }, { status: true, cause: true, claim: true }, { runId: 'r1' }), null);
    assert.equal(calls.prompt.length + calls.worker.length, 0);
  }
  const { jev } = harness({ retryAfterMs: () => 3000 });
  assert.equal(jev.available(), false);
  assert.equal(jev.retryAfterMs(), 3000);
});

test('workerOutcome: thresholds are read on every call; unclear is never accepted; the claim flags at P ≥ 0.9', async () => {
  const surfaces = structuredClone(SURFACES);
  const { jev, calls } = harness({ surfaces });
  const first = await jev.workerOutcome({ task: 't', message: 'm' }, { status: true, cause: true, claim: true }, { runId: 'run-1', assistantSessionId: 'assistant-1', project: 'synabun' });
  assert.equal(first.status, 'done');
  assert.equal(first.cause, 'access');
  assert.equal(first.claimFlagged, true);
  assert.equal(first.logId, 42);
  assert.deepEqual(calls.worker[0].ask, { status: true, cause: true, claim: true });
  assert.deepEqual({ ...calls.worker[0].options, onLogged: undefined }, { origin: 'assistant', sessionId: 'assistant-1', entityId: 'run-1', project: 'synabun', onLogged: undefined });
  surfaces['worker-outcome'].minConfidence = 0.95;
  surfaces['worker-claim'].minProbability = 0.97;
  const stricter = await jev.workerOutcome({ task: 't', message: 'm' }, { status: true, cause: true, claim: true }, { runId: 'run-1' });
  assert.equal(stricter.status, null, 'below the new bar');
  assert.equal(stricter.cause, null);
  assert.equal(stricter.claimFlagged, false);
  assert.equal(stricter.claimProbability, 0.95);
  assert.equal(calls.worker[1].options.sessionId, 'run-1', 'the run id stands in for a missing assistant session');
  const unclear = harness({ worker: { status: 'unclear', statusConfidence: 0.99 } });
  assert.equal((await unclear.jev.workerOutcome({ task: 't', message: 'm' }, { status: true, cause: false, claim: false }, { runId: 'r' })).status, null);
  const failed = harness({ worker: null });
  const none = await failed.jev.workerOutcome({ task: 't', message: 'm' }, { status: true, cause: true, claim: false }, { runId: 'r' });
  assert.deepEqual({ status: none.status, cause: none.cause, claimFlagged: none.claimFlagged }, { status: null, cause: null, claimFlagged: false });
});

test('the claim rider is dropped when worker-claim is off (judge() only checks the lead)', async () => {
  const { jev, calls } = harness({ surfaces: { ...SURFACES, 'worker-claim': { enabled: false, timeoutMs: 2500 } } });
  const out = await jev.workerOutcome({ task: 't', message: 'm' }, { status: true, cause: false, claim: true }, { runId: 'r' });
  assert.deepEqual(calls.worker[0].ask, { status: true, cause: false, claim: false });
  assert.equal(out.claimFlagged, false);
  // Claim only, with its surface off: nothing is asked at all.
  assert.equal(await jev.workerOutcome({ task: 't', message: 'm' }, { status: false, cause: false, claim: true }, { runId: 'r' }), null);
  assert.equal(calls.worker.length, 1);
  // The lead off, the rider on: only the claim is asked.
  const riderOnly = harness({ surfaces: { ...SURFACES, 'worker-outcome': { enabled: false, timeoutMs: 2500 } } });
  await riderOnly.jev.workerOutcome({ task: 't', message: 'm' }, { status: true, cause: true, claim: true }, { runId: 'r' });
  assert.deepEqual(riderOnly.calls.worker[0].ask, { status: false, cause: false, claim: true });
});

test('a throwing judgment function is a missing judgment, never an exception', async () => {
  const jev = createAssistantJev({
    judgePrompt: async () => { throw new Error('boom'); },
    judgeWorkerOutcome: async () => { throw new Error('boom'); },
    surfaceConfig: (name) => SURFACES[name],
    annotate: () => { throw new Error('boom'); },
  });
  assert.deepEqual(await jev.promptUrgency({ prompt: 'What did we decide?' }), { urgency: null, confidence: 0, logId: null });
  const out = await jev.workerOutcome({ task: 't', message: 'm' }, { status: true, cause: true, claim: true }, { runId: 'r' });
  assert.equal(out.status, null);
  assert.doesNotThrow(() => jev.annotate(1, {}));
  const bare = createAssistantJev({ surfaceConfig: () => { throw new Error('no config'); } });
  assert.equal(await bare.promptUrgency({ prompt: 'x' }), null);
  assert.equal(await bare.workerOutcome({}, { status: true }), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoopGoalJudge } from '../lib/native-loop-goal.js';

// The judge function is injected, so nothing here can reach the paid API.
const surfaceConfig = (enabled = true) => () => ({ enabled, timeoutMs: 3000, minConfidence: 0.8 });

test('judges the iteration\'s own reply when there is no journal, with loop attribution', async () => {
  const calls = [];
  const judge = createLoopGoalJudge({ judgeLoopGoal: async (input, options) => { calls.push({ input, options }); return 0.9; }, surfaceConfig: surfaceConfig() });
  const verdict = await judge({ task: 'Post the three deals', project: 'example-project' }, { text: 'Posted all three deals; nothing left to do.' }, { iteration: 1, total: 3, runId: 'run-1' });
  assert.deepEqual(verdict, { met: true, probability: 0.9 });
  assert.equal(calls[0].input.lastMessage, 'Posted all three deals; nothing left to do.');
  assert.deepEqual(calls[0].input.journal, []);
  assert.deepEqual(calls[0].options, { origin: 'loop', sessionId: 'run-1', project: 'example-project' });
});

test('uses the journal when the reply is empty, and says nothing when there is no evidence at all', async () => {
  const calls = [];
  const judge = createLoopGoalJudge({ judgeLoopGoal: async (input) => { calls.push(input); return 0.2; }, surfaceConfig: surfaceConfig() });
  const verdict = await judge({ task: 't', journal: [{ iteration: 1, summary: 'did half' }] }, { text: '' }, { iteration: 1, total: 2 });
  assert.deepEqual(verdict, { met: false, probability: 0.2 });
  assert.equal(calls[0].lastMessage, 'did half');
  assert.equal(await judge({ task: 't' }, {}, { iteration: 1, total: 2 }), null);
  assert.equal(calls.length, 1);
});

test('never judges after the final iteration, without a task, or with the surface off', async () => {
  let called = 0;
  const judgeLoopGoal = async () => { called++; return 0.99; };
  const on = createLoopGoalJudge({ judgeLoopGoal, surfaceConfig: surfaceConfig() });
  assert.equal(await on({ task: 't' }, { text: 'done' }, { iteration: 1, total: 1 }), null);
  assert.equal(await on({ task: 't' }, { text: 'done' }, { iteration: 3, total: 2 }), null);
  assert.equal(await on({}, { text: 'done' }, { iteration: 1, total: 3 }), null);
  const off = createLoopGoalJudge({ judgeLoopGoal, surfaceConfig: surfaceConfig(false) });
  assert.equal(await off({ task: 't' }, { text: 'done' }, { iteration: 1, total: 3 }), null);
  assert.equal(called, 0);
  // A null judgment keeps the loop going.
  const unavailable = createLoopGoalJudge({ judgeLoopGoal: async () => null, surfaceConfig: surfaceConfig() });
  assert.equal(await unavailable({ task: 't' }, { text: 'x' }, { iteration: 1, total: 3 }), null);
});

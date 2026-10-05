// v2.session.compact answers 503 "Session compact is not available yet" on
// OpenCode 1.18.34. The panel fell back to session.summarize in the first run;
// the Assistant's OpenCode brain called compact directly and failed. Both now
// go through compactOrSummarize.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compactOrSummarize, lastModelOf, isCompactUnavailable, session as singletonSession } from '../lib/opencode-v2-client.js';
import { createOpenCodeBrain } from '../lib/assistant-brains/opencode.js';

function unavailable() {
  const err = new Error('Session compact is not available yet');
  err.status = 503;
  err.tag = 'ServiceUnavailableError';
  return err;
}

// A client shaped like createClientInstance(): session.*, extra.session.*.
function fakeClient({ compact, transcript = [], summarize } = {}) {
  const calls = [];
  const client = {
    calls,
    onEvent: () => () => {},
    waitUntilConnected: async () => true,
    mcp: { status: async () => ({ status: 200, data: {} }) },
    session: {
      create: async () => ({ status: 200, data: { id: 'ses_brain' } }),
      promptAsync: async (request) => { calls.push(['promptAsync', request]); return { status: 204 }; },
      compact: async (params) => { calls.push(['compact', params]); return compact ? compact(params) : { status: 204, data: undefined }; },
      messages: async (params) => { calls.push(['messages', params]); return { status: 200, data: transcript }; },
    },
    extra: {
      session: {
        summarize: async (params) => { calls.push(['summarize', params]); return summarize ? summarize(params) : { status: 200, data: true }; },
      },
    },
  };
  return client;
}

test('compactOrSummarize: compact when the serve has it, nothing else is called', async () => {
  const client = fakeClient();
  const out = await compactOrSummarize(client, { sessionID: 'ses_1', directory: '/p', model: 'anthropic/claude' });
  assert.equal(out.via, 'compact');
  assert.deepEqual(client.calls, [['compact', { sessionID: 'ses_1', directory: '/p' }]]);
});

test('compactOrSummarize: 503 falls back to summarize with the given model (string or object)', async () => {
  for (const model of ['anthropic/claude-x', { providerID: 'anthropic', modelID: 'claude-x' }]) {
    const client = fakeClient({ compact: () => { throw unavailable(); } });
    const out = await compactOrSummarize(client, { sessionID: 'ses_1', directory: '/p', model });
    assert.equal(out.via, 'summarize');
    assert.deepEqual(client.calls[1], ['summarize', { sessionID: 'ses_1', directory: '/p', providerID: 'anthropic', modelID: 'claude-x' }]);
    assert.equal(client.calls.length, 2, 'the transcript is not read when the model is known');
  }
});

test('compactOrSummarize: without a model it takes the last one the transcript ran on', async () => {
  const transcript = [
    { info: { role: 'user', model: { providerID: 'openai', modelID: 'gpt-old' } } },
    { info: { role: 'assistant', providerID: 'deepseek', modelID: 'v4' } },
  ];
  assert.deepEqual(lastModelOf(transcript), { providerID: 'deepseek', modelID: 'v4' });
  const client = fakeClient({ compact: () => { throw unavailable(); }, transcript });
  const out = await compactOrSummarize(client, { sessionID: 'ses_1' });
  assert.equal(out.via, 'summarize');
  assert.deepEqual(client.calls.map((c) => c[0]), ['compact', 'messages', 'summarize']);
  assert.deepEqual(client.calls[2][1], { sessionID: 'ses_1', directory: undefined, providerID: 'deepseek', modelID: 'v4' });
});

test('compactOrSummarize: no model anywhere is a 400 with a sentence; any other compact error is rethrown as it is', async () => {
  const noModel = fakeClient({ compact: () => { throw unavailable(); } });
  await assert.rejects(compactOrSummarize(noModel, { sessionID: 'ses_1' }), (err) => err.status === 400 && /model/i.test(err.message));
  assert.equal(noModel.calls.some((c) => c[0] === 'summarize'), false);

  const boom = Object.assign(new Error('session not found'), { status: 404 });
  const other = fakeClient({ compact: () => { throw boom; } });
  await assert.rejects(compactOrSummarize(other, { sessionID: 'ses_1', model: 'a/b' }), (err) => err === boom);
  assert.equal(other.calls.length, 1);
  assert.equal(isCompactUnavailable(boom), false);

  // A client without the extra surface keeps today's behaviour: the 503 surfaces.
  const bare = fakeClient({ compact: () => { throw unavailable(); } });
  delete bare.extra;
  await assert.rejects(compactOrSummarize(bare, { sessionID: 'ses_1', model: 'a/b' }), (err) => err.status === 503);
});

function brainWith(client, brain = {}) {
  const sent = [];
  const instance = createOpenCodeBrain({
    session: { id: 'assistant-compact-1', brain: { provider: 'opencode', cwd: '/work', ...brain } },
    sink: { send: (packet) => sent.push(packet) },
    deps: {
      ensureIsolatedServe: async () => ({ client, sessions: new Set() }),
      stopIsolatedServe() {},
      setupOpencodeSidepanelConfig: () => '/nonexistent-xdg',
    },
  });
  return { instance, sent };
}

test('the Assistant brain compacts on 1.18.34: 503 → summarize on the model of its last turn', async () => {
  const client = fakeClient({ compact: () => { throw unavailable(); } });
  const { instance } = brainWith(client, { model: 'anthropic/claude-record' });
  await instance.sendUserTurn({ text: 'hello', model: 'openrouter/routed-model' });
  await instance.compact();
  const summarize = client.calls.find((c) => c[0] === 'summarize');
  assert.deepEqual(summarize[1], { sessionID: 'ses_brain', directory: '/work', providerID: 'openrouter', modelID: 'routed-model' });
  await instance.dispose();
});

test('the Assistant brain: before any turn it summarises on the record model, else on the transcript model', async () => {
  const recorded = fakeClient({ compact: () => { throw unavailable(); } });
  const a = brainWith(recorded, { model: 'anthropic/claude-record' });
  await a.instance.compact();
  assert.deepEqual(recorded.calls.find((c) => c[0] === 'summarize')[1],
    { sessionID: 'ses_brain', directory: '/work', providerID: 'anthropic', modelID: 'claude-record' });
  await a.instance.dispose();

  const fromTranscript = fakeClient({
    compact: () => { throw unavailable(); },
    transcript: [{ info: { role: 'assistant', providerID: 'deepseek', modelID: 'v4' } }],
  });
  const b = brainWith(fromTranscript);
  await b.instance.compact();
  assert.deepEqual(fromTranscript.calls.find((c) => c[0] === 'summarize')[1],
    { sessionID: 'ses_brain', directory: '/work', providerID: 'deepseek', modelID: 'v4' });
  await b.instance.dispose();
});

test('the Assistant brain: a serve that has compact is asked exactly as before', async () => {
  const client = fakeClient();
  const { instance } = brainWith(client, { model: 'anthropic/claude-record' });
  await instance.compact();
  assert.deepEqual(client.calls, [['compact', { sessionID: 'ses_brain', directory: '/work' }]]);
  await instance.dispose();
});

test('the wrapper compact itself is untouched; the native loop runtime never compacts', () => {
  assert.equal(typeof singletonSession.compact, 'function');
  const wrapper = readFileSync(new URL('../lib/opencode-v2-client.js', import.meta.url), 'utf8');
  // Still compact → session.compact → session.summarize by presence, as the loops rely on.
  assert.equal((wrapper.match(/let target = (?:client|c)\.v2\?\.session/g) || []).length, 2);
  for (const file of ['native-loop-runtime.js', 'native-loop-providers.js', 'native-loop-goal.js']) {
    const source = readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');
    assert.equal(/session\.compact|\.compact\(|session\.summarize/.test(source), false, `${file} has no compact call to fix`);
  }
  const brain = readFileSync(new URL('../lib/assistant-brains/opencode.js', import.meta.url), 'utf8');
  assert.equal(brain.includes('client.session.compact('), false, 'the brain goes through compactOrSummarize');
});

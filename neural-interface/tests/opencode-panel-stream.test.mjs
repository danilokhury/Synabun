// OpenCode panel, cluster 1: live stream and run state. Everything here is
// DOM-free panel logic driven with a real store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelStore } from '../public/shared/ocp-v2/ocp-v2-state.js';
import {
  applyEvent, describeError, errorText, resolveEventTargets,
} from '../public/shared/ocp-v2/ocp-v2-events.js';
import {
  createCapabilities, gatedRequest, replyFailed, replyError, UNSUPPORTED_MESSAGE,
} from '../public/shared/ocp-v2/ocp-v2-caps.js';
import { trackOptimisticMessage, TRANSCRIPT_SAFETY_POLL_MS } from '../public/shared/ocp-v2/ocp-v2-send-logic.js';
import { rehydrateSessionState, requestsForPanel } from '../public/shared/ocp-v2/ocp-v2-rehydrate.js';
import {
  visibleParts, isVisiblePart, partSignature, messageErrorView, retryBannerView, retryPartText,
  compactionLabel, inlinePartText, reasoningPreview, headerStatus,
} from '../public/shared/ocp-v2/ocp-v2-render-logic.js';

function boundStore(sessionId = 'ses_1') {
  const store = createPanelStore();
  store.setSession(sessionId, { id: sessionId, title: 'T' });
  return store;
}
const textOf = (store, messageID, partID) => store.getState().messages.get(messageID)?.parts.get(partID)?.text;
function recordHooks() {
  const log = [];
  return {
    log,
    hooks: {
      onOutcome: (_s, outcome) => log.push(['outcome', outcome]),
      onAsk: (_s, id, kind) => log.push(['ask', kind, id]),
      onAskCleared: (id) => log.push(['cleared', id]),
      onCompacted: () => log.push(['compacted']),
    },
  };
}

// ── O01 live token streaming ────────────────────────────────────────────────

test('message.part.delta appends to the announced part and marks the turn running', () => {
  const store = boundStore();
  applyEvent(store, 'message.updated', { info: { id: 'msg_a', role: 'assistant', time: { created: 1 } } });
  applyEvent(store, 'message.part.updated', { part: { id: 'prt_1', messageID: 'msg_a', type: 'text', text: '' } });
  store.setRunning(false);
  for (const delta of ['Hel', 'lo ', 'world']) {
    applyEvent(store, 'message.part.delta', { sessionID: 'ses_1', messageID: 'msg_a', partID: 'prt_1', field: 'text', delta });
  }
  assert.equal(textOf(store, 'msg_a', 'prt_1'), 'Hello world');
  assert.equal(store.getState().running, true);
});

test('a delta that outruns its part creates a stub the later update replaces', () => {
  const store = boundStore();
  applyEvent(store, 'message.part.delta', { messageID: 'msg_a', partID: 'prt_r', field: 'text', delta: 'think' });
  const stub = store.getState().messages.get('msg_a');
  assert.equal(stub.role, 'assistant');
  assert.deepEqual(stub.parts.get('prt_r'), { id: 'prt_r', messageID: 'msg_a', type: 'text', text: 'think' });

  // The authoritative update carries the real type and the full text.
  applyEvent(store, 'message.part.updated', {
    part: { id: 'prt_r', messageID: 'msg_a', type: 'reasoning', text: 'thinking done', time: { start: 1, end: 2 } },
  });
  assert.equal(store.getState().messages.get('msg_a').parts.get('prt_r').type, 'reasoning');
  assert.equal(textOf(store, 'msg_a', 'prt_r'), 'thinking done');
  assert.deepEqual(store.getState().messageOrder, ['msg_a']);
});

test('deltas without ids, text or a string delta are ignored', () => {
  const store = boundStore();
  applyEvent(store, 'message.part.delta', { messageID: 'msg_a', partID: 'p', delta: '' });
  applyEvent(store, 'message.part.delta', { messageID: 'msg_a', delta: 'x' });
  applyEvent(store, 'message.part.delta', { partID: 'p', delta: 'x' });
  applyEvent(store, 'message.part.delta', { messageID: 'msg_a', partID: 'p', delta: 5 });
  assert.equal(store.getState().messages.size, 0);
});

test('a delta on another field leaves the text alone', () => {
  const store = boundStore();
  applyEvent(store, 'message.part.updated', { part: { id: 'p', messageID: 'm', type: 'text', text: 'a' } });
  applyEvent(store, 'message.part.delta', { messageID: 'm', partID: 'p', field: 'summary', delta: 'S' });
  const part = store.getState().messages.get('m').parts.get('p');
  assert.equal(part.text, 'a');
  assert.equal(part.summary, 'S');
});

test('message.part.removed and message.removed drop exactly what they name', () => {
  const store = boundStore();
  applyEvent(store, 'message.part.updated', { part: { id: 'p1', messageID: 'm1', type: 'text', text: 'a' } });
  applyEvent(store, 'message.part.updated', { part: { id: 'p2', messageID: 'm1', type: 'text', text: 'b' } });
  applyEvent(store, 'message.part.removed', { sessionID: 'ses_1', messageID: 'm1', partID: 'p1' });
  assert.deepEqual([...store.getState().messages.get('m1').parts.keys()], ['p2']);
  applyEvent(store, 'message.part.removed', { messageID: 'm1', partID: 'nope' });
  applyEvent(store, 'message.removed', { messageID: 'm1' });
  assert.equal(store.getState().messages.size, 0);
  assert.deepEqual(store.getState().messageOrder, []);
});

test('a transcript snapshot never rolls back text that is still streaming', () => {
  const store = boundStore();
  applyEvent(store, 'message.part.updated', { part: { id: 'p', messageID: 'm', type: 'text', text: '' } });
  applyEvent(store, 'message.part.delta', { messageID: 'm', partID: 'p', field: 'text', delta: 'Hello world, how' });

  // Read a moment ago: an older prefix of what is on screen.
  store.hydrateMessages([{ info: { id: 'm', role: 'assistant' }, parts: [{ id: 'p', messageID: 'm', type: 'text', text: 'Hello wor' }] }]);
  assert.equal(textOf(store, 'm', 'p'), 'Hello world, how');
  applyEvent(store, 'message.part.delta', { messageID: 'm', partID: 'p', field: 'text', delta: ' are' });
  assert.equal(textOf(store, 'm', 'p'), 'Hello world, how are');

  // A snapshot that is ahead, different, or finished wins.
  store.hydrateMessages([{ info: { id: 'm', role: 'assistant' }, parts: [{ id: 'p', messageID: 'm', type: 'text', text: 'Hello world, how are you' }] }]);
  assert.equal(textOf(store, 'm', 'p'), 'Hello world, how are you');
  store.hydrateMessages([{ info: { id: 'm', role: 'assistant' }, parts: [{ id: 'p', messageID: 'm', type: 'text', text: 'Hello', time: { start: 1, end: 2 } }] }]);
  assert.equal(textOf(store, 'm', 'p'), 'Hello');
  store.hydrateMessages([{ info: { id: 'm2', role: 'user' }, parts: [{ id: 'q', messageID: 'm2', type: 'text', text: 'hi' }] }, { parts: [] }, null]);
  assert.deepEqual(store.getState().messageOrder, ['m', 'm2']);
});

test('the safety poll is slow now that deltas stream', () => {
  assert.ok(TRANSCRIPT_SAFETY_POLL_MS >= 10_000);
});

test('the optimistic bubble goes when the server copy of the prompt has a part', () => {
  const store = boundStore();
  store.upsertMessage({ id: 'old', role: 'user' });
  store.upsertMessage({ id: 'local-user-1', role: 'user' });
  store.upsertPart({ id: 'local-user-1-text', messageID: 'local-user-1', type: 'text', text: 'hi' });
  const tracker = trackOptimisticMessage(store, {
    optimisticId: 'local-user-1',
    existingMessageIds: new Set(['old']),
    onDrop: () => store.removeMessage('local-user-1'),
  });

  // Parts of the old message, of the local one and of the assistant do not count.
  store.upsertPart({ id: 'o1', messageID: 'old', type: 'text', text: 'earlier' });
  applyEvent(store, 'message.updated', { info: { id: 'msg_a', role: 'assistant', time: { created: 1 } } });
  applyEvent(store, 'message.part.updated', { part: { id: 'a1', messageID: 'msg_a', type: 'text', text: 'x' } });
  // The real user message alone (no part yet) keeps the local bubble on screen.
  applyEvent(store, 'message.updated', { info: { id: 'msg_u', role: 'user', time: { created: 1 } } });
  assert.equal(tracker.dropped(), false);
  assert.ok(store.getState().messages.has('local-user-1'));

  applyEvent(store, 'message.part.updated', { part: { id: 'u1', messageID: 'msg_u', type: 'text', text: 'hi' } });
  assert.equal(tracker.dropped(), true);
  assert.equal(store.getState().messages.has('local-user-1'), false);
  assert.deepEqual(store.getState().messageOrder, ['old', 'msg_a', 'msg_u']);
});

test('the optimistic tracker stands down when the bubble is removed some other way', () => {
  const store = boundStore();
  store.upsertMessage({ id: 'local-user-2', role: 'user' });
  let drops = 0;
  const tracker = trackOptimisticMessage(store, { optimisticId: 'local-user-2', existingMessageIds: [], onDrop: () => { drops += 1; } });
  store.removeMessage('local-user-2');
  applyEvent(store, 'message.updated', { info: { id: 'msg_u', role: 'user' } });
  applyEvent(store, 'message.part.updated', { part: { id: 'u1', messageID: 'msg_u', type: 'text', text: 'hi' } });
  assert.equal(drops, 0);
  assert.equal(tracker.dropped(), true);
});

// ── O02 run status and retries ──────────────────────────────────────────────

test('session.status drives running, the retry state and one DONE per turn', () => {
  const store = boundStore();
  const { log, hooks } = recordHooks();
  applyEvent(store, 'session.status', { sessionID: 'ses_1', status: { type: 'busy' } }, hooks);
  assert.equal(store.getState().running, true);
  assert.deepEqual(store.getState().sessionStatus, { type: 'busy' });

  const retry = { type: 'retry', attempt: 2, message: 'Overloaded', next: 1_800_000_000_000 };
  applyEvent(store, 'session.status', { sessionID: 'ses_1', status: retry }, hooks);
  assert.deepEqual(store.getState().sessionStatus, retry);
  assert.equal(store.getState().running, true);

  // OpenCode sends status idle and then session.idle: one outcome, not two.
  applyEvent(store, 'session.status', { sessionID: 'ses_1', status: { type: 'idle' } }, hooks);
  applyEvent(store, 'session.idle', { sessionID: 'ses_1' }, hooks);
  assert.equal(store.getState().running, false);
  assert.deepEqual(store.getState().sessionStatus, { type: 'idle' });
  assert.deepEqual(log, [['outcome', 'done']]);

  // An idle echo for a panel that was not running stays silent.
  applyEvent(store, 'session.idle', { sessionID: 'ses_1' }, hooks);
  assert.equal(log.length, 1);
  applyEvent(store, 'session.status', { sessionID: 'ses_1' }, hooks);
  assert.deepEqual(store.getState().sessionStatus, { type: 'idle' });
});

test('switching session resets the run status', () => {
  const store = boundStore();
  applyEvent(store, 'session.status', { status: { type: 'retry', attempt: 1, message: 'x', next: 1 } });
  store.setSession('ses_2', { id: 'ses_2' });
  assert.deepEqual(store.getState().sessionStatus, { type: 'idle' });
  assert.equal(store.getState().running, false);
});

test('retryBannerView shows attempt, message, next try and only an http(s) action link', () => {
  assert.equal(retryBannerView({ type: 'busy' }), null);
  assert.equal(retryBannerView(null), null);
  assert.deepEqual(retryBannerView({ type: 'retry', attempt: 3, message: 'Rate limited', next: 1234 }), {
    title: 'Retrying (attempt 3)', message: 'Rate limited', nextAt: 1234, actionLabel: '', actionLink: '',
  });
  const withAction = retryBannerView({
    type: 'retry', attempt: 1, message: 'm', next: 0,
    action: { reason: 'credits', provider: 'opencode', title: 'Out of credits', message: 'Add credits to continue', label: 'Top up', link: 'https://opencode.ai/billing' },
  });
  assert.equal(withAction.message, 'Add credits to continue');
  assert.equal(withAction.actionLabel, 'Top up');
  assert.equal(withAction.actionLink, 'https://opencode.ai/billing');
  const hostile = retryBannerView({ type: 'retry', attempt: 1, message: 'm', next: 0, action: { label: 'x', link: 'javascript:alert(1)' } });
  assert.equal(hostile.actionLink, '');
  assert.equal(hostile.actionLabel, '');
  assert.equal(retryPartText({ type: 'retry', attempt: 2, error: { name: 'APIError', data: { message: 'Overloaded', isRetryable: true } } }), 'Retry 2: Overloaded');
});

test('rehydrate takes run state from OpenCode, not from an unfinished message', async () => {
  const store = boundStore();
  store.setRunning(true); // guessed from a message a dead turn left unfinished
  const calls = [];
  const api = {
    sessionStatus: async (p) => { calls.push(['status', p]); return { status: 200, data: { status: { type: 'idle' } } }; },
    permissionList: async (p) => { calls.push(['permissions', p]); return { status: 200, data: [] }; },
    questionList: async (p) => { calls.push(['questions', p]); return { status: 200, data: [] }; },
  };
  const applied = await rehydrateSessionState(store, api, { sessionId: 'ses_1', cwd: '/p' });
  assert.deepEqual(applied, { status: true, permissions: true, questions: true, todos: false });
  assert.equal(store.getState().running, false);
  assert.deepEqual(calls.map(([k, p]) => [k, p.sessionId, p.cwd]), [
    ['status', 'ses_1', '/p'], ['permissions', 'ses_1', '/p'], ['questions', 'ses_1', '/p'],
  ]);

  api.sessionStatus = async () => ({ status: 200, data: { status: { type: 'retry', attempt: 4, message: 'm', next: 9 } } });
  await rehydrateSessionState(store, api, { sessionId: 'ses_1' });
  assert.equal(store.getState().running, true);
  assert.equal(store.getState().sessionStatus.attempt, 4);
});

test('rehydrate leaves the store alone for what an older server cannot answer', async () => {
  const store = boundStore();
  store.setRunning(true);
  store.addPendingPermission({ id: 'per_live', sessionID: 'ses_1' });
  const unsupported = async () => ({ ok: false, unsupported: true, status: 501, error: UNSUPPORTED_MESSAGE });
  const applied = await rehydrateSessionState(store, {
    sessionStatus: unsupported,
    permissionList: unsupported,
    questionList: async () => { throw new Error('websocket closed'); },
  }, { sessionId: 'ses_1' });
  assert.deepEqual(applied, { status: false, permissions: false, questions: false, todos: false });
  assert.equal(store.getState().running, true);
  assert.equal(store.getState().pendingPermissions.length, 1);
});

test('rehydrate drops its answers when the panel moved to another session meanwhile', async () => {
  const store = boundStore();
  const api = {
    sessionStatus: async () => { store.setSession('ses_2', { id: 'ses_2' }); return { status: 200, data: { status: { type: 'busy' } } }; },
    permissionList: async () => ({ status: 200, data: [{ id: 'per_1', sessionID: 'ses_1' }] }),
    questionList: async () => ({ status: 200, data: [] }),
  };
  await rehydrateSessionState(store, api, { sessionId: 'ses_1' });
  assert.equal(store.getState().running, false);
  assert.deepEqual(store.getState().pendingPermissions, []);
  assert.deepEqual(await rehydrateSessionState(store, api, {}), { status: false, permissions: false, questions: false, todos: false });
});

// ── O03 error surfacing ─────────────────────────────────────────────────────

test('describeError reads data.message, the tagged shape and names without a message', () => {
  assert.deepEqual(
    describeError({ name: 'APIError', data: { message: 'Overloaded', statusCode: 529, isRetryable: true } }),
    { name: 'APIError', kind: 'api', message: 'Overloaded', statusCode: 529, retryable: true },
  );
  assert.deepEqual(
    describeError({ name: 'ProviderAuthError', data: { providerID: 'anthropic', message: 'Invalid API key' } }),
    { name: 'ProviderAuthError', kind: 'auth', message: 'Invalid API key', providerID: 'anthropic' },
  );
  assert.deepEqual(describeError({ _tag: 'SessionBusyError', message: 'Session is busy' }), { name: 'SessionBusyError', kind: 'busy', message: 'Session is busy' });
  assert.equal(describeError({ name: 'MessageOutputLengthError', data: {} }).message, 'The reply hit the model output limit.');
  assert.equal(describeError({ name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } }).message, 'Stopped');
  assert.equal(describeError({ name: 'WeirdError' }).message, 'WeirdError');
  assert.equal(describeError({}).message, 'Error');
  assert.equal(describeError('plain').message, 'plain');
  assert.equal(errorText({ name: 'APIError', data: { message: 'Overloaded', statusCode: 529, isRetryable: true } }), 'Overloaded (HTTP 529)');
});

test('session.error shows the real message, ends the turn and notifies once', () => {
  const store = boundStore();
  const { log, hooks } = recordHooks();
  store.setRunning(true);
  applyEvent(store, 'session.error', {
    sessionID: 'ses_1',
    error: { name: 'UnknownError', data: { message: 'Model anthropic/x not found' } },
  }, hooks);
  const [err] = store.getState().errors;
  assert.equal(err.message, 'Model anthropic/x not found');
  assert.equal(err.kind, 'error');
  assert.equal(err.name, 'UnknownError');
  assert.ok(err.id);
  assert.equal(store.getState().running, false);
  assert.deepEqual(log, [['outcome', 'error']]);
});

test('stopping a turn is not an error banner', () => {
  const store = boundStore();
  const { log, hooks } = recordHooks();
  store.setRunning(true);
  applyEvent(store, 'session.error', { sessionID: 'ses_1', error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }, hooks);
  assert.deepEqual(store.getState().errors, []);
  assert.equal(store.getState().running, false);
  assert.deepEqual(log, []);
});

test('errors carry ids and can be dismissed one at a time', () => {
  const store = boundStore();
  store.pushError({ message: 'one' });
  store.pushError({ message: 'two' });
  const [a, b] = store.getState().errors;
  assert.notEqual(a.id, b.id);
  store.dismissError(a.id);
  assert.deepEqual(store.getState().errors.map((e) => e.message), ['two']);
  store.dismissError('nope');
  assert.equal(store.getState().errors.length, 1);
});

test('a session.error without a sessionID reaches the panels that are running a turn', () => {
  const idle = boundStore('ses_idle');
  const running = boundStore('ses_run');
  running.setRunning(true);
  const storesBySession = new Map([['ses_idle', new Set([idle])], ['ses_run', new Set([running])]]);
  const allStores = new Set([idle, running]);
  assert.deepEqual(resolveEventTargets({ eventType: 'session.error', ev: { error: {} }, storesBySession, allStores }), [running]);
  // Any other event without a session has nowhere to go.
  assert.deepEqual(resolveEventTargets({ eventType: 'message.updated', ev: {}, storesBySession, allStores }), []);
  assert.deepEqual(resolveEventTargets({ eventType: 'session.idle', ev: { sessionID: 'ses_idle' }, storesBySession, allStores }), [idle]);
  assert.deepEqual(resolveEventTargets({ eventType: 'session.idle', ev: { sessionID: 'ses_none' }, storesBySession, allStores }), []);
});

test('messageErrorView offers Compact on overflow and Settings on an auth failure', () => {
  assert.equal(messageErrorView({ role: 'assistant' }), null);
  assert.equal(messageErrorView({ role: 'user', error: { name: 'X' } }), null);
  assert.deepEqual(
    messageErrorView({ role: 'assistant', error: { name: 'ContextOverflowError', data: { message: 'prompt is too long' } } }),
    { kind: 'overflow', name: 'ContextOverflowError', text: 'prompt is too long', action: 'compact' },
  );
  assert.equal(messageErrorView({ role: 'assistant', error: { name: 'ProviderAuthError', data: { providerID: 'p', message: 'no key' } } }).action, 'settings');
  const aborted = messageErrorView({ role: 'assistant', error: { name: 'MessageAbortedError', data: { message: 'x' } } });
  assert.deepEqual([aborted.kind, aborted.text, aborted.action], ['aborted', 'Stopped', null]);
  assert.equal(messageErrorView({ role: 'assistant', error: { name: 'APIError', data: { message: 'Bad gateway', statusCode: 502, isRetryable: true } } }).text, 'Bad gateway (HTTP 502)');
});

// ── O16 compaction visibility ───────────────────────────────────────────────

test('session.updated refreshes metadata and the compacting flag without touching the transcript', () => {
  const store = boundStore();
  store.upsertMessage({ id: 'm', role: 'user' });
  store.setRunning(true);
  applyEvent(store, 'session.updated', { sessionID: 'ses_1', info: { id: 'ses_1', title: 'Renamed', time: { created: 1, updated: 2, compacting: 5 } } });
  assert.equal(store.getState().sessionInfo.title, 'Renamed');
  assert.equal(store.getState().compacting, true);
  assert.equal(store.getState().messages.size, 1);
  assert.equal(store.getState().running, true);

  applyEvent(store, 'session.updated', { info: { id: 'ses_1', time: { created: 1, updated: 3 } } });
  assert.equal(store.getState().compacting, false);
  // Metadata of some other session is not ours.
  applyEvent(store, 'session.updated', { info: { id: 'ses_other', title: 'Nope' } });
  assert.equal(store.getState().sessionInfo.title, 'Renamed');
});

test('session.compacted clears the flag and asks for a transcript refresh', () => {
  const store = boundStore();
  const { log, hooks } = recordHooks();
  store.setCompacting(true);
  applyEvent(store, 'session.compacted', { sessionID: 'ses_1' }, hooks);
  assert.equal(store.getState().compacting, false);
  assert.deepEqual(log, [['compacted']]);
  assert.equal(compactionLabel({ type: 'compaction', auto: false }), 'Context compacted');
  assert.equal(compactionLabel({ type: 'compaction', auto: true }), 'Context compacted automatically');
  assert.match(compactionLabel({ type: 'compaction', auto: true, overflow: true }), /outgrew the model/);
});

// ── transcript decisions (P04, P09, P10) ────────────────────────────────────

test('step and snapshot markers and text OpenCode wrote itself stay out of the transcript', () => {
  const parts = new Map([
    ['a', { id: 'a', type: 'step-start', index: 0 }],
    ['b', { id: 'b', type: 'text', text: 'visible', index: 2 }],
    ['c', { id: 'c', type: 'text', text: 'The following tool was executed by the user', synthetic: true, index: 1 }],
    ['d', { id: 'd', type: 'text', text: 'ignored', ignored: true }],
    ['e', { id: 'e', type: 'snapshot', snapshot: 'abc' }],
    ['f', { id: 'f', type: 'tool', tool: 'bash', index: 1 }],
    ['g', { id: 'g', type: 'step-finish' }],
    ['h', { id: 'h', type: 'compaction', auto: true }],
  ]);
  assert.deepEqual(visibleParts({ parts }).map((p) => p.id), ['f', 'b', 'h']);
  assert.deepEqual(visibleParts({ parts: [{ id: 'x', type: 'text', text: 't' }] }).map((p) => p.id), ['x']);
  assert.deepEqual(visibleParts(null), []);
  assert.equal(isVisiblePart(null), false);
});

test('every SDK part type has a line to show instead of a "[type part]" placeholder', () => {
  assert.equal(inlinePartText({ type: 'subtask', agent: 'explore', description: 'Find the callers', prompt: 'long\nprompt' }), 'Subtask · explore: Find the callers');
  assert.equal(inlinePartText({ type: 'subtask', agent: '', description: '', prompt: 'first line\nsecond' }), 'Subtask: first line');
  assert.equal(inlinePartText({ type: 'agent', name: 'plan' }), '@plan');
  assert.equal(inlinePartText({ type: 'patch', hash: 'h', files: ['/a/b/one.js'] }), 'Changed 1 file: one.js');
  assert.equal(inlinePartText({ type: 'patch', hash: 'h', files: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'] }), 'Changed 5 files: a.js, b.js, c.js +2 more');
  assert.equal(inlinePartText({ type: 'patch', hash: 'h', files: [] }), 'Files changed');
  assert.equal(inlinePartText({ type: 'text' }), '');
});

test('part signatures change exactly when what is shown changes', () => {
  const text = { id: 'p', type: 'text', text: 'abc' };
  assert.notEqual(partSignature(text), partSignature({ ...text, text: 'abcd' }));
  assert.notEqual(partSignature(text), partSignature({ ...text, time: { end: 1 } }));
  assert.equal(partSignature(text), partSignature({ ...text }));
  const retry = { id: 'r', type: 'retry', attempt: 1, error: { name: 'APIError', data: { message: 'x' } } };
  assert.notEqual(partSignature(retry), partSignature({ ...retry, attempt: 2 }));
  assert.notEqual(partSignature({ type: 'compaction', auto: true }), partSignature({ type: 'compaction', auto: false }));
  assert.equal(partSignature(null), '');
  const tool = { id: 't', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'ls' } } };
  assert.notEqual(partSignature(tool), partSignature({ ...tool, state: { ...tool.state, status: 'completed', output: 'a' } }));
});

test('reasoningPreview keeps the tail of what the model is thinking', () => {
  assert.equal(reasoningPreview(''), '');
  assert.equal(reasoningPreview('  a\n\n b  '), 'a b');
  const long = 'x'.repeat(300) + 'END';
  const out = reasoningPreview(long, 50);
  assert.equal(out.length, 51);
  assert.ok(out.startsWith('…') && out.endsWith('END'));
});

test('headerStatus picks the most urgent state', () => {
  const base = { healing: false, pendingPermissions: [], pendingQuestions: [], compacting: false, sessionStatus: { type: 'idle' }, running: false, serverStatus: 'ready', errors: [] };
  assert.deepEqual(headerStatus(base), { cls: 'ready', text: 'idle' });
  assert.deepEqual(headerStatus({ ...base, running: true }), { cls: 'running', text: 'running' });
  assert.deepEqual(headerStatus({ ...base, running: true, sessionStatus: { type: 'retry' } }), { cls: 'reconnecting', text: 'retrying' });
  assert.deepEqual(headerStatus({ ...base, running: true, compacting: true }), { cls: 'running', text: 'compacting' });
  assert.deepEqual(headerStatus({ ...base, running: true, pendingQuestions: [{}] }), { cls: 'awaiting', text: 'awaiting answer' });
  assert.deepEqual(headerStatus({ ...base, running: true, pendingPermissions: [{}] }), { cls: 'awaiting', text: 'awaiting permission' });
  assert.deepEqual(headerStatus({ ...base, pendingPermissions: [{}, {}, {}] }), { cls: 'awaiting', text: 'awaiting 3 permissions' });
  assert.deepEqual(headerStatus({ ...base, pendingPermission: {}, pendingPermissions: undefined }), { cls: 'awaiting', text: 'awaiting permission' });
  assert.deepEqual(headerStatus({ ...base, healing: true, pendingPermissions: [{}] }), { cls: 'healing', text: 'healing' });
  assert.deepEqual(headerStatus({ ...base, errors: [{}] }), { cls: 'error', text: 'error' });
  assert.deepEqual(headerStatus({ ...base, serverStatus: 'offline' }), { cls: '', text: 'offline' });
  assert.deepEqual(headerStatus({ ...base, serverStatus: 'reconnecting' }), { cls: 'reconnecting', text: 'reconnecting' });
});

// ── capability gating (ground rule: never break on an older server) ─────────

test('a gated request is not sent to a server that does not list its type', async () => {
  const caps = createCapabilities();
  const sent = [];
  const send = async (payload, timeoutMs) => { sent.push([payload, timeoutMs]); return { type: `${payload.type}:result`, status: 200, data: 1 }; };

  // A server that predates the list advertises nothing.
  const refused = await gatedRequest(caps, send, { type: 'session:status', sessionId: 's' });
  assert.deepEqual(refused, { type: 'session:status:result', ok: false, unsupported: true, status: 501, error: UNSUPPORTED_MESSAGE });
  assert.deepEqual(sent, []);
  assert.equal(replyFailed(refused), true);

  caps.set(['init', 'session:status']);
  assert.deepEqual(await gatedRequest(caps, send, { type: 'session:status', sessionId: 's' }, 5000), { type: 'session:status:result', status: 200, data: 1 });
  assert.deepEqual(sent, [[{ type: 'session:status', sessionId: 's' }, 5000]]);
  assert.equal(caps.has('session:status'), true);
  assert.equal(caps.hasAll('init', 'session:status'), true);
  assert.equal(caps.hasAll('init', 'permission:list'), false);
});

test('capabilities notify on change only and clear on disconnect', () => {
  const caps = createCapabilities();
  let changes = 0;
  const off = caps.subscribe(() => { changes += 1; });
  caps.set(['a', 'b']);
  caps.set(['b', 'a']);
  assert.equal(changes, 1);
  caps.set(undefined); // an init:result from a server without the list
  assert.equal(changes, 2);
  assert.deepEqual(caps.list(), []);
  caps.set(['a', 7, '', null]);
  assert.deepEqual(caps.list(), ['a']);
  caps.clear();
  assert.equal(caps.has('a'), false);
  off();
  caps.set(['z']);
  assert.equal(changes, 4);
});

test('replyFailed and replyError read every reply shape the server sends', () => {
  assert.equal(replyFailed(null), true);
  assert.equal(replyFailed({ type: 'error', id: 1, error: 'unknown message type: session:status' }), true);
  assert.equal(replyFailed({ ok: false, error: 'x' }), true);
  assert.equal(replyFailed({ status: 404, data: {} }), true);
  assert.equal(replyFailed({ status: 204 }), false);
  assert.equal(replyFailed({ ok: true }), false);
  assert.equal(replyError({ type: 'error', error: 'unknown message type: x' }), 'unknown message type: x');
  assert.equal(replyError({ status: 500, data: { error: 'boom' } }), 'boom');
  assert.equal(replyError({ status: 404 }, 'Revert failed'), 'Revert failed (HTTP 404)');
  assert.equal(replyError(null, 'Nope'), 'Nope');
  assert.equal(replyError({ error: { name: 'X' } }), '{"name":"X"}');
});

test('requestsForPanel keeps the session own requests and those of a verified sub-agent without a panel', async () => {
  const list = [
    { id: 'a', sessionID: 'ses_1' },
    { id: 'b', sessionID: 'ses_child_open' },
    { id: 'c', sessionID: 'ses_child_hidden' },
    { id: 'd' },
    { id: 'e', sessionID: 'ses_stranger' },
  ];
  const hasPanel = (sid) => sid === 'ses_1' || sid === 'ses_child_open';
  // Both children descend from ses_1; the stranger is another root on the same serve.
  const isDescendant = async (owner, ancestor) => ancestor === 'ses_1' && owner.startsWith('ses_child');
  const idsOf = async (...args) => (await requestsForPanel(...args)).map((r) => r.id);
  assert.deepEqual(await idsOf(list, 'ses_1', { hasPanel, isDescendant }), ['a', 'c']);
  // A child panel takes its own, never its parent's or a sibling's.
  assert.deepEqual(await idsOf(list, 'ses_child_open', { hasPanel, isDescendant }), ['b']);
  // Without a way to verify ancestry only the session's own requests remain.
  assert.deepEqual(await idsOf(list, 'ses_1', { hasPanel }), ['a']);
  assert.deepEqual(await requestsForPanel(null, 'ses_1'), []);
});

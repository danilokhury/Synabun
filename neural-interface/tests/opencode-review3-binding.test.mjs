// Code review 3 of the OpenCode panel: the binding rule itself.
// One class of defect, found in sixteen places: an asynchronous action starts
// on session A and, when the user switches session while it is in flight,
// lands on session B. This file tests the one mechanism every flow uses
// (public/shared/ocp-v2/ocp-v2-binding.js) and the store it is built on. The
// flows are in opencode-review3-flows.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createPanelStore } from '../public/shared/ocp-v2/ocp-v2-state.js';
import {
  captureBinding, bindingOf, isBindingToken, trackBinding, onRebind, latestOnly, searchOnBinding, boundReader,
} from '../public/shared/ocp-v2/ocp-v2-binding.js';
import { hydrateTranscript, rehydratePanelSession } from '../public/shared/ocp-v2/ocp-v2-rehydrate.js';
import { endTurn, settleFailedSend, trackOptimisticMessage } from '../public/shared/ocp-v2/ocp-v2-send-logic.js';
import {
  createParkedPrompts, parkedPromptsNotice, createPromptQueue, PROMPT_QUEUE_MAX,
} from '../public/shared/ocp-v2/ocp-v2-composer-logic.js';

const dir = new URL('../public/shared/ocp-v2/', import.meta.url);
const source = (name) => readFileSync(new URL(name, dir), 'utf8');
const deferred = () => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
function boundStore(sessionId = 'ses_a', info = {}) {
  const store = createPanelStore();
  store.setSession(sessionId, { id: sessionId, ...info });
  return store;
}

// ── The identity ────────────────────────────────────────────────────────────

test('the binding identity changes on every rebinding, and only then', () => {
  const store = createPanelStore();
  assert.equal(store.getBinding(), 0);
  assert.equal(bindingOf(store), 0);
  const seen = [store.getBinding()];
  const move = (id) => { store.setSession(id, id ? { id } : null); seen.push(store.getBinding()); };
  move('ses_a');          // a new session
  move('ses_b');          // a switch
  move(null);             // a project change drops the session…
  move('ses_c');          // …and binds the one created in the new project
  move('ses_a');          // back to a session it was on before
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5], 'every move is a new binding, A → B → A included');
  assert.equal(store.getRevisions().binding, store.getBinding(), 'the same counter the recovery guards read');

  // What is not a rebinding: fresh metadata, a rename, the directory, the
  // model, the transcript being cleared.
  const before = store.getBinding();
  store.setSession('ses_a', { id: 'ses_a', title: 'renamed' });
  store.setSessionInfo({ id: 'ses_a', title: 'again' });
  store.setCwd('/proj');
  store.setModel({ providerID: 'p', modelID: 'm' });
  store.clearMessages();
  store.setRunning(true);
  assert.equal(store.getBinding(), before);

  // A store without the counter (a stub) has binding 0, never undefined.
  assert.equal(bindingOf({ getState: () => ({}) }), 0);
  assert.equal(bindingOf({ getRevisions: () => ({ binding: 7 }) }), 7);
});

test('a rebinding is one step: no listener sees the new session with the old one\'s state', () => {
  const store = boundStore('ses_a');
  store.setRunning(true);
  store.setSessionStatus({ type: 'busy' });
  store.setAutoAccept(true);
  store.setTodos([{ content: 'x', status: 'pending' }]);
  store.setSessionDiff([{ file: 'a.js' }]);
  store.addPendingPermission({ id: 'per_a', sessionID: 'ses_a' });
  store.addPendingQuestion({ id: 'que_a', sessionID: 'ses_a', questions: [] });

  const seen = [];
  store.subscribe((event, s) => {
    seen.push({
      type: event.type, sessionId: s.sessionId, binding: store.getBinding(), running: s.running,
      status: s.sessionStatus.type, permissions: s.pendingPermissions.length, questions: s.pendingQuestions.length,
      todos: s.todos.length, diff: s.sessionDiff.length, autoAccept: s.autoAccept,
    });
  });
  store.setSession('ses_b', { id: 'ses_b' });
  assert.deepEqual(seen.map((e) => e.type), ['running:set', 'permission:set', 'questions:set', 'session:set']);
  for (const event of seen) {
    assert.deepEqual(
      { ...event, type: undefined },
      { type: undefined, sessionId: 'ses_b', binding: 2, running: false, status: 'idle', permissions: 0, questions: 0, todos: 0, diff: 0, autoAccept: false },
      `during ${event.type}`,
    );
  }
});

// ── The token ───────────────────────────────────────────────────────────────

test('captureBinding is a frozen snapshot: what an action reads after its await', async () => {
  const store = boundStore('ses_a', { title: 'A', directory: '/proj-a' });
  store.setCwd('/proj-a');
  store.setModel({ providerID: 'anthropic', modelID: 'model-a' });
  store.setVariant('high');
  store.setAgent('plan');
  store.setMcpProfile('browser');

  const live = store.getState();
  const at = captureBinding(store);
  assert.equal(isBindingToken(at), true);
  assert.equal(isBindingToken('ses_a'), false);
  assert.equal(isBindingToken(live), false);
  assert.equal(Object.isFrozen(at), true);
  assert.equal(at.isCurrent(), true);

  // The user moves while the action is out.
  store.setSession('ses_b', { id: 'ses_b', title: 'B', directory: '/proj-b' });
  store.setCwd('/proj-b');
  store.setModel({ providerID: 'openai', modelID: 'model-b' });
  store.setVariant(null);
  store.setAgent('build');
  store.setMcpProfile('full');
  await null;

  // The live state is session B's by now. This is the defect.
  assert.equal(live.sessionId, 'ses_b');
  assert.equal(live.cwd, '/proj-b');
  // The token still says where the action started.
  assert.deepEqual(
    { sessionId: at.sessionId, cwd: at.cwd, directory: at.directory, model: at.model, variant: at.variant, agent: at.agent, mode: at.mode, mcpProfile: at.mcpProfile, title: at.sessionInfo.title },
    { sessionId: 'ses_a', cwd: '/proj-a', directory: '/proj-a', model: { providerID: 'anthropic', modelID: 'model-a' }, variant: 'high', agent: 'plan', mode: 'plan', mcpProfile: 'browser', title: 'A' },
  );
  assert.equal(at.isCurrent(), false);
  assert.equal(at.isStale(), true);
  assert.equal(at.sameCwd(), false);
  // Its copy of the session info is its own.
  store.setSession('ses_a', { id: 'ses_a', title: 'A, later' });
  assert.equal(at.sessionInfo.title, 'A');
});

test('A → B → A is a new binding: a token of the first visit stays stale', () => {
  const store = boundStore('ses_a');
  const first = captureBinding(store);
  store.setSession('ses_b', { id: 'ses_b' });
  const onB = captureBinding(store);
  store.setSession('ses_a', { id: 'ses_a' });
  const second = captureBinding(store);
  assert.equal(store.getState().sessionId, first.sessionId, 'the session id is the same again');
  assert.equal(first.isCurrent(), false, 'and the first visit is over all the same');
  assert.equal(onB.isCurrent(), false);
  assert.equal(second.isCurrent(), true);
  assert.notEqual(first.binding, second.binding);

  // Leaving for no session at all and coming back is a move too.
  store.setSession(null, null);
  assert.equal(second.isCurrent(), false);
  const none = captureBinding(store);
  assert.equal(none.sessionId, null);
  assert.equal(none.isCurrent(), true);
  store.setSession('ses_a', { id: 'ses_a' });
  assert.equal(second.isCurrent(), false);
  assert.equal(none.isCurrent(), false);
});

test('a token can be pinned to a session and carry a veto', () => {
  const store = boundStore('ses_a');
  // Recovery is asked for a session by id.
  const pinned = captureBinding(store, { sessionId: 'ses_a' });
  assert.equal(pinned.isCurrent(), true);
  // Pinned to a session the store is not on: never current, not even when
  // the store gets there (that is another binding).
  const other = captureBinding(store, { sessionId: 'ses_b' });
  assert.equal(other.sessionId, 'ses_b');
  assert.equal(other.isCurrent(), false);
  store.setSession('ses_b', { id: 'ses_b' });
  assert.equal(other.isCurrent(), false);
  assert.equal(pinned.isCurrent(), false);

  // "This child panel is still the open one."
  let open = true;
  const child = captureBinding(store, { isCurrent: () => open });
  assert.equal(child.isCurrent(), true);
  open = false;
  assert.equal(child.isCurrent(), false);
  const throwing = captureBinding(store, { isCurrent: () => { throw new Error('gone'); } });
  assert.equal(throwing.isCurrent(), false, 'a veto that cannot answer is a no');
  const truthy = captureBinding(store, { isCurrent: () => 'yes' });
  assert.equal(truthy.isCurrent(), false, 'only true is yes');
});

test('trackBinding and onRebind report each move once, with the new binding', () => {
  const store = boundStore('ses_a');
  const tracker = trackBinding(store);
  assert.equal(tracker.changed(), false);
  store.setSession('ses_a', { id: 'ses_a', title: 'renamed' });
  assert.equal(tracker.changed(), false, 'a rename is not a move');
  store.setSession('ses_b', { id: 'ses_b' });
  assert.equal(tracker.changed(), true);
  assert.equal(tracker.changed(), false, 'once per move');

  const moves = [];
  store.setRunning(true);
  const off = onRebind(store, (at) => moves.push([at.sessionId, at.isCurrent(), store.getState().running]));
  store.setRunning(false);
  store.setRunning(true);
  assert.deepEqual(moves, []);
  store.setSession('ses_c', { id: 'ses_c' });       // emits running:set, then session:set
  assert.deepEqual(moves, [['ses_c', true, false]], 'one call, already on the new binding');
  store.setSession('ses_b', { id: 'ses_b' });
  store.setSession('ses_c', { id: 'ses_c' });
  assert.equal(moves.length, 3);
  off();
  store.setSession('ses_d', { id: 'ses_d' });
  assert.equal(moves.length, 3);
});

test('latestOnly: a newer request, or a cancel, takes the answer away from an older one', () => {
  const requests = latestOnly();
  const first = requests.begin();
  assert.equal(first(), true);
  const second = requests.begin();
  assert.equal(first(), false);
  assert.equal(second(), true);
  requests.cancel();
  assert.equal(second(), false);
  assert.equal(requests.begin()(), true);
});

test('searchOnBinding hands an answer out only for the binding and directory it was asked under', async () => {
  const store = boundStore('ses_a');
  store.setCwd('/proj-a');
  const asked = [];
  let pending = null;
  const search = searchOnBinding(store, () => store.getState().cwd, (query, where) => {
    asked.push([query, where]);
    pending = deferred();
    return pending.promise;
  });

  // Nothing moves: the answer comes back.
  let out = search('ru');
  pending.resolve(['a-row']);
  assert.deepEqual(await out, ['a-row']);
  assert.deepEqual(asked[0], ['ru', { sessionId: 'ses_a', cwd: '/proj-a' }], 'the search gets the captured session and directory');

  // The session changes while the search is out.
  out = search('ru');
  store.setSession('ses_b', { id: 'ses_b' });
  pending.resolve(['a-row']);
  assert.equal(await out, null);

  // A → B → A.
  store.setSession('ses_a', { id: 'ses_a' });
  out = search('ru');
  store.setSession('ses_b', { id: 'ses_b' });
  store.setSession('ses_a', { id: 'ses_a' });
  pending.resolve(['a-row']);
  assert.equal(await out, null);

  // The same session, another directory.
  out = search('ru');
  store.setCwd('/proj-b');
  pending.resolve(['a-row']);
  assert.equal(await out, null);
});

test('boundReader applies the latest read of the binding on screen, and nothing else', async () => {
  const store = boundStore('ses_a');
  store.setCwd('/proj-a');
  const read = boundReader(store);
  const painted = [];
  const paint = (value, at) => painted.push([value, at.sessionId]);

  const a = deferred();
  const first = read((at) => { assert.equal(at.sessionId, 'ses_a'); assert.equal(at.cwd, '/proj-a'); return a.promise; }, paint);
  store.setSession('ses_b', { id: 'ses_b' });
  const b = deferred();
  const second = read(() => b.promise, paint);
  a.resolve('rows of A');
  assert.equal(await first, false, 'session A\'s answer is not painted into session B');
  b.resolve('rows of B');
  assert.equal(await second, true);
  assert.deepEqual(painted, [['rows of B', 'ses_b']]);

  // A → B → A with the old read still out.
  const old = deferred();
  const stale = read(() => old.promise, paint);
  store.setSession('ses_a', { id: 'ses_a' });
  store.setSession('ses_b', { id: 'ses_b' });
  old.resolve('older rows of B');
  assert.equal(await stale, false);
  assert.equal(painted.length, 1);

  // Two reads on one binding: the later one wins, whichever answers first.
  const slow = deferred();
  const fast = deferred();
  const one = read(() => slow.promise, paint);
  const two = read(() => fast.promise, paint);
  fast.resolve('newer');
  assert.equal(await two, true);
  slow.resolve('older');
  assert.equal(await one, false);
  assert.deepEqual(painted[painted.length - 1], ['newer', 'ses_b']);

  // A failure is the reader's to report only while it is still fresh.
  const failing = deferred();
  const dropped = read(() => failing.promise, paint);
  store.setSession('ses_c', { id: 'ses_c' });
  failing.reject(new Error('socket closed'));
  assert.equal(await dropped, false, 'a stale failure is not thrown');
  await assert.rejects(read(async () => { throw new Error('socket closed'); }, paint), /socket closed/);
});

// ── One scheme, not two ─────────────────────────────────────────────────────

test('recovery is built on the same token (no second scheme beside it)', async () => {
  const rehydrate = source('ocp-v2-rehydrate.js');
  assert.match(rehydrate, /import \{ captureBinding \} from '\.\/ocp-v2-binding\.js';/);
  assert.match(rehydrate, /function bindingCheck\(store, sessionId, isCurrent\) \{\s+return captureBinding\(store, \{ sessionId, isCurrent \}\)\.isCurrent;/);
  assert.equal(/getRevisions\(\)\.binding/.test(rehydrate), false, 'the recovery reads the binding through the token only');

  // And it behaves as it did: an answer for a binding the panel left is dropped.
  const store = boundStore('ses_a');
  const list = deferred();
  const reading = hydrateTranscript(store, { sessionMessages: () => list.promise }, { sessionId: 'ses_a' });
  store.setSession('ses_b', { id: 'ses_b' });
  store.setSession('ses_a', { id: 'ses_a' });
  list.resolve({ status: 200, data: [{ info: { id: 'm1', role: 'assistant', sessionID: 'ses_a', time: { created: 1, completed: 2 } }, parts: [] }] });
  const out = await reading;
  assert.equal(out.superseded, true);
  assert.equal(store.getState().messageOrder.length, 0);

  // A caller's veto still rides along (the composer passes its turn's token).
  const turn = captureBinding(store);
  const moved = boundStore('ses_x');
  const vetoed = await hydrateTranscript(moved, { sessionMessages: async () => ({ status: 200, data: [] }) }, { sessionId: 'ses_x', isCurrent: () => false });
  assert.equal(vetoed.superseded, true);
  assert.equal(turn.isCurrent(), true);

  const gone = await rehydratePanelSession(store, { sessionGet: async () => ({ status: 200, data: { id: 'ses_q' } }) }, { sessionId: 'ses_q' });
  assert.equal(gone.moved, true, 'a recovery for a session the store is not on applies nothing');
});

test('every module that waits imports the binding helper, and nothing compares live session ids after an await', () => {
  // The modules of the audit table (opencode-build-log.md, run 4) that hold an
  // asynchronous flow touching session state.
  const users = [
    'ocp-v2-approvals.js', 'ocp-v2-autoaccept-button.js', 'ocp-v2-changes.js', 'ocp-v2-childpanel.js',
    'ocp-v2-compact-button.js', 'ocp-v2-context-gauge.js', 'ocp-v2-manager.js', 'ocp-v2-mention-hints.js',
    'ocp-v2-panel.js', 'ocp-v2-plan.js', 'ocp-v2-projectbar.js', 'ocp-v2-rehydrate.js', 'ocp-v2-render.js',
    'ocp-v2-send.js', 'ocp-v2-send-logic.js', 'ocp-v2-session-actions.js', 'ocp-v2-status.js',
  ];
  for (const name of users) {
    assert.match(source(name), /from '\.\/ocp-v2-binding\.js';/, `${name} uses the binding helper`);
  }
  // The helper itself depends on nothing (the store is handed to it).
  assert.equal(/^import /m.test(source('ocp-v2-binding.js')), false);
  // The old hand-made guards are gone: a session id read from the live state
  // and compared after an await says nothing about A → B → A.
  const handMade = /(getState\(\)\.sessionId|store\.getState\(\)\.sessionId) !== (sessionId|sid|turnSessionId|target\.sessionId)\b/;
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.js'))) {
    assert.equal(handMade.test(source(name)), false, `${name} compares a live session id instead of the binding`);
  }
});

// ── The store never takes a snapshot of another session ─────────────────────

test('a transcript snapshot item that names another session is not applied', () => {
  const store = boundStore('ses_b');
  store.hydrateMessages([
    { info: { id: 'm_a', role: 'assistant', sessionID: 'ses_a' }, parts: [{ id: 'p_a', messageID: 'm_a', type: 'tool', tool: 'question', state: { status: 'running' } }] },
    { info: { id: 'm_b', role: 'assistant', sessionID: 'ses_b' }, parts: [{ id: 'p_b', messageID: 'm_b', type: 'text', text: 'hello' }] },
    { info: { id: 'm_local', role: 'user' }, parts: [{ id: 'p_l', messageID: 'm_local', type: 'text', text: 'no owner named' }] },
  ]);
  assert.deepEqual(store.getState().messageOrder, ['m_b', 'm_local']);
  assert.equal(store.getState().messages.has('m_a'), false);
});

// ── Turns ───────────────────────────────────────────────────────────────────

test('endTurn with a turn token: an old completion never clears a newer turn of the same session', () => {
  const store = boundStore('ses_a');
  store.setRunning(true);
  const oldTurn = captureBinding(store);
  // The user looks at B and comes back; a new turn of A is running.
  store.setSession('ses_b', { id: 'ses_b' });
  store.setSession('ses_a', { id: 'ses_a' });
  store.setRunning(true);
  const newTurn = captureBinding(store);
  // The session-id check the composer used to make says "mine".
  assert.equal(store.getState().sessionId, oldTurn.sessionId);
  assert.equal(endTurn(store, oldTurn), false, 'the old turn\'s completion is not for this binding');
  assert.equal(store.getState().running, true, 'the newer turn keeps running');
  assert.equal(endTurn(store, newTurn), true);
  assert.equal(store.getState().running, false);
  // A bare id is still accepted (older callers), compared by id.
  store.setRunning(true);
  assert.equal(endTurn(store, 'ses_zzz'), false);
  assert.equal(endTurn(store, 'ses_a'), true);
});

test('the optimistic bubble stops watching a store that was bound to another session', () => {
  const store = boundStore('ses_a');
  store.upsertMessage({ id: 'local-user-1', role: 'user' });
  const turn = captureBinding(store);
  let drops = 0;
  const tracker = trackOptimisticMessage(store, { optimisticId: 'local-user-1', existingMessageIds: [], onDrop: () => { drops += 1; }, isCurrent: turn.isCurrent });
  store.clearMessages();
  store.setSession('ses_b', { id: 'ses_b' });
  // A user message of session B with a part: not this prompt's server copy.
  store.upsertMessage({ id: 'msg_b', role: 'user' });
  store.upsertPart({ id: 'p_b', messageID: 'msg_b', type: 'text', text: 'B' });
  assert.equal(drops, 0, 'session B\'s message did not "replace" session A\'s bubble');
  assert.equal(tracker.dropped(), true, 'and the tracker let go');
});

// ── A failed send after a move ──────────────────────────────────────────────

test('settleFailedSend: on its own binding the composer handles it; after a move the prompt is parked for its session', () => {
  const store = boundStore('ses_a');
  const parked = createParkedPrompts();
  const item = { text: 'ship it', images: [{ name: 'a.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AA' }], paths: ['/proj/a.js'], mentions: [{ type: 'file', url: 'file:///proj/b.js' }] };

  const here = captureBinding(store);
  assert.deepEqual(settleFailedSend(here, parked, { item, error: 'boom' }), { here: true, parked: false });
  assert.equal(parked.size(), 0, 'nothing is parked while the panel is still on the session');

  const turn = captureBinding(store);
  store.setSession('ses_b', { id: 'ses_b' });
  assert.deepEqual(settleFailedSend(turn, parked, { item, error: 'provider said no' }), { here: false, parked: true });
  assert.equal(parked.has('ses_a'), true);
  assert.equal(parked.has('ses_b'), false, 'never under the session on screen');

  // Back on A (a new binding): they come out, whole, once.
  assert.equal(parked.take('ses_b'), null);
  const back = parked.take('ses_a');
  assert.deepEqual(back.items, [item]);
  assert.deepEqual(back.errors, ['provider said no']);
  assert.notEqual(back.items[0].images, item.images, 'a copy');
  assert.equal(parked.take('ses_a'), null);
  assert.match(parkedPromptsNotice(back), /^A prompt sent to this session was not delivered \(provider said no\)\. It is in the queue, paused/);
  assert.match(parkedPromptsNotice({ items: [item, item], errors: [] }), /^2 prompts sent to this session were not delivered\. They are in the queue, paused/);
  assert.equal(parkedPromptsNotice(null), '');

  // A stop the user asked for carries no reason; nothing without a session.
  const stopped = captureBinding(store);
  store.setSession(null, null);
  assert.deepEqual(settleFailedSend(stopped, parked, { item }), { here: false, parked: true });
  assert.deepEqual(parked.take('ses_b').errors, []);
  const none = captureBinding(store);
  store.setSession('ses_a', { id: 'ses_a' });
  assert.deepEqual(settleFailedSend(none, parked, { item, error: 'x' }), { here: false, parked: false });

  // Bounded without evicting (review 5, W01): every entry is prompts the user
  // has not sent, so nothing falls out; a full parking is reported instead.
  const small = createParkedPrompts({ max: 2 });
  for (const id of ['s1', 's2', 's3']) small.park(id, { item });
  assert.deepEqual([small.has('s1'), small.has('s2'), small.has('s3')], [true, true, true]);
  assert.equal(small.isFull(), true);
  assert.equal(small.park('', { item }), false);
  assert.equal(small.park('s4', {}), false);
});

test('the queue takes parked prompts back at the front, in order, and holds', () => {
  const queue = createPromptQueue();
  queue.add({ text: 'typed after coming back' });
  let notified = 0;
  queue.subscribe(() => { notified += 1; });
  assert.equal(queue.restore([{ text: 'first' }, null, { text: '', images: [{ name: 'x' }] }]), 2);
  assert.deepEqual(queue.list().map((item) => item.text), ['first', '', 'typed after coming back']);
  assert.equal(queue.isPaused(), true, 'nothing goes out until the user resumes');
  assert.equal(notified, 1);
  assert.equal(new Set(queue.list().map((item) => item.id)).size, 3, 'fresh ids');
  assert.equal(queue.restore([]), 0);
  // They were accepted once already: the cap does not drop them.
  const full = createPromptQueue();
  for (let i = 0; i < PROMPT_QUEUE_MAX; i++) full.add({ text: `q${i}` });
  assert.equal(full.restore([{ text: 'back' }]), 1);
  assert.equal(full.size(), PROMPT_QUEUE_MAX + 1);
  // Leaving the session empties the queue; the parking, not the queue, keeps them.
  queue.clear();
  assert.equal(queue.size(), 0);
  assert.equal(queue.isPaused(), false);
});

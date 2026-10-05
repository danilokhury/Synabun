// Code review 3 of the OpenCode panel: the findings, one by one.
// T01 to T16 and the remainders of R01, R02, R03 and N02 are the same defect in
// different places: an action starts on session A, the user switches session
// while it is out, and its answer lands on session B. Each test below switches
// the binding in the middle of the flow (to B, and A → B → A) and checks that
// nothing of A reaches B. The mechanism is tested in
// opencode-review3-binding.test.mjs; the DOM glue (composer, plan lifecycle,
// env popover, changes viewer, @ picker, sub-agent manager) runs under the DOM
// stand-in in opencode-review3-glue.run.mjs, started at the end of this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPanelStore } from '../public/shared/ocp-v2/ocp-v2-state.js';
import { captureBinding } from '../public/shared/ocp-v2/ocp-v2-binding.js';
import {
  transcriptQuestionCard, ownsTranscriptCard, answerQuestion, skipQuestion, replyToPermission, requestOwnership,
  autoAcceptRequest, FOREIGN_REQUEST_MESSAGE, QUESTION_NOT_PENDING_MESSAGE,
} from '../public/shared/ocp-v2/ocp-v2-approvals.js';
import {
  revertToMessage, retryFromMessage, restoreReverted, forkSession, deleteMessage, shareSession, unshareSession,
  readTranscriptExport, loadSelectedSession, applySessionSelections, stopForNavigation, createSessionForNavigation,
  renameSession, setSessionMcpProfile,
} from '../public/shared/ocp-v2/ocp-v2-session-actions.js';
import { stopAutomationRun } from '../public/shared/ocp-v2/ocp-v2-automation-ownership.js';
import { inheritChildPanelMcpProfile } from '../public/shared/ocp-v2/ocp-v2-profile-inheritance.js';
import { createAgentChoice } from '../public/shared/ocp-v2/ocp-v2-composer-logic.js';

const source = (name) => readFileSync(new URL(`../public/shared/ocp-v2/${name}`, import.meta.url), 'utf8');
const deferred = () => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const ok = (data) => ({ status: 200, data });
function boundStore(sessionId = 'ses_a', info = {}) {
  const store = createPanelStore();
  store.setSession(sessionId, { id: sessionId, ...info });
  return store;
}
// The two ways a panel leaves a binding while something is out.
const MOVES = [
  ['to B', (store) => store.setSession('ses_b', { id: 'ses_b', title: 'B' })],
  ['A → B → A', (store) => { store.setSession('ses_b', { id: 'ses_b', title: 'B' }); store.setSession('ses_a', { id: 'ses_a', title: 'A' }); }],
];
const questionPart = (extra = {}) => ({
  id: 'prt_q', callID: 'call_q', messageID: 'msg_q', type: 'tool', tool: 'question',
  state: { status: 'running', input: { questions: [{ question: 'Which?', options: [{ label: 'One' }] }] } }, ...extra,
});
const QUESTIONS = [{ question: 'Which?', options: [{ label: 'One' }] }];

// ── T01 (blocker), and the remainder of R01 ─────────────────────────────────

test('T01: a question card is drawn from the transcript only for a part of the bound session', () => {
  const store = boundStore('ses_b');
  // However it got there (a late snapshot, a replay): a part of session A.
  store.upsertMessage({ id: 'msg_q', role: 'assistant', sessionID: 'ses_a' });
  store.upsertPart(questionPart());
  assert.equal(transcriptQuestionCard(store, questionPart(), QUESTIONS), null, 'the message names session A');
  assert.equal(transcriptQuestionCard(store, questionPart({ sessionID: 'ses_a' }), QUESTIONS), null, 'the part names session A');

  // Its own part gets a card that knows its owner and the binding it was drawn under.
  const own = boundStore('ses_a');
  own.upsertMessage({ id: 'msg_q', role: 'assistant', sessionID: 'ses_a' });
  const card = transcriptQuestionCard(own, questionPart({ sessionID: 'ses_a' }), QUESTIONS);
  assert.deepEqual(card, { id: 'call_q', sessionID: 'ses_a', questions: QUESTIONS, _viaToolPart: true, _binding: own.getBinding() });
  assert.equal(ownsTranscriptCard(own, card), true);
  // A part that names nobody is the bound session's by construction, and says so.
  const bare = boundStore('ses_a');
  assert.equal(transcriptQuestionCard(bare, questionPart(), QUESTIONS).sessionID, 'ses_a');
  // No session bound: no card at all.
  assert.equal(transcriptQuestionCard(createPanelStore(), questionPart(), QUESTIONS), null);

  // The renderer builds its card through it, and has no other way.
  const render = source('ocp-v2-render.js');
  assert.match(render, /const synthetic = transcriptQuestionCard\(store, part, questions\);\s+if \(!synthetic\) \{/);
  assert.equal(render.includes('sessionID: part.sessionID || store.getState().sessionId'), false);
});

test('T01: a transcript card cannot be answered or skipped from a panel on another binding', async () => {
  for (const [name, move] of MOVES) {
    const store = boundStore('ses_a');
    const card = transcriptQuestionCard(store, questionPart({ sessionID: 'ses_a' }), QUESTIONS);
    const sent = [];
    const api = {
      questionList: async (p) => { sent.push(['list', p]); return ok([{ id: 'que_1', sessionID: 'ses_a', tool: { callID: 'call_q' } }]); },
      questionReply: async (p) => { sent.push(['reply', p]); return ok(true); },
      questionReject: async (p) => { sent.push(['reject', p]); return ok(true); },
      abort: async (id) => { sent.push(['abort', id]); return ok(true); },
    };
    move(store);
    // The card of the old binding is still in someone's hands (a click in flight).
    const answered = await answerQuestion(store, api, card, [['One']]);
    assert.deepEqual(answered, { ok: false, foreign: true, error: FOREIGN_REQUEST_MESSAGE }, name);
    const skipped = await skipQuestion(store, api, card);
    assert.equal(skipped.foreign, true, name);
    assert.deepEqual(sent, [], `${name}: nothing was listed, answered, rejected or aborted`);
  }
});

test('T01: ownership is checked at the click, after the pending list was read, and right before the reply', async () => {
  // Own card, nothing moves: listed and answered for the captured session and directory.
  const store = boundStore('ses_a', { directory: '/proj-a' });
  store.setCwd('/proj-a');
  const card = transcriptQuestionCard(store, questionPart({ sessionID: 'ses_a' }), QUESTIONS);
  const sent = [];
  const api = {
    questionList: async (p) => { sent.push(['list', p]); return ok([
      { id: 'que_other', sessionID: 'ses_other', tool: { callID: 'call_q' } },     // same call id, another session
      { id: 'que_1', sessionID: 'ses_a', tool: { callID: 'call_q' } },
    ]); },
    questionReply: async (p) => { sent.push(['reply', p]); return ok(true); },
  };
  assert.deepEqual(await answerQuestion(store, api, card, [['One']]), { ok: true, replyRequestId: 'que_1' });
  assert.deepEqual(sent, [
    ['list', { cwd: '/proj-a', sessionId: 'ses_a' }],
    ['reply', { requestId: 'que_1', answers: [['One']], cwd: '/proj-a', sessionId: 'ses_a' }],
  ], 'the request of the card\'s own session is answered, never another session\'s with the same call id');

  // The panel moves while the pending list is being read.
  for (const [name, move] of MOVES) {
    const moving = boundStore('ses_a', { directory: '/proj-a' });
    moving.setCwd('/proj-a');
    const movingCard = transcriptQuestionCard(moving, questionPart({ sessionID: 'ses_a' }), QUESTIONS);
    const list = deferred();
    const calls = [];
    const pending = answerQuestion(moving, {
      questionList: (p) => { calls.push(['list', p.sessionId, p.cwd]); return list.promise; },
      questionReply: async (p) => { calls.push(['reply', p]); return ok(true); },
    }, movingCard, [['One']]);
    move(moving);
    moving.setCwd('/proj-b');
    list.resolve(ok([{ id: 'que_1', sessionID: 'ses_a', tool: { callID: 'call_q' } }]));
    assert.deepEqual(await pending, { ok: false, moved: true }, name);
    assert.deepEqual(calls, [['list', 'ses_a', '/proj-a']], `${name}: no reply left, and the list was asked for session A`);
  }

  // No pending request for the card: refused, nothing sent.
  const missing = await answerQuestion(store, { questionList: async () => ok([]), questionReply: async () => { throw new Error('must not be called'); } }, card, [['One']]);
  assert.deepEqual(missing, { ok: false, error: QUESTION_NOT_PENDING_MESSAGE });

  // Skip stops the turn of the card's own session.
  const aborted = [];
  assert.deepEqual(await skipQuestion(store, { abort: async (id) => { aborted.push(id); return ok(true); } }, card), { ok: true });
  assert.deepEqual(aborted, ['ses_a']);
});

test('T01 / R01: a queued request follows the same rule, for the question and the permission card', async () => {
  const isDescendant = async (owner, ancestor) => owner === 'ses_child' && ancestor === 'ses_a';
  // A foreign request in the queue: off the queue, nothing sent.
  const store = boundStore('ses_a');
  store.addPendingQuestion({ id: 'que_x', sessionID: 'ses_other', questions: QUESTIONS });
  const sent = [];
  const api = {
    questionReply: async (p) => { sent.push(['reply', p]); return ok(true); },
    questionReject: async (p) => { sent.push(['reject', p]); return ok(true); },
    permissionReply: async (p) => { sent.push(['permission', p]); return ok(true); },
  };
  assert.equal((await answerQuestion(store, api, { id: 'que_x', sessionID: 'ses_other', questions: QUESTIONS }, [['One']], { isDescendant })).foreign, true);
  assert.deepEqual(store.getState().pendingQuestions, []);
  store.addPendingQuestion({ id: 'que_y', sessionID: 'ses_other', questions: QUESTIONS });
  assert.equal((await skipQuestion(store, api, { id: 'que_y', sessionID: 'ses_other' }, { isDescendant })).foreign, true);
  assert.deepEqual(sent, []);

  // Its own, and a verified sub-agent's: answered on the panel's runtime; the skip names the owner.
  await answerQuestion(store, api, { id: 'que_own', sessionID: 'ses_a', questions: QUESTIONS }, [['One']], { isDescendant });
  await answerQuestion(store, api, { id: 'que_child', sessionID: 'ses_child', questions: QUESTIONS }, [['One']], { isDescendant });
  await skipQuestion(store, api, { id: 'que_child2', sessionID: 'ses_child' }, { isDescendant });
  assert.deepEqual(sent, [
    ['reply', { requestId: 'que_own', answers: [['One']], cwd: undefined, sessionId: 'ses_a' }],
    ['reply', { requestId: 'que_child', answers: [['One']], cwd: undefined, sessionId: 'ses_a' }],
    ['reject', { requestId: 'que_child2', sessionId: 'ses_child' }],
  ]);

  // The panel moves while ancestry is looked up: `moved`, nothing sent, and
  // nothing taken off the queue of the binding it is on now.
  for (const [name, move] of MOVES) {
    for (const act of ['question', 'skip', 'permission']) {
      const moving = boundStore('ses_a');
      const lookup = deferred();
      const calls = [];
      const movingApi = {
        questionReply: async (p) => { calls.push(p); return ok(true); },
        questionReject: async (p) => { calls.push(p); return ok(true); },
        permissionReply: async (p) => { calls.push(p); return ok(true); },
      };
      const req = { id: 'req_child', sessionID: 'ses_child', questions: QUESTIONS, permission: 'bash' };
      const slow = () => lookup.promise;
      const pending = act === 'question' ? answerQuestion(moving, movingApi, req, [['One']], { isDescendant: slow })
        : act === 'skip' ? skipQuestion(moving, movingApi, req, { isDescendant: slow })
        : replyToPermission(moving, movingApi, req, 'once', { isDescendant: slow });
      move(moving);
      // What the new binding's own recovery put in its queue meanwhile.
      moving.setPendingQuestions([{ id: 'req_child', sessionID: 'ses_child', questions: QUESTIONS }]);
      moving.setPendingPermissions([{ id: 'req_child', sessionID: 'ses_child', permission: 'bash' }]);
      lookup.resolve(true);
      assert.deepEqual(await pending, { ok: false, moved: true }, `${name} / ${act}`);
      assert.deepEqual(calls, [], `${name} / ${act}: nothing was sent`);
      assert.equal(moving.getState().pendingQuestions.length, 1, `${name} / ${act}: the new binding's queue is untouched`);
      assert.equal(moving.getState().pendingPermissions.length, 1);
    }
  }

  // requestOwnership names the three cases.
  assert.equal(await requestOwnership(store, { id: 'a', sessionID: 'ses_a' }, isDescendant), 'own');
  assert.equal(await requestOwnership(store, { id: 'b', sessionID: 'ses_other' }, isDescendant), 'foreign');
  const stale = captureBinding(store);
  store.setSession('ses_b', { id: 'ses_b' });
  assert.equal(await requestOwnership(store, { id: 'a', sessionID: 'ses_a' }, isDescendant, stale), 'moved');
});

test('T01 / R01: an automatic reply that comes back after a move does not touch the new binding\'s queue', async () => {
  for (const [name, move] of MOVES) {
    const store = boundStore('ses_a');
    store.setAutoAccept(true);
    const req = { id: 'per_1', sessionID: 'ses_a', permission: 'bash' };
    store.addPendingPermission(req);
    const reply = deferred();
    const pending = autoAcceptRequest(store, { permissionReply: () => reply.promise }, req, {});
    await null;
    move(store);
    // The same id pending again under the new binding: recovery re-read it and
    // that binding's own automatic reply is on its way (`_auto`).
    const reread = { ...req, _auto: true };
    store.setPendingPermissions([reread]);
    reply.resolve({ ok: false, status: 409, error: 'busy' });
    assert.equal(await pending, false, name);
    assert.deepEqual(store.getState().pendingPermissions, [reread], `${name}: a refused reply of the old binding does not hand the new binding's card back to the user`);

    // An accepted one does not take a card off the new binding's queue either
    // (permission.replied does that, for whoever holds the request).
    const again = boundStore('ses_a');
    again.addPendingPermission(req);
    const accepted = deferred();
    const answering = autoAcceptRequest(again, { permissionReply: () => accepted.promise }, req, {});
    await null;
    move(again);
    again.setPendingPermissions([{ ...req }]);
    accepted.resolve({ status: 200, data: true });
    assert.equal(await answering, true, name);
    assert.equal(again.getState().pendingPermissions.length, 1, `${name}: the queue of the binding on screen is untouched`);
  }
});

// ── T04: Retry and Undo ─────────────────────────────────────────────────────

function turnStore() {
  const store = boundStore('ses_a');
  store.upsertMessage({ id: 'msg_u', role: 'user' });
  store.upsertPart({ id: 'p1', messageID: 'msg_u', type: 'text', text: 'explain this' });
  store.upsertPart({ id: 'p2', messageID: 'msg_u', type: 'file', mime: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,AAAA' });
  store.upsertMessage({ id: 'msg_a', role: 'assistant', parentID: 'msg_u' });
  store.upsertPart({ id: 'p3', messageID: 'msg_a', type: 'text', text: 'answer' });
  return store;
}

test('T04: Retry never delivers session A\'s prompt into the session the user moved to', async () => {
  for (const [name, move] of MOVES) {
    // The switch happens while the revert is out.
    const store = turnStore();
    const revert = deferred();
    const reverted = [];
    const sent = [];
    const pending = retryFromMessage(store, { sessionRevert: (p) => { reverted.push([p.sessionId, p.messageID]); return revert.promise; } }, 'msg_a',
      async (text, extra) => { sent.push([text, extra]); return true; });
    await null;
    move(store);
    revert.resolve(ok({ id: 'ses_a', revert: { messageID: 'msg_u' } }));
    assert.deepEqual(await pending, { ok: false, moved: true }, name);
    assert.deepEqual(reverted, [['ses_a', 'msg_u']], `${name}: the revert went to session A`);
    assert.deepEqual(sent, [], `${name}: and its prompt was not sent anywhere`);
    assert.equal(store.getState().sessionInfo.revert, undefined, `${name}: the session on screen is not marked reverted`);
  }

  // The switch happens before the revert (while the resource list is read):
  // the message id of session A is never reverted in session B.
  const store = boundStore('ses_a');
  store.upsertMessage({ id: 'msg_u', role: 'user' });
  store.upsertPart({ id: 'p1', messageID: 'msg_u', type: 'text', text: 'look at @notes:alpha' });
  store.upsertPart({ id: 'p2', messageID: 'msg_u', type: 'text', synthetic: true, text: 'Reading MCP resource: alpha (notes://alpha)' });
  store.upsertPart({ id: 'p3', messageID: 'msg_u', type: 'text', synthetic: true, text: '# Alpha' });
  store.upsertMessage({ id: 'msg_a', role: 'assistant', parentID: 'msg_u' });
  const resources = deferred();
  const asked = [];
  const pending = retryFromMessage(store, {
    resourceList: (p) => { asked.push(['resources', p.sessionId]); return resources.promise; },
    sessionRevert: async (p) => { asked.push(['revert', p.sessionId, p.messageID]); return ok({ id: p.sessionId }); },
  }, 'msg_a', async () => { asked.push(['send']); return true; });
  await null;
  store.setSession('ses_b', { id: 'ses_b' });
  resources.resolve(ok([{ name: 'alpha', uri: 'notes://alpha', client: 'notes', mimeType: 'text/markdown' }]));
  assert.deepEqual(await pending, { ok: false, moved: true });
  assert.deepEqual(asked, [['resources', 'ses_a']], 'no revert and no send after the move');

  // The sender is handed the binding of the click, and Retry reports `moved`
  // (not an error) when the panel leaves during the send.
  const sending = turnStore();
  let handed = null;
  const out = await retryFromMessage(sending, { sessionRevert: async () => ok({ id: 'ses_a' }) }, 'msg_a', async (text, extra) => {
    handed = extra.binding;
    sending.setSession('ses_b', { id: 'ses_b' });
    return false;
  });
  assert.equal(handed.sessionId, 'ses_a');
  assert.equal(handed.isCurrent(), false);
  assert.deepEqual(out, { ok: false, moved: true });
  // Nothing moves: as before.
  assert.deepEqual(await retryFromMessage(turnStore(), { sessionRevert: async () => ok({ id: 'ses_a' }) }, 'msg_a', async () => true), { ok: true });
});

test('T04: Undo does not hand session A\'s prompt to the composer of another binding', async () => {
  for (const [name, move] of MOVES) {
    const store = turnStore();
    const revert = deferred();
    const pending = revertToMessage(store, { sessionRevert: () => revert.promise }, 'msg_u');
    await null;
    move(store);
    revert.resolve(ok({ id: 'ses_a', revert: { messageID: 'msg_u' } }));
    const out = await pending;
    // The callers (ocp-v2-render.js, ocp-v2-panel.js) put the prompt in the
    // composer only for `ok`, and report an error only when not `moved`.
    assert.deepEqual(out, { ok: false, moved: true }, name);
    assert.equal(out.text, undefined, `${name}: no text for the composer`);
    assert.equal(store.getState().sessionInfo.revert, undefined, name);
  }
  // A failed revert after a move is not this session's banner either.
  const store = turnStore();
  const revert = deferred();
  const pending = revertToMessage(store, { sessionRevert: () => revert.promise }, 'msg_u');
  await null;
  store.setSession('ses_b', { id: 'ses_b' });
  revert.resolve({ ok: false, status: 409, error: 'busy' });
  assert.deepEqual(await pending, { ok: false, moved: true });

  const render = source('ocp-v2-render.js');
  assert.match(render, /if \(result && result\.ok === false && !result\.cancelled && !result\.moved\) store\.pushError/);
  const panel = source('ocp-v2-panel.js');
  assert.match(panel, /if \(result && result\.ok === false && !result\.cancelled && !result\.moved\) pushError/);
  assert.match(panel, /mentions: extra\?\.files \|\| \[\], allowEmptyText: true, binding: extra\?\.binding,/);
});

test('T04: restore, delete, share, unshare and fork answer for the session they were started on', async () => {
  for (const [name, move] of MOVES) {
    const actions = {
      restore: (store, reply) => { store.setSessionInfo({ id: 'ses_a', revert: { messageID: 'msg_u' } }); return restoreReverted(store, { sessionUnrevert: () => reply.promise }); },
      delete: (store, reply) => deleteMessage(store, { messageDelete: () => reply.promise }, 'msg_u'),
      share: (store, reply) => shareSession(store, { sessionShare: () => reply.promise }, async () => true),
      unshare: (store, reply) => unshareSession(store, { sessionUnshare: () => reply.promise }),
    };
    for (const [action, run] of Object.entries(actions)) {
      const store = turnStore();
      const reply = deferred();
      const pending = run(store, reply);
      await null; await null;
      move(store);
      store.upsertMessage({ id: 'msg_u', role: 'user' });        // a message of the binding on screen with the same id
      reply.resolve(ok({ id: 'ses_a', share: { url: 'https://share/a' }, revert: undefined }));
      const out = await pending;
      assert.equal(out.ok, false, `${name} / ${action}`);
      assert.equal(out.moved, true, `${name} / ${action}`);
      assert.equal(store.getState().sessionInfo.share, undefined, `${name} / ${action}: no share link of A on screen`);
      assert.equal(store.getState().messages.has('msg_u'), true, `${name} / ${action}: nothing was removed from the transcript on screen`);
    }
    // A fork that finishes after a move exists, and says it must not take the panel.
    const store = turnStore();
    const reply = deferred();
    const pending = forkSession(store, { sessionFork: (p) => { assert.equal(p.sessionId, 'ses_a'); return reply.promise; } }, 'msg_u');
    await null;
    move(store);
    reply.resolve(ok({ id: 'ses_fork' }));
    assert.deepEqual(await pending, { ok: true, session: { id: 'ses_fork' }, moved: true }, name);
  }
  // A share confirm answered after the panel moved publishes nothing.
  const store = turnStore();
  const confirm = deferred();
  let shared = 0;
  const pending = shareSession(store, { sessionShare: async () => { shared += 1; return ok({ share: { url: 'x' } }); } }, () => confirm.promise);
  store.setSession('ses_b', { id: 'ses_b' });
  confirm.resolve(true);
  assert.equal((await pending).ok, false);
  assert.equal(shared, 0);
  // (Review 4: the fork also carries the intent of its click, and is a tab once a newer navigation began.)
  assert.match(source('ocp-v2-render.js'), /await opts\.onOpenSession\?\.\(result\.session, \{ activate: !result\.moved, nav \}\);/);
  assert.match(source('ocp-v2-panel.js'), /async function openCreatedSession\(session, \{ activate = true, nav \} = \{\}\) \{\s+if \(!session\?\.id\) return;\s+if \(!activate \|\| \(nav && !nav\.isCurrent\(\)\)\) \{/);
});

// ── T06: rename ─────────────────────────────────────────────────────────────

test('T06: a rename that comes back after a move names its own session and leaves the one on screen alone', async () => {
  for (const [name, move] of MOVES) {
    const store = boundStore('ses_a', { title: 'A' });
    const target = captureBinding(store);          // the rename box opens
    const update = deferred();
    const updated = [];
    const pending = renameSession(store, { sessionUpdate: (id, body) => { updated.push([id, body]); return update.promise; } }, '  Better name ', { binding: target });
    move(store);
    const onScreen = { ...store.getState().sessionInfo };
    update.resolve(ok({}));
    const out = await pending;
    assert.deepEqual(out, { ok: true, sessionId: 'ses_a', title: 'Better name', applied: false }, name);
    assert.deepEqual(updated, [['ses_a', { title: 'Better name' }]], `${name}: session A was renamed`);
    assert.deepEqual(store.getState().sessionInfo, onScreen, `${name}: the session on screen kept its metadata`);
  }
  // The dialog names the session it was opened for, also when it is committed
  // after the user went to another session.
  const store = boundStore('ses_new', { title: '' });
  const dialog = captureBinding(store, { sessionId: 'ses_new' });
  store.setSession('ses_b', { id: 'ses_b', title: 'B' });
  const renamed = [];
  const out = await renameSession(store, { sessionUpdate: async (id) => { renamed.push(id); return ok({}); } }, 'Named later', { binding: dialog });
  assert.deepEqual(renamed, ['ses_new'], 'not the session on screen');
  assert.equal(out.applied, false);
  assert.equal(store.getState().sessionId, 'ses_b', 'and the panel is not bound back to the renamed session');
  assert.equal(store.getState().sessionInfo.title, 'B');

  // Nothing moves: the store gets the title, as before.
  const still = boundStore('ses_a', { title: 'A', directory: '/proj' });
  assert.deepEqual(await renameSession(still, { sessionUpdate: async () => ok({}) }, 'New'), { ok: true, sessionId: 'ses_a', title: 'New', applied: true });
  assert.deepEqual(still.getState().sessionInfo, { id: 'ses_a', title: 'New', directory: '/proj' });
  // A failure says whether it is this binding's to report.
  const failing = boundStore('ses_a');
  const failed = await renameSession(failing, { sessionUpdate: async () => { throw new Error('socket closed'); } }, 'x');
  assert.equal(failed.ok, false);
  assert.equal(failed.current, true);
  assert.equal(failed.error, 'socket closed');

  const panel = source('ocp-v2-panel.js');
  const rename = panel.slice(panel.indexOf('function beginRenameSession() {'), panel.indexOf('async function boot() {'));
  assert.match(rename, /const target = captureBinding\(getDefaultStore\(\)\);/);
  assert.match(rename, /return renameSession\(getDefaultStore\(\), api, next, \{ binding: target \}\);/);
  assert.equal(/setSession\(/.test(rename), false, 'the rename box binds nothing itself');
  const dialogSrc = panel.slice(panel.indexOf('function promptNameNewSession('), panel.indexOf('async function startSessionInNewWorktree('));
  assert.match(dialogSrc, /const target = captureBinding\(getDefaultStore\(\), targetSessionId \? \{ sessionId: targetSessionId \} : \{\}\);/);
  assert.match(dialogSrc, /const sid = target\.sessionId;/);
  assert.equal(/setSession\(sid, updated\)/.test(dialogSrc), false, 'the dialog no longer rebinds the panel to the session it named');
  // (Review 4, V04: only for a session that was created and is still on screen.)
  assert.match(panel, /if \(!shouldNameCreatedSession\(getDefaultStore\(\), nav, created\)\) return;\s+promptNameNewSession\(created\.sessionId\);/);
});

// ── T07, and the remainder of R03 ───────────────────────────────────────────

test('T07 / R03: the selection metadata of an earlier visit never replaces the newer one', async () => {
  const store = boundStore('ses_a');
  const first = deferred();
  const applied = [];
  const apply = (full) => { applied.push(full.model.id); applySessionSelections(store, full); };
  // Visit 1 of A asks for its detail.
  const early = loadSelectedSession(store, { sessionGet: () => first.promise }, 'ses_a', null, apply);
  // B, then A again: visit 2 asks too, and is answered first.
  store.setSession('ses_b', { id: 'ses_b' });
  store.setSession('ses_a', { id: 'ses_a' });
  const late = await loadSelectedSession(store, { sessionGet: async () => ok({ id: 'ses_a', version: '1', agent: 'plan', model: { providerID: 'openai', id: 'newer' } }) }, 'ses_a', null, apply);
  assert.equal(late.model.id, 'newer');
  // Now the answer of visit 1 arrives. Its session id matches. It is still not this selection's.
  first.resolve(ok({ id: 'ses_a', version: '1', agent: 'build', model: { providerID: 'anthropic', id: 'older' } }));
  assert.equal(await early, null);
  assert.deepEqual(applied, ['newer']);
  assert.deepEqual(store.getState().model, { providerID: 'openai', modelID: 'newer' });
  assert.equal(store.getState().agent, 'plan');

  // An answer for a session the panel left is dropped as before.
  const other = boundStore('ses_a');
  const slow = deferred();
  const gone = loadSelectedSession(other, { sessionGet: () => slow.promise }, 'ses_a', null, apply);
  other.setSession('ses_b', { id: 'ses_b' });
  slow.resolve(ok({ id: 'ses_a', version: '1', model: { providerID: 'p', id: 'm' } }));
  assert.equal(await gone, null);
  assert.equal(applied.length, 1);
});

// ── T08: the tool profile ───────────────────────────────────────────────────

test('T08: a profile change is saved under the session it was made for, and not shown on another', async () => {
  for (const [name, move] of MOVES) {
    const store = boundStore('ses_a');
    store.setMcpProfile('full');
    const saved = [];
    const reply = deferred();
    const pending = setSessionMcpProfile(store, { mcpProfileSet: (id, profile) => { saved.push(['asked', id, profile]); return reply.promise; } }, 'browser', {
      save: (id, profile) => saved.push(['saved', id, profile]),
    });
    move(store);
    store.setMcpProfile('memory');          // what the session on screen runs with
    reply.resolve(ok({ profile: 'browser' }));
    assert.deepEqual(await pending, { sessionId: 'ses_a', profile: 'browser', applied: false }, name);
    assert.deepEqual(saved, [['asked', 'ses_a', 'browser'], ['saved', 'ses_a', 'browser']], `${name}: under session A's key`);
    assert.equal(store.getState().mcpProfile, 'memory', `${name}: the profile on screen is untouched`);
  }
  // Nothing moves: saved and applied.
  const store = boundStore('ses_a');
  const saved = [];
  assert.deepEqual(await setSessionMcpProfile(store, { mcpProfileSet: async () => ok({ profile: 'browser' }) }, 'browser', { save: (...a) => saved.push(a) }),
    { sessionId: 'ses_a', profile: 'browser', applied: true });
  assert.equal(store.getState().mcpProfile, 'browser');
  assert.deepEqual(saved, [['ses_a', 'browser']]);
  // A refusal after a move says so, for the selector's rollback.
  const refused = boundStore('ses_a');
  const reply = deferred();
  const pending = setSessionMcpProfile(refused, { mcpProfileSet: () => reply.promise }, 'browser');
  refused.setSession('ses_b', { id: 'ses_b' });
  reply.resolve({ ok: false, status: 409, error: 'turn running' });
  await assert.rejects(pending, (err) => err.message === 'turn running' && err.stale === true);
  assert.equal(await setSessionMcpProfile(createPanelStore(), {}, 'browser'), null, 'no session: the caller edits the default');

  const bar = source('ocp-v2-projectbar.js');
  assert.match(bar, /const changed = await setSessionMcpProfile\(_currentStore, api, profile, \{ save: saveSessionProfile \}\);\s+if \(changed\?\.applied\) \{/);
  assert.equal(bar.includes('saveSessionProfile(state.sessionId, effective)'), false);
  assert.match(bar, /if \(version !== _profileSyncVersion \|\| !at\.isCurrent\(\)\) return;/);
});

// ── T11, and the remainder of N02 ───────────────────────────────────────────

test('T11 / N02: the agent a fallback replaced is forgotten when the composer moves to another session', () => {
  const lists = { '/proj': [{ name: 'build' }, { name: 'plan' }], '/proj+': [{ name: 'build' }, { name: 'plan' }, { name: 'reviewer' }] };
  // Session A wanted `reviewer`; this directory's list did not offer it: build.
  const choice = createAgentChoice();
  choice.enter('/proj', lists['/proj']);
  assert.equal(choice.settle('reviewer', '/proj'), 'build');
  // The composer moves to session B, whose own saved agent is build, and B's
  // catalog (the same directory, read later) offers `reviewer`.
  choice.forget();                                    // what onRebound does
  assert.equal(choice.accept('/proj', lists['/proj+'], '/proj'), true);
  assert.equal(choice.settle('build', '/proj'), null, 'session B keeps the agent it was restored with');

  // Without the forget this is the leak the review describes.
  const leaky = createAgentChoice();
  leaky.enter('/proj', lists['/proj']);
  leaky.settle('reviewer', '/proj');
  leaky.accept('/proj', lists['/proj+'], '/proj');
  assert.equal(leaky.settle('build', '/proj'), 'reviewer', '(the remembered agent would replace session B\'s)');

  // The composer forgets on every rebinding, before anything validates.
  const send = source('ocp-v2-send.js');
  const handler = send.slice(send.indexOf('const unsubscribe = store.subscribe((event, state) => {'), send.indexOf('const unsubscribeQueue ='));
  assert.ok(handler.indexOf('if (_rebind.changed()) onRebound(state);') > 0);
  assert.ok(handler.indexOf('if (_rebind.changed()) onRebound(state);') < handler.indexOf('validateAgent();'), 'before the directory validation');
  const rebound = send.slice(send.indexOf('function onRebound(state) {'), send.indexOf('function renderImageStrip() {'));
  // (Review 4, V01: the queue is parked for the session that was left before it is cleared.)
  assert.ok(rebound.indexOf('_parked.leave(left, _queue.list());') > 0 && rebound.indexOf('_parked.leave(left, _queue.list());') < rebound.indexOf('_queue.clear();'), 'parked before it is cleared');
  for (const line of ['_agentChoice.forget();', '_queue.clear();', 'setShellMode(false);', '_mentionHints?.hide();', 'restoreParkedHere();', '_parked.take(sessionId)']) {
    assert.ok(rebound.includes(line), `onRebound: ${line}`);
  }
  assert.equal(send.includes('_boundSessionId'), false, 'no session-id comparison beside the binding');
});

// ── T12: sub-agent panels ───────────────────────────────────────────────────

test('T12: a sub-agent of a session that is not on screen does not take the active session\'s profile', () => {
  const primary = boundStore('ses_b');
  primary.setMcpProfile('memory');                  // session B's profile
  const child = createPanelStore();
  const saved = (id) => ({ ses_a: 'browser' }[id] || null);
  // The child's parent is A; the primary panel is on B.
  assert.equal(inheritChildPanelMcpProfile(child, primary, null, { parentSessionId: 'ses_a', savedProfile: saved }), 'browser');
  assert.equal(child.getState().mcpProfile, 'browser', 'the parent\'s own saved profile, not session B\'s');
  // Nothing saved for the parent: what the child session carries, else nothing. Never B's.
  const second = createPanelStore();
  assert.equal(inheritChildPanelMcpProfile(second, primary, { mcpProfile: 'full' }, { parentSessionId: 'ses_a', savedProfile: () => null }), 'full');
  const third = createPanelStore();
  assert.equal(inheritChildPanelMcpProfile(third, primary, null, { parentSessionId: 'ses_a' }), null);
  assert.equal(third.getState().mcpProfile, null);
  // The parent is on screen: its store speaks for it, as before.
  const fourth = createPanelStore();
  assert.equal(inheritChildPanelMcpProfile(fourth, primary, { mcpProfile: 'full' }, { parentSessionId: 'ses_b', savedProfile: saved }), 'memory');
  assert.equal(inheritChildPanelMcpProfile(createPanelStore(), primary, null), 'memory', 'without a parent id the store is trusted (older callers)');

  const manager = source('ocp-v2-manager.js');
  const scan = manager.slice(manager.indexOf('async function scanForOrphanChildren() {'), manager.indexOf('function startManager() {'));
  assert.match(scan, /const at = captureBinding\(_primary\.store, \{ sessionId: parentSid \}\);\s+const latest = _orphanScans\.begin\(\);/);
  assert.ok(scan.indexOf('if (!latest() || !at.isCurrent()) return;') > scan.indexOf('await api.sessionList()'), 'rechecked after the answer');
  assert.ok(scan.indexOf('if (!latest() || !at.isCurrent()) return;') < scan.indexOf('ensureChildSpawn('), 'and before anything is materialized');
  assert.match(manager, /parentTitle: parentTitleFor\(_primary, parentSid\),/);
  assert.match(manager, /const info = !parentSid \|\| parentSid === bound \? s\?\.sessionInfo : s\?\.knownSessions\?\.get\?\.\(parentSid\);/);
  assert.match(manager, /if \(_primary\.getSessionId\?\.\(\) !== parentSessionId\) return;/, 'a child of A going idle does not poke the plan of B');
});

// ── T13: navigation ─────────────────────────────────────────────────────────

test('T13: a navigation that waited does not clear or replace what the user selected meanwhile', async () => {
  for (const [name, move] of MOVES) {
    // A project change stops the running turn of A first.
    const store = boundStore('ses_a');
    store.setRunning(true);
    const nav = captureBinding(store);
    const abort = deferred();
    const aborted = [];
    const pending = stopForNavigation(store, { abort: (id) => { aborted.push(id); return abort.promise; } }, nav);
    move(store);
    abort.resolve(ok(true));
    assert.equal(await pending, false, `${name}: the project change no longer owns the panel`);
    assert.deepEqual(aborted, ['ses_a'], `${name}: the turn that was stopped is session A's`);

    // A new session is created while the user picks another one.
    const creating = boundStore('ses_a');
    const create = deferred();
    const made = createSessionForNavigation(creating, { sessionCreate: (body, cwd) => { assert.deepEqual([body, cwd], [{ title: 'T' }, '/proj']); return create.promise; } }, { title: 'T', cwd: '/proj' });
    move(creating);
    create.resolve(ok({ id: 'ses_new' }));
    assert.deepEqual(await made, { session: { id: 'ses_new' }, activate: false }, `${name}: the new session is kept, not activated`);
  }
  // Nothing moves: the navigation goes on, as before.
  const store = boundStore('ses_a');
  store.setRunning(true);
  assert.equal(await stopForNavigation(store, { abort: async () => ok(true) }, captureBinding(store)), true);
  const idle = boundStore('ses_a');
  let aborts = 0;
  assert.equal(await stopForNavigation(idle, { abort: async () => { aborts += 1; } }, captureBinding(idle)), true);
  assert.equal(aborts, 0, 'nothing to stop');
  assert.deepEqual(await createSessionForNavigation(store, { sessionCreate: async () => ok({ id: 'ses_new' }) }, {}), { session: { id: 'ses_new' }, activate: true });
  await assert.rejects(createSessionForNavigation(store, { sessionCreate: async () => ok(null) }, {}), /session create returned no id/);
  // A navigation token taken at the user's gesture (the dialog's Save) decides,
  // however long the checkout or the worktree took.
  const waited = boundStore('ses_a');
  const nav = captureBinding(waited);
  waited.setSession('ses_b', { id: 'ses_b' });
  assert.equal((await createSessionForNavigation(waited, { sessionCreate: async () => ok({ id: 'ses_wt' }) }, { nav })).activate, false);

  const panel = source('ocp-v2-panel.js');
  const project = panel.slice(panel.indexOf('async function setActiveProject(path) {'), panel.indexOf('async function loadProjectsOnce() {'));
  // Review 4: the navigation token is an intent (ocp-v2-binding.js,
  // createNavigation), begun at the gesture; it binds through apply().
  assert.match(project, /const nav = _nav\.begin\(\);/);
  assert.match(project, /if \(!\(await stopForNavigation\(getDefaultStore\(\), api, nav\)\)\) return;\s+[\s\S]{0,120}if \(nav\.sessionId\) \{\s+nav\.apply\(\(\) => \{\s+clearMessages\(\);\s+setSession\(null, null\);/);
  assert.match(project, /await startFreshSession\(\{ cwd: next \|\| undefined, nav \}\);/);
  assert.equal(project.includes('sBefore'), false, 'no live state read after the abort');
  const fresh = panel.slice(panel.indexOf('async function startFreshSession('), panel.indexOf('async function setActiveProject('));
  assert.match(fresh, /if \(owner\.isCurrent\(\)\) clearMessages\(\);/);
  assert.match(fresh, /const activated = activate && owner\.apply\(\(\) => \{[\s\S]{0,420}setSession\(sess\.id, sess\);\s+bindPrimarySession\(getDefaultStore\(\), sess\.id\);[\s\S]{0,80}\}\);\s+if \(!activated\) ensureTab\(sess\.id, sess\);/);
  const worktree = panel.slice(panel.indexOf('async function startSessionInNewWorktree('), panel.indexOf('async function closeCurrentSession() {'));
  assert.match(worktree, /await startFreshSession\(\{ title: title \|\| undefined, cwd: created\.data\.directory, nav \}\);/);
  assert.match(panel, /if \(!shouldNameCreatedSession\(getDefaultStore\(\), nav, created\)\) return;/, 'no naming dialog over the session the user went to');
});

// ── T14: export ─────────────────────────────────────────────────────────────

test('T14: an export is one session, whole: its transcript under its own id, title and file name', async () => {
  for (const [name, move] of MOVES) {
    const store = boundStore('ses_a', { title: 'Alpha run', directory: '/proj-a' });
    const read = deferred();
    const pending = readTranscriptExport(store, { sessionMessages: (id) => { assert.equal(id, 'ses_a'); return read.promise; } });
    move(store);
    store.setSessionInfo({ id: store.getState().sessionId, title: 'Something else', directory: '/proj-b' });
    read.resolve(ok([{ info: { id: 'm1', role: 'user', sessionID: 'ses_a' }, parts: [{ id: 'p1', type: 'text', text: 'from A' }] }]));
    const out = await pending;
    assert.equal(out.ok, true, name);
    assert.equal(out.sessionId, 'ses_a', name);
    const doc = JSON.parse(out.json);
    assert.equal(doc.session.id, 'ses_a', `${name}: the metadata is session A's`);
    assert.equal(doc.session.title, 'Alpha run', name);
    assert.equal(doc.session.directory, '/proj-a', name);
    assert.match(out.filename, /alpha-run/i, `${name}: so is the file name`);
    assert.equal(/something-else|ses_b/i.test(out.filename + out.json), false, `${name}: nothing of the session on screen`);
  }
  // A failed read after a move is not reported in the session on screen.
  const store = boundStore('ses_a');
  const read = deferred();
  const pending = readTranscriptExport(store, { sessionMessages: () => read.promise });
  store.setSession('ses_b', { id: 'ses_b' });
  read.resolve({ ok: false, status: 500, error: 'boom' });
  assert.deepEqual(await pending, { ok: false, moved: true });
  assert.equal((await readTranscriptExport(boundStore('ses_a'), { sessionMessages: async () => ({ ok: false, error: 'boom' }) })).error, 'boom');
  assert.match(source('ocp-v2-panel.js'), /const out = await readTranscriptExport\(getDefaultStore\(\), api\);/);
});

// ── T16: automation bookkeeping ─────────────────────────────────────────────

test('T16: stopping session A\'s automation clears session A\'s bookkeeping, whatever is selected by then', async () => {
  for (const [name, move] of MOVES) {
    const store = boundStore('ses_a');
    const books = { runIds: new Map([['ses_a', 'run_a'], ['ses_b', 'run_b']]), running: new Set(['ses_a', 'ses_b']) };
    const stop = deferred();
    const stopped = [];
    // The composer hands the snapshot of the session Stop was pressed in.
    const turn = captureBinding(store);
    const pending = stopAutomationRun(turn.sessionId, books, (runId) => { stopped.push(runId); return stop.promise; });
    move(store);
    stop.resolve();
    assert.equal(await pending, true, name);
    assert.deepEqual(stopped, ['run_a'], name);
    assert.deepEqual([...books.running], ['ses_b'], `${name}: A is no longer running, B still is`);
    assert.equal(turn.sessionId, 'ses_a', 'the snapshot did not follow the store');
  }
  // Not an automation, or not running: the composer does its own abort.
  const books = { runIds: new Map([['ses_a', 'run_a']]), running: new Set() };
  assert.equal(await stopAutomationRun('ses_a', books, async () => { throw new Error('must not be called'); }), false);
  assert.equal(await stopAutomationRun('ses_x', { runIds: new Map(), running: new Set(['ses_x']) }, async () => {}), false);
  assert.equal(await stopAutomationRun('', books, async () => {}), false);

  const panel = source('ocp-v2-panel.js');
  assert.match(panel, /const stopped = await stopAutomationRun\(\s+session\?\.sessionId,\s+\{ runIds: _automationRunIds, running: _automationRunning \},/);
  assert.equal(panel.includes('_automationRunning.delete(session.sessionId)'), false);
  const send = source('ocp-v2-send.js');
  assert.match(send, /if \(opts\.onAbort && await opts\.onAbort\(turn\)\) \{/);
  assert.match(send, /try \{ opts\.onManualSend\?\.\(turn, phase, sendMeta\); \}/);
  assert.equal(/opts\.(onManualSend|onAbort|onBeforeSend|canSend)\??\.?\(s[,)]/.test(send), false, 'no callback is handed the live state');
});

// ── The DOM glue, under the stand-in ────────────────────────────────────────
// T02 (plan lifecycle), T03 and T05 (composer: reply, failure, queue), T09 (env
// popover), T10 (changes viewer), T12 (orphan scan), T15 (@ picker), and the
// rest of R02: these run the real modules against a socket stand-in.

test('T02, T03, T05, T09, T10, T12, T15, R02: the panel glue with the session switched mid-flight', () => {
  const script = fileURLToPath(new URL('./opencode-review3-glue.run.mjs', import.meta.url));
  const env = { ...process.env, SYNABUN_TYPESAFE: 'off' };
  delete env.SYNABUN_ASSISTANT_SESSION;
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 90_000, env });
  const stdout = String(result.stdout || '');
  const output = `${stdout}\n${result.stderr || ''}`;
  assert.equal(result.status, 0, output.slice(-4000));
  const steps = stdout.split('\n').filter((line) => /^(ok  |FAIL) /.test(line));
  assert.deepEqual(steps.filter((line) => line.startsWith('FAIL')), [], output.slice(-4000));
  for (const id of ['T02', 'T03', 'T05', 'T09', 'T10', 'T12', 'T15']) {
    assert.ok(steps.some((line) => line.startsWith('ok  ') && line.includes(id)), `a step for ${id} ran`);
  }
  assert.match(stdout, /\nno problems\s*$/, output.slice(-4000));
});

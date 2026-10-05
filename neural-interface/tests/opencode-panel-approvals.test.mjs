// OpenCode panel, cluster 2: approvals that cannot get lost. DOM-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelStore } from '../public/shared/ocp-v2/ocp-v2-state.js';
import { applyEvent, resolveEventTargets, permissionRequestId } from '../public/shared/ocp-v2/ocp-v2-events.js';
import {
  shouldAutoAccept, autoAcceptRequest, setAutoAccept, permissionCardView, permissionKind,
  ALWAYS_ALLOW_SCOPE, NEVER_AUTO_ACCEPT,
} from '../public/shared/ocp-v2/ocp-v2-approvals.js';
import { readFileSync } from 'node:fs';
import { rehydrateSessionState } from '../public/shared/ocp-v2/ocp-v2-rehydrate.js';

function boundStore(sessionId = 'ses_1') {
  const store = createPanelStore();
  store.setSession(sessionId, { id: sessionId });
  return store;
}
const ask = (id, extra = {}) => ({ id, sessionID: 'ses_1', permission: 'bash', patterns: ['git status'], metadata: {}, always: ['git *'], ...extra });
const ids = (store) => store.getState().pendingPermissions.map((p) => p.id);

test('a second permission request queues behind the first instead of replacing it', () => {
  const store = boundStore();
  const asked = [];
  const hooks = { onAsk: (_s, id, kind) => asked.push([kind, id]) };
  applyEvent(store, 'permission.asked', ask('per_1'), hooks);
  applyEvent(store, 'permission.asked', ask('per_2', { permission: 'edit' }), hooks);
  assert.deepEqual(ids(store), ['per_1', 'per_2']);
  assert.equal(store.getState().pendingPermission.id, 'per_1', 'older readers see the head of the queue');

  // The same request again (a replay after reconnect) updates in place, no second notification.
  applyEvent(store, 'permission.asked', ask('per_1', { patterns: ['git status --short'] }), hooks);
  assert.deepEqual(ids(store), ['per_1', 'per_2']);
  assert.deepEqual(store.getState().pendingPermissions[0].patterns, ['git status --short']);
  assert.deepEqual(asked, [['permission', 'per_1'], ['permission', 'per_2']]);
});

test('permission.replied is matched on requestID and removes only that request', () => {
  const store = boundStore();
  const cleared = [];
  const hooks = { onAskCleared: (id) => cleared.push(id) };
  applyEvent(store, 'permission.asked', ask('per_1'));
  applyEvent(store, 'permission.asked', ask('per_2'));
  // The 1.18 event shape: { sessionID, requestID, reply }; no `id`, no `permissionID`.
  applyEvent(store, 'permission.replied', { sessionID: 'ses_1', requestID: 'per_1', reply: 'once' }, hooks);
  assert.deepEqual(ids(store), ['per_2']);
  assert.equal(store.getState().pendingPermission.id, 'per_2');
  applyEvent(store, 'permission.replied', { sessionID: 'ses_1', requestID: 'per_unknown', reply: 'reject' }, hooks);
  assert.deepEqual(ids(store), ['per_2']);
  applyEvent(store, 'permission.replied', { sessionID: 'ses_1', requestID: 'per_2', reply: 'always' }, hooks);
  assert.deepEqual(ids(store), []);
  assert.equal(store.getState().pendingPermission, null);
  assert.deepEqual(cleared, ['per_1', 'per_unknown', 'per_2']);
  assert.equal(permissionRequestId({ requestID: 'a', id: 'b' }), 'a');
  // An event without any id touches nothing.
  applyEvent(store, 'permission.asked', { sessionID: 'ses_1' });
  applyEvent(store, 'permission.replied', { sessionID: 'ses_1' });
  assert.deepEqual(ids(store), []);
});

test('the single-slot setter still works for older callers', () => {
  const store = boundStore();
  store.setPendingPermission(ask('per_1'));
  store.setPendingPermission(ask('per_2'));
  assert.deepEqual(ids(store), ['per_1', 'per_2']);
  store.setPendingPermission(null);
  assert.deepEqual(ids(store), []);
  assert.equal(store.getState().pendingPermission, null);
  store.setPendingPermissions([ask('a'), ask('a'), { sessionID: 'x' }, ask('b')]);
  assert.deepEqual(ids(store), ['a', 'b']);
  store.clearMessages();
  assert.deepEqual(ids(store), []);
});

test('a sub-agent request reaches the parent panel when no child panel is open', () => {
  const parent = boundStore('ses_parent');
  const storesBySession = new Map([['ses_parent', new Set([parent])]]);
  const parentOf = new Map([['ses_child', 'ses_parent'], ['ses_grand', 'ses_child']]);
  const route = (eventType, sessionID) => resolveEventTargets({ eventType, ev: { sessionID }, storesBySession, parentOf, allStores: new Set([parent]) });

  assert.deepEqual(route('permission.asked', 'ses_child'), [parent]);
  assert.deepEqual(route('question.asked', 'ses_grand'), [parent], 'walks up to the nearest open ancestor');
  assert.deepEqual(route('permission.replied', 'ses_child'), [parent]);
  // Transcript events of a session nobody has open are still dropped.
  assert.deepEqual(route('message.part.updated', 'ses_child'), []);
  assert.deepEqual(route('permission.asked', 'ses_stranger'), []);
  // A cycle in the parent map cannot hang the lookup.
  const loop = new Map([['a', 'b'], ['b', 'a']]);
  assert.deepEqual(resolveEventTargets({ eventType: 'permission.asked', ev: { sessionID: 'a' }, storesBySession, parentOf: loop }), []);
});

test('with the child panel open, asks go to the child and answers clear both panels', () => {
  const parent = boundStore('ses_parent');
  const child = boundStore('ses_child');
  const parentOf = new Map([['ses_child', 'ses_parent']]);
  const closed = new Map([['ses_parent', new Set([parent])]]);
  const open = new Map([['ses_parent', new Set([parent])], ['ses_child', new Set([child])]]);
  const deliver = (stores, eventType, ev) => {
    for (const store of resolveEventTargets({ eventType, ev, storesBySession: stores, parentOf })) applyEvent(store, eventType, ev);
  };

  // Raised before the child panel existed: the parent holds it.
  deliver(closed, 'permission.asked', ask('per_1', { sessionID: 'ses_child' }));
  assert.deepEqual(ids(parent), ['per_1']);
  // The child panel opens; a new ask goes to the child only.
  deliver(open, 'permission.asked', ask('per_2', { sessionID: 'ses_child' }));
  assert.deepEqual(ids(parent), ['per_1']);
  assert.deepEqual(ids(child), ['per_2']);
  // Answers are removed wherever the request is showing.
  deliver(open, 'permission.replied', { sessionID: 'ses_child', requestID: 'per_1', reply: 'once' });
  deliver(open, 'permission.replied', { sessionID: 'ses_child', requestID: 'per_2', reply: 'once' });
  assert.deepEqual(ids(parent), []);
  assert.deepEqual(ids(child), []);
});

test('rehydrate restores every pending request and question after a reload', async () => {
  const store = boundStore('ses_1');
  store.addPendingPermission(ask('per_stale'));
  const api = {
    sessionStatus: async () => ({ status: 200, data: { status: { type: 'busy' } } }),
    permissionList: async () => ({ status: 200, data: [
      ask('per_1'),
      ask('per_child', { sessionID: 'ses_child_no_panel' }),
      ask('per_other', { sessionID: 'ses_child_with_panel' }),
    ] }),
    questionList: async () => ({ status: 200, data: [
      { id: 'que_1', sessionID: 'ses_1', questions: [{ question: 'A?' }] },
      { id: 'que_2', sessionID: 'ses_child_with_panel', questions: [] },
    ] }),
  };
  // A sub-agent's request comes back only with its ancestry confirmed (review F03).
  await rehydrateSessionState(store, api, {
    sessionId: 'ses_1',
    hasPanel: (sid) => sid === 'ses_child_with_panel',
    isDescendant: async (owner, ancestor) => ancestor === 'ses_1' && owner.startsWith('ses_child'),
  });
  assert.deepEqual(ids(store), ['per_1', 'per_child'], 'the stale request is gone, the live ones are back');
  assert.deepEqual(store.getState().pendingQuestions.map((q) => q.id), ['que_1']);
  assert.equal(store.getState().running, true);

  // A question list that came back as a document (unknown route) is not applied.
  api.questionList = async () => ({ status: 200, data: '<!doctype html>' });
  await rehydrateSessionState(store, api, { sessionId: 'ses_1' });
  assert.deepEqual(store.getState().pendingQuestions.map((q) => q.id), ['que_1']);
});

test('permissionCardView names the origin and what Always allow remembers', () => {
  assert.deepEqual(permissionCardView(ask('per_1'), { sessionId: 'ses_1' }), {
    id: 'per_1', kind: 'bash', fromSubagent: false, always: ['git *'], auto: false,
  });
  const fromChild = permissionCardView(ask('per_2', { sessionID: 'ses_child', always: ['', 5, 'rm *'], _auto: true }), { sessionId: 'ses_1' });
  assert.deepEqual([fromChild.fromSubagent, fromChild.always, fromChild.auto], [true, ['rm *'], true]);
  assert.deepEqual(permissionCardView({ id: 'x' }, {}).always, []);
  assert.equal(permissionKind({ permission: { permission: 'Edit' } }), 'edit');
  assert.equal(permissionKind({ type: 'webfetch' }), 'webfetch');
});

test('auto-accept is off by default, per session, and never survives a session change', () => {
  const store = boundStore('ses_1');
  assert.equal(store.getState().autoAccept, false);
  store.setAutoAccept(true);
  assert.equal(store.getState().autoAccept, true);
  store.setSession('ses_1', { id: 'ses_1', title: 'same session, new info' });
  assert.equal(store.getState().autoAccept, true);
  store.setSession('ses_2', { id: 'ses_2' });
  assert.equal(store.getState().autoAccept, false);
  assert.equal(createPanelStore().getState().autoAccept, false);
});

test('shouldAutoAccept needs the switch, an id, and never covers doom_loop', () => {
  assert.equal(shouldAutoAccept(false, ask('per_1')), false);
  assert.equal(shouldAutoAccept(true, ask('per_1')), true);
  assert.equal(shouldAutoAccept(true, ask('per_1', { permission: 'edit' })), true);
  assert.equal(shouldAutoAccept(true, { permission: 'bash' }), false);
  for (const kind of NEVER_AUTO_ACCEPT) assert.equal(shouldAutoAccept(true, ask('per_1', { permission: kind })), false, kind);
  assert.deepEqual([...NEVER_AUTO_ACCEPT], ['doom_loop']);
});

test('autoAcceptRequest replies once on the request own session and clears it', async () => {
  const store = boundStore('ses_1');
  const req = ask('per_1', { sessionID: 'ses_child' });
  store.addPendingPermission(req);
  const replies = [];
  let seenWhileInFlight = null;
  const api = {
    permissionReply: async (params) => {
      replies.push(params);
      seenWhileInFlight = store.getState().pendingPermissions[0]._auto;
      return { status: 200, data: true };
    },
  };
  // A sub-agent's request is answered once its ancestry is confirmed (review F03).
  const isDescendant = async (owner, ancestor) => owner === 'ses_child' && ancestor === 'ses_1';
  assert.equal(await autoAcceptRequest(store, api, req, { cwd: '/p', isDescendant }), true);
  assert.deepEqual(replies, [{ sessionId: 'ses_child', permissionId: 'per_1', response: 'once', cwd: '/p' }]);
  assert.equal(seenWhileInFlight, true, 'the card is a stub while the reply is in flight');
  assert.deepEqual(ids(store), []);
});

test('a refused auto-accept hands the request back to the user', async () => {
  const store = boundStore('ses_1');
  const req = ask('per_1');
  store.addPendingPermission(req);
  for (const api of [
    { permissionReply: async () => ({ ok: false, status: 404, error: 'Permission request not found' }) },
    { permissionReply: async () => { throw new Error('websocket closed'); } },
  ]) {
    assert.equal(await autoAcceptRequest(store, api, req), false);
    assert.deepEqual(ids(store), ['per_1']);
    assert.equal(store.getState().pendingPermissions[0]._auto, undefined);
  }
  assert.equal(await autoAcceptRequest(store, { permissionReply: async () => ({ status: 200 }) }, { permission: 'bash' }), false);
});

test('turning auto-accept on answers what is waiting, except doom_loop; turning it off answers nothing', async () => {
  const store = boundStore('ses_1');
  store.addPendingPermission(ask('per_1'));
  store.addPendingPermission(ask('per_loop', { permission: 'doom_loop' }));
  store.addPendingPermission(ask('per_2', { permission: 'edit' }));
  const replies = [];
  const api = { permissionReply: async (p) => { replies.push(p.permissionId); return { status: 200, data: true }; } };

  assert.equal(await setAutoAccept(store, api, true, { cwd: '/p' }), 2);
  assert.deepEqual(replies.sort(), ['per_1', 'per_2']);
  assert.deepEqual(ids(store), ['per_loop']);
  assert.equal(store.getState().autoAccept, true);

  assert.equal(await setAutoAccept(store, api, false), 0);
  assert.equal(store.getState().autoAccept, false);
  assert.equal(replies.length, 2);
});

test('the card says how long Always allow lasts and offers no saved-approvals list', () => {
  // Checked on a live 1.18.34 serve (run 2): after a real "always" reply the
  // same command is not asked again in any session of the project on that
  // serve, it is asked again after the serve restarts, and
  // GET /api/permission/saved stays []. A "Saved approvals" list fed by that
  // route could only ever say "No saved approvals".
  assert.match(ALWAYS_ALLOW_SCOPE, /until this session.s OpenCode runtime restarts/);
  const render = readFileSync(new URL('../public/shared/ocp-v2/ocp-v2-render.js', import.meta.url), 'utf8');
  assert.match(render, /always\.appendChild\(document\.createTextNode\(` \$\{ALWAYS_ALLOW_SCOPE\}\.`\)\);/);
  assert.equal(render.includes('Saved approvals'), false);
  assert.equal(render.includes('permissionSavedList'), false);
  const ws = readFileSync(new URL('../public/shared/ocp-v2/ocp-v2-ws.js', import.meta.url), 'utf8');
  assert.equal(ws.includes('permission:saved'), false, 'the panel sends no saved-permission request');
});

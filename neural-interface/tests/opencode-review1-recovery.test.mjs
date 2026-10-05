// Code review 1 of the OpenCode panel rebuild: recovery and stream ordering.
// F03 recovered requests need verified ancestry; an automatic reply re-checks it.
// F04 a recovery snapshot never overwrites a newer live event.
// F05 a sub-agent panel is re-read after a reconnect.
// F13 a stale or shorter part update cannot erase streamed text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPanelStore } from '../public/shared/ocp-v2/ocp-v2-state.js';
import { applyEvent } from '../public/shared/ocp-v2/ocp-v2-events.js';
import { autoAcceptRequest, setAutoAccept } from '../public/shared/ocp-v2/ocp-v2-approvals.js';
import {
  rehydrateSessionState, rehydratePanelSession, requestsForPanel, requestBelongsTo, verifyDescendant,
  createReconnectNotifier, transcriptInFlight, ANCESTRY_MAX_DEPTH,
} from '../public/shared/ocp-v2/ocp-v2-rehydrate.js';

function boundStore(sessionId = 'ses_1') {
  const store = createPanelStore();
  store.setSession(sessionId, { id: sessionId });
  return store;
}
const ask = (id, sessionID = 'ses_1', extra = {}) => ({ id, sessionID, permission: 'bash', patterns: ['ls'], ...extra });
const ids = (store) => store.getState().pendingPermissions.map((p) => p.id);
const source = (name) => readFileSync(new URL(`../public/shared/ocp-v2/${name}`, import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// ── F03 ─────────────────────────────────────────────────────────────────────

test('F03: verifyDescendant walks child → parent, fetches what it does not know, and fails closed', async () => {
  const parentOf = new Map([['ses_child', 'ses_1'], ['ses_grand', 'ses_child']]);
  assert.equal(await verifyDescendant('ses_child', 'ses_1', { parentOf }), true);
  assert.equal(await verifyDescendant('ses_grand', 'ses_1', { parentOf }), true);
  assert.equal(await verifyDescendant('ses_1', 'ses_1', { parentOf }), false, 'a session is not its own descendant');
  assert.equal(await verifyDescendant('ses_1', 'ses_child', { parentOf }), false, 'ancestry has a direction');
  assert.equal(await verifyDescendant('ses_other', 'ses_1', { parentOf }), false, 'unknown without a way to ask');

  // Unknown links are read from the session and remembered.
  const asked = [];
  const roots = new Set();
  const fetchParent = async (id) => { asked.push(id); return { ses_new: 'ses_child', ses_root2: '' }[id] ?? null; };
  assert.equal(await verifyDescendant('ses_new', 'ses_1', { parentOf, roots, fetchParent }), true);
  assert.equal(parentOf.get('ses_new'), 'ses_child');
  assert.equal(await verifyDescendant('ses_root2', 'ses_1', { parentOf, roots, fetchParent }), false, 'another root session');
  assert.equal(roots.has('ses_root2'), true);
  assert.equal(await verifyDescendant('ses_root2', 'ses_1', { parentOf, roots, fetchParent }), false);
  assert.deepEqual(asked, ['ses_new', 'ses_root2'], 'a known root is not asked about twice');
  // A lookup that fails or answers nonsense is "no".
  assert.equal(await verifyDescendant('ses_x', 'ses_1', { parentOf: new Map(), fetchParent: async () => { throw new Error('offline'); } }), false);
  assert.equal(await verifyDescendant('ses_x', 'ses_1', { parentOf: new Map(), fetchParent: async () => undefined }), false);
  // A cycle or an endless chain cannot hang it.
  assert.equal(await verifyDescendant('a', 'ses_1', { parentOf: new Map([['a', 'b'], ['b', 'a']]) }), false);
  let n = 0;
  assert.equal(await verifyDescendant('c0', 'ses_1', { parentOf: new Map(), fetchParent: async () => `c${++n}` }), false);
  assert.ok(n <= ANCESTRY_MAX_DEPTH);
});

test('F03: recovery leaves out another root session on the same serve, panel or no panel', async () => {
  const list = [ask('per_mine'), ask('per_child', 'ses_child'), ask('per_cli', 'ses_cli_root'), { id: 'per_nowhere' }];
  const isDescendant = (owner, ancestor) => verifyDescendant(owner, ancestor, {
    parentOf: new Map([['ses_child', 'ses_1']]), fetchParent: async () => '',
  });
  // The flaw: "no other panel has it" used to be enough.
  const got = await requestsForPanel(list, 'ses_1', { hasPanel: () => false, isDescendant });
  assert.deepEqual(got.map((r) => r.id), ['per_mine', 'per_child']);
  assert.equal(await requestBelongsTo(ask('p', 'ses_cli_root'), 'ses_1', isDescendant), false);
  assert.equal(await requestBelongsTo({ id: 'p' }, 'ses_1', isDescendant), false, 'a request that names no session belongs to nobody');
  assert.equal(await requestBelongsTo(ask('p', 'ses_child'), 'ses_1', async () => { throw new Error('x'); }), false);

  const store = boundStore('ses_1');
  await rehydrateSessionState(store, {
    sessionStatus: async () => ({ status: 200, data: { status: { type: 'idle' } } }),
    permissionList: async () => ({ status: 200, data: list }),
    questionList: async () => ({ status: 200, data: [{ id: 'que_cli', sessionID: 'ses_cli_root' }, { id: 'que_1', sessionID: 'ses_1' }] }),
  }, { sessionId: 'ses_1', isDescendant });
  assert.deepEqual(ids(store), ['per_mine', 'per_child']);
  assert.deepEqual(store.getState().pendingQuestions.map((q) => q.id), ['que_1']);
});

test('F03: auto-accept never answers a request outside the session tree, however it got into the queue', async () => {
  const store = boundStore('ses_1');
  const replies = [];
  const api = { permissionReply: async (p) => { replies.push([p.sessionId, p.permissionId]); return { status: 200, data: true }; } };
  const isDescendant = async (owner, ancestor) => owner === 'ses_child' && ancestor === 'ses_1';

  // Put there by an older recovery, a bug, anything: the reply path checks again.
  store.addPendingPermission(ask('per_mine'));
  store.addPendingPermission(ask('per_child', 'ses_child'));
  store.addPendingPermission(ask('per_cli', 'ses_cli_root'));
  store.addPendingPermission({ id: 'per_nowhere', permission: 'bash' });

  assert.equal(await setAutoAccept(store, api, true, { isDescendant }), 2);
  assert.deepEqual(replies.sort(), [['ses_1', 'per_mine'], ['ses_child', 'per_child']]);
  assert.deepEqual(ids(store), ['per_cli', 'per_nowhere'], 'the foreign requests were not answered');
  assert.equal(store.getState().pendingPermissions.some((p) => p._auto), false, 'and are not shown as being answered');

  // Without a verifier only the session's own request is answered.
  const alone = boundStore('ses_1');
  alone.addPendingPermission(ask('per_child', 'ses_child'));
  assert.equal(await autoAcceptRequest(alone, api, ask('per_child', 'ses_child')), false);
  assert.equal(replies.length, 2);

  // The panel moved to another session while ancestry was being looked up.
  const moving = boundStore('ses_1');
  const slow = async () => { moving.setSession('ses_2', { id: 'ses_2' }); return true; };
  assert.equal(await autoAcceptRequest(moving, api, ask('per_late', 'ses_child'), { isDescendant: slow }), false);
  assert.equal(replies.length, 2);
});

test('F03: the panel passes the verifier everywhere it recovers or auto-answers', () => {
  assert.match(source('ocp-v2-ws.js'), /autoAcceptRequest\(store, api, ev, \{[^}]*isDescendant: isDescendantSession/);
  assert.match(source('ocp-v2-autoaccept-button.js'), /isDescendant: isDescendantSession/);
  assert.match(source('ocp-v2-panel.js'), /hasPanel: hasSessionStore,\s+isDescendant: isDescendantSession,/);
  assert.match(source('ocp-v2-manager.js'), /isDescendant: isDescendantSession,/);
});

// ── F04 ─────────────────────────────────────────────────────────────────────

test('F04: every live change to a recovered slice moves its revision', () => {
  const store = boundStore();
  const rev = () => store.getRevisions();
  let before = rev();
  store.addPendingPermission(ask('per_1'));
  assert.ok(rev().permissions > before.permissions);
  before = rev();
  store.removePendingPermission('per_not_on_screen');
  assert.ok(rev().permissions > before.permissions, 'an answer counts even when the request is not on screen');
  before = rev();
  store.setSessionStatus({ type: 'busy' });
  store.setRunning(true);
  assert.ok(rev().status >= before.status + 2);
  before = rev();
  store.addPendingQuestion({ id: 'que_1' });
  store.removePendingQuestion('que_1');
  store.setTodos([{ content: 'x' }]);
  assert.ok(rev().questions >= before.questions + 2 && rev().todos > before.todos);
  assert.equal(rev().permissions, before.permissions, 'slices are independent');
  // The snapshot is a copy.
  rev().status = -1;
  assert.notEqual(store.getRevisions().status, -1);
});

test('F04: a permission asked while the list was being read survives the snapshot', async () => {
  const store = boundStore();
  const gate = deferred();
  let reads = 0;
  const api = {
    sessionStatus: async () => ({ status: 200, data: { status: { type: 'idle' } } }),
    // The first read captured an empty list; the request is raised right after.
    permissionList: async () => {
      reads += 1;
      if (reads === 1) { await gate.promise; return { status: 200, data: [] }; }
      return { status: 200, data: [ask('per_live')] };
    },
    questionList: async () => ({ status: 200, data: [] }),
  };
  const running = rehydrateSessionState(store, api, { sessionId: 'ses_1' });
  applyEvent(store, 'permission.asked', ask('per_live'));
  gate.resolve();
  const applied = await running;
  assert.deepEqual(ids(store), ['per_live'], 'the stale empty list did not remove the live card');
  assert.equal(reads, 2, 'the overtaken snapshot was thrown away and read again');
  assert.equal(applied.permissions, true);
});

test('F04: an answered request is not resurrected by a list that still had it', async () => {
  const store = boundStore();
  const gate = deferred();
  let reads = 0;
  const api = {
    sessionStatus: async () => ({ ok: false, unsupported: true }),
    permissionList: async () => {
      reads += 1;
      if (reads === 1) { await gate.promise; return { status: 200, data: [ask('per_answered')] }; }
      return { status: 200, data: [] };
    },
    questionList: async () => ({ ok: false, unsupported: true }),
  };
  const running = rehydrateSessionState(store, api, { sessionId: 'ses_1' });
  // Answered (in another window) before this panel ever showed it.
  applyEvent(store, 'permission.replied', { sessionID: 'ses_1', requestID: 'per_answered', reply: 'once' });
  gate.resolve();
  await running;
  assert.deepEqual(ids(store), []);
});

test('F04: an older idle status cannot replace a newer busy event, so the queue does not drain early', async () => {
  const store = boundStore();
  const gate = deferred();
  let reads = 0;
  const api = {
    sessionStatus: async () => {
      reads += 1;
      if (reads === 1) { await gate.promise; return { status: 200, data: { status: { type: 'idle' } } }; }
      return { status: 200, data: { status: { type: 'busy' } } };
    },
    permissionList: async () => ({ status: 200, data: [] }),
    questionList: async () => ({ status: 200, data: [] }),
  };
  const running = rehydrateSessionState(store, api, { sessionId: 'ses_1' });
  applyEvent(store, 'session.status', { sessionID: 'ses_1', status: { type: 'busy' } });
  gate.resolve();
  await running;
  assert.equal(store.getState().running, true);
  assert.equal(store.getState().sessionStatus.type, 'busy');
});

test('F04: when live events keep winning, the store keeps them and the reads stop', async () => {
  const store = boundStore();
  let reads = 0;
  const api = {
    sessionStatus: async () => ({ ok: false, unsupported: true }),
    permissionList: async () => { reads += 1; store.addPendingPermission(ask(`per_${reads}`)); return { status: 200, data: [] }; },
    questionList: async () => ({ ok: false, unsupported: true }),
  };
  const applied = await rehydrateSessionState(store, api, { sessionId: 'ses_1' });
  assert.equal(reads, 3);
  assert.equal(applied.permissions, false);
  assert.deepEqual(ids(store), ['per_1', 'per_2', 'per_3']);
});

test('F04: slices are judged separately, and an untouched one is applied on the first read', async () => {
  const store = boundStore();
  const gate = deferred();
  const calls = [];
  const api = {
    sessionStatus: async () => { calls.push('status'); await gate.promise; return { status: 200, data: { status: { type: 'busy' } } }; },
    permissionList: async () => { calls.push('permissions'); await gate.promise; return { status: 200, data: [ask('per_1')] }; },
    questionList: async () => { calls.push('questions'); await gate.promise; return { status: 200, data: [] }; },
    sessionTodo: async () => { calls.push('todos'); await gate.promise; return { status: 200, data: [{ content: 'old' }] }; },
  };
  const running = rehydrateSessionState(store, api, { sessionId: 'ses_1' });
  applyEvent(store, 'todo.updated', { sessionID: 'ses_1', todos: [{ content: 'new' }] });
  gate.resolve();
  await running;
  assert.deepEqual(ids(store), ['per_1']);
  assert.equal(store.getState().running, true);
  assert.equal(calls.filter((c) => c === 'permissions').length, 1);
  assert.equal(calls.filter((c) => c === 'todos').length, 2, 'only the overtaken slice was re-read');
});

// ── F05 ─────────────────────────────────────────────────────────────────────

test('F05: a sub-agent panel that missed the end of its turn and a new request is put right', async () => {
  const child = boundStore('ses_child');
  child.setParentSession('ses_1', 'ocp-v2-panel');
  child.upsertMessage({ id: 'msg_1', role: 'assistant', time: { created: 1 } });
  child.setRunning(true);                       // what it knew when the socket dropped
  const api = {
    sessionGet: async () => ({ status: 200, data: { id: 'ses_child', parentID: 'ses_1', title: 'explore', directory: '/p' } }),
    sessionMessages: async () => ({ status: 200, data: [
      { info: { id: 'msg_1', role: 'assistant', time: { created: 1, completed: 5 } }, parts: [{ id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'done', time: { start: 1, end: 5 } }] },
    ] }),
    sessionStatus: async () => ({ status: 200, data: { status: { type: 'idle' } } }),
    permissionList: async (p) => { assert.equal(p.cwd, '/p'); return { status: 200, data: [ask('per_child', 'ses_child'), ask('per_parent', 'ses_1')] }; },
    questionList: async () => ({ status: 200, data: [] }),
  };
  const out = await rehydratePanelSession(child, api, { sessionId: 'ses_child', hasPanel: (sid) => sid === 'ses_1' || sid === 'ses_child' });
  assert.equal(out.transcript, true);
  assert.equal(child.getState().running, false, 'no longer "running" forever');
  assert.deepEqual(ids(child), ['per_child'], 'its own card is back; the parent keeps the parent request');
  assert.equal(child.getState().messages.get('msg_1').parts.get('prt_1').text, 'done');
  assert.equal(child.getState().sessionInfo.title, 'explore');
});

test('F05: on a server without session:status the transcript decides, both ways', async () => {
  const unsupported = async () => ({ ok: false, unsupported: true, status: 501 });
  const base = { sessionGet: async () => ({ status: 200, data: { id: 'ses_child' } }), sessionStatus: unsupported, permissionList: unsupported, questionList: unsupported };
  const finished = boundStore('ses_child');
  finished.setRunning(true);
  await rehydratePanelSession(finished, { ...base, sessionMessages: async () => ({ status: 200, data: [{ info: { id: 'm', role: 'assistant', time: { completed: 3 } }, parts: [] }] }) }, { sessionId: 'ses_child' });
  assert.equal(finished.getState().running, false);
  const working = boundStore('ses_child');
  await rehydratePanelSession(working, { ...base, sessionMessages: async () => ({ status: 200, data: [{ info: { id: 'm', role: 'assistant', time: {} }, parts: [] }] }) }, { sessionId: 'ses_child' });
  assert.equal(working.getState().running, true);
  assert.equal(transcriptInFlight([{ info: { role: 'user' }, parts: [{ type: 'tool', state: { status: 'running' } }] }]), true);
  assert.equal(transcriptInFlight([]), false);
});

test('F05: answers that arrive after the panel was closed or rebound are dropped', async () => {
  const child = boundStore('ses_child');
  let alive = true;
  const api = {
    sessionGet: async () => ({ status: 200, data: { id: 'ses_child', title: 'late' } }),
    sessionMessages: async () => { alive = false; return { status: 200, data: [{ info: { id: 'm', role: 'assistant', time: {} }, parts: [] }] }; },
    sessionStatus: async () => ({ status: 200, data: { status: { type: 'busy' } } }),
    permissionList: async () => ({ status: 200, data: [ask('per_child', 'ses_child')] }),
    questionList: async () => ({ status: 200, data: [] }),
  };
  const out = await rehydratePanelSession(child, api, { sessionId: 'ses_child', isCurrent: () => alive });
  assert.equal(out.transcript, false);
  assert.equal(child.getState().messageOrder.length, 0);
  assert.deepEqual(ids(child), []);
  assert.equal(child.getState().running, false);

  const rebound = boundStore('ses_child');
  await rehydratePanelSession(rebound, { ...api, sessionGet: async () => { rebound.setSession('ses_other', null); return { status: 200, data: { id: 'ses_child' } }; } }, { sessionId: 'ses_child' });
  assert.equal(rebound.getState().sessionId, 'ses_other');
  assert.equal(rebound.getState().messageOrder.length, 0);
});

test('F05: the reconnect notifier fires once per reconnect, after capabilities or the grace period', () => {
  let fired = 0;
  const timers = [];
  const notifier = createReconnectNotifier(() => { fired += 1; }, {
    graceMs: 1500,
    setTimer: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; },
    clearTimer: (id) => { if (timers[id]) timers[id].live = false; },
  });
  const runTimers = () => timers.filter((t) => t.live).forEach((t) => { t.live = false; t.fn(); });

  notifier.opened();                 // first connection: not a reconnect
  notifier.capabilities();
  runTimers();
  assert.equal(fired, 0);

  notifier.closed();
  notifier.opened();                 // reconnect to a server that lists capabilities
  assert.equal(fired, 0, 'waits for the capability list so gated reads are sent');
  notifier.capabilities();
  assert.equal(fired, 1);
  runTimers();
  assert.equal(fired, 1, 'the grace timer does not fire a second time');

  notifier.closed();
  notifier.opened();                 // reconnect to a server that predates the list
  assert.equal(timers.at(-1).ms, 1500);
  runTimers();
  assert.equal(fired, 2);

  notifier.opened();                 // dropped again before anything arrived
  notifier.closed();
  runTimers();
  notifier.capabilities();
  assert.equal(fired, 2);
});

test('F05: the manager re-reads every sub-agent panel on reconnect and guards late results', () => {
  const manager = source('ocp-v2-manager.js');
  // One panel per sub-agent since 2026-10-04 (was: the one active child).
  assert.match(manager, /onReconnect\(\(\) => \{\s+for \(const entry of _panels\.all\(\)\) \{\s+(\/\/[^\n]*\s+)?_hydrations\(\(\) => hydrateChildPanel\(entry\.store, entry\.sessionId\)\)/);
  assert.match(manager, /isCurrent: \(\) => _panels\.get\(sessionId\)\?\.store === store,/);
  const ws = source('ocp-v2-ws.js');
  assert.match(ws, /_reconnects\.opened\(\);/);
  assert.match(ws, /_reconnects\.closed\(\);/);
  assert.match(ws, /capabilities\.set\(msg\.capabilities\);\s+_reconnects\.capabilities\(\);/);
});

// ── F13 ─────────────────────────────────────────────────────────────────────

const textOf = (store, messageID, partID) => store.getState().messages.get(messageID)?.parts.get(partID)?.text;

test('F13: a part announced after its deltas does not erase them', () => {
  const store = boundStore();
  // The deltas outran message.part.updated: the store built a stub.
  applyEvent(store, 'message.part.delta', { sessionID: 'ses_1', messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: 'Hello ' });
  applyEvent(store, 'message.part.delta', { sessionID: 'ses_1', messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: 'world' });
  assert.equal(textOf(store, 'msg_1', 'prt_1'), 'Hello world');
  // Then the announcement arrives, made when the part was still empty.
  applyEvent(store, 'message.part.updated', { sessionID: 'ses_1', part: { id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_1', type: 'text', text: '', time: { start: 10 } } });
  assert.equal(textOf(store, 'msg_1', 'prt_1'), 'Hello world', 'the stale empty text did not replace the stream');
  assert.deepEqual(store.getState().messages.get('msg_1').parts.get('prt_1').time, { start: 10 }, 'the rest of the update is taken');
  // More deltas keep appending to the same text.
  applyEvent(store, 'message.part.delta', { sessionID: 'ses_1', messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: '!' });
  assert.equal(textOf(store, 'msg_1', 'prt_1'), 'Hello world!');
});

test('F13: a shorter (older) update, or one without the field, keeps the longer text while unfinished', () => {
  const store = boundStore();
  store.upsertPart({ id: 'prt_1', messageID: 'msg_1', type: 'reasoning', text: 'Thinking about' });
  store.appendPartDelta({ messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: ' the plan' });
  store.upsertPart({ id: 'prt_1', messageID: 'msg_1', type: 'reasoning', text: 'Thinking' });
  assert.equal(textOf(store, 'msg_1', 'prt_1'), 'Thinking about the plan');
  store.upsertPart({ id: 'prt_1', messageID: 'msg_1', type: 'reasoning', metadata: { x: 1 } });
  assert.equal(textOf(store, 'msg_1', 'prt_1'), 'Thinking about the plan');
  assert.deepEqual(store.getState().messages.get('msg_1').parts.get('prt_1').metadata, { x: 1 });
});

test('F13: an update that is ahead, differs, or finishes the part still wins', () => {
  const store = boundStore();
  store.appendPartDelta({ messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: 'Hello' });
  // Ahead of the stream (a delta was lost): take the longer text.
  store.upsertPart({ id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'Hello world' });
  assert.equal(textOf(store, 'msg_1', 'prt_1'), 'Hello world');
  // Not a prefix of what is shown: OpenCode rewrote it, the update is the truth.
  store.upsertPart({ id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'Hi' });
  assert.equal(textOf(store, 'msg_1', 'prt_1'), 'Hi');
  // Finished: the final text is authoritative even when it is shorter.
  store.appendPartDelta({ messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: ' there, friend' });
  store.upsertPart({ id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'Hi there', time: { start: 1, end: 2 } });
  assert.equal(textOf(store, 'msg_1', 'prt_1'), 'Hi there');
  // Parts that never streamed are replaced as before.
  store.upsertPart({ id: 'prt_tool', messageID: 'msg_1', type: 'tool', state: { status: 'running' } });
  store.upsertPart({ id: 'prt_tool', messageID: 'msg_1', type: 'tool', state: { status: 'completed', output: 'ok' } });
  assert.equal(store.getState().messages.get('msg_1').parts.get('prt_tool').state.status, 'completed');
  assert.equal('text' in store.getState().messages.get('msg_1').parts.get('prt_tool'), false);
});

test('F13: a transcript snapshot read mid-stream cannot roll the text back either', () => {
  const store = boundStore();
  store.appendPartDelta({ messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: 'one two three' });
  store.hydrateMessages([{ info: { id: 'msg_1', role: 'assistant' }, parts: [{ id: 'prt_1', messageID: 'msg_1', type: 'text', text: 'one' }] }]);
  assert.equal(textOf(store, 'msg_1', 'prt_1'), 'one two three');
  store.hydrateMessages([{ info: { id: 'msg_1', role: 'assistant' }, parts: [{ id: 'prt_1', messageID: 'msg_1', type: 'text', text: '' }] }]);
  assert.equal(textOf(store, 'msg_1', 'prt_1'), 'one two three');
});

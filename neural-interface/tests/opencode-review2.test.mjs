// Code review 2 of the OpenCode panel rebuild (fix verification).
// R01 a request of another session is never on screen or answerable after the panel moved.
// R02 the primary panel's transcript reads are guarded like a recovery.
// R03 a cached Session is not trusted for the model and agent.
// R04 Undo puts a symbol (with its range) and an MCP resource back as what they were.
// R05 an unattributable worktree failure never ends a creation.
// N01 an MCP server added from the panel starts once, after a confirm.
// N02 an agent is validated against the list of the directory it is used in.
// N03 MCP arguments reach OpenCode exactly as typed.
// N04 a command turn keeps the source of its file parts.
// The part shapes in R04 and N04 are what a live OpenCode 1.18.34 serve stored
// and read (throwaway serve, local fake model).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPanelStore } from '../public/shared/ocp-v2/ocp-v2-state.js';
import { applyEvent } from '../public/shared/ocp-v2/ocp-v2-events.js';
import {
  replyToPermission, ownsRequest, FOREIGN_REQUEST_MESSAGE,
} from '../public/shared/ocp-v2/ocp-v2-approvals.js';
import {
  hydrateTranscript, rehydratePanelSession, requestsVisibleIn, knownDescendant, verifyDescendant,
} from '../public/shared/ocp-v2/ocp-v2-rehydrate.js';
import { replayablePrompt, resourceReadsOf } from '../public/shared/ocp-v2/ocp-v2-sessions-logic.js';
import {
  loadSessionDetail, applySessionSelections, revertToMessage, restoreDraftAttachments, retryFromMessage,
  loadSelectedSession,
} from '../public/shared/ocp-v2/ocp-v2-session-actions.js';
import {
  draftRestorePlan, mentionItemOfPart, mentionFileParts, resourceReplayParts, commandFileParts, commandMentionPart,
  createAgentChoice, DEFAULT_AGENTS,
} from '../public/shared/ocp-v2/ocp-v2-composer-logic.js';
import { watchWorktree, worktreeTimeoutOutcome } from '../public/shared/ocp-v2/ocp-v2-changes-logic.js';
import { endTurn } from '../public/shared/ocp-v2/ocp-v2-send-logic.js';
import {
  addMcpServer, mcpStartConfirmText, parseMcpServerInput,
} from '../public/shared/ocp-v2/ocp-v2-status-logic.js';
import {
  handleOpencodeV2Request, runtimeMcpConfigFor, buildOpencodeRuntimeMcpConfig, opencodeV2WsCapabilities,
  OPENCODE_V2_WS_FEATURES,
} from '../lib/opencode-v2-ws-requests.js';
import { toOpenCodeMcpEntry } from '../lib/mcp-client-config.js';

const source = (name) => readFileSync(new URL(`../public/shared/ocp-v2/${name}`, import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const ask = (id, sessionID, extra = {}) => ({ id, sessionID, permission: 'bash', patterns: ['rm -rf build'], ...extra });
const question = (id, sessionID) => ({ id, sessionID, questions: [{ question: 'Which?', options: [{ label: 'A' }] }] });
function boundStore(sessionId = 'ses_old') {
  const store = createPanelStore();
  store.setSession(sessionId, { id: sessionId });
  return store;
}
const permissionIds = (store) => store.getState().pendingPermissions.map((p) => p.id);
const questionIds = (store) => store.getState().pendingQuestions.map((q) => q.id);

// ── R01 ─────────────────────────────────────────────────────────────────────

test('R01: a request that arrives while the next session is being created does not survive into it', () => {
  // startFreshSession: the transcript is cleared, then session:create is awaited
  // with the store still subscribed to the session being left.
  const store = boundStore('ses_old');
  store.clearMessages();
  applyEvent(store, 'permission.asked', ask('per_old', 'ses_old'));
  applyEvent(store, 'question.asked', question('que_old', 'ses_old'));
  assert.deepEqual(permissionIds(store), ['per_old']);
  assert.deepEqual(questionIds(store), ['que_old']);

  const before = store.getRevisions();
  const events = [];
  store.subscribe((event) => events.push(event.type));
  store.setSession('ses_new', { id: 'ses_new' });   // the create reply
  assert.deepEqual(permissionIds(store), [], 'the old session\'s approval is gone');
  assert.equal(store.getState().pendingPermission, null);
  assert.deepEqual(questionIds(store), []);
  const after = store.getRevisions();
  assert.ok(after.permissions > before.permissions && after.questions > before.questions, 'a list read before the move is now stale');
  assert.equal(after.binding, before.binding + 1);
  assert.ok(events.includes('permission:set') && events.includes('questions:set'), 'the cards are redrawn');

  // Fresh metadata for the same session (a title, a rename) is not a move.
  applyEvent(store, 'permission.asked', ask('per_new', 'ses_new'));
  store.setSession('ses_new', { id: 'ses_new', title: 'Renamed' });
  assert.deepEqual(permissionIds(store), ['per_new']);
  assert.equal(store.getRevisions().binding, after.binding);

  // Closing the tab (no session) empties them as well.
  store.setSession(null, null);
  assert.deepEqual(permissionIds(store), []);
});

test('R01: only requests of the bound session tree are drawn', () => {
  const parentOf = new Map([['ses_child', 'ses_new'], ['ses_grand', 'ses_child']]);
  const known = (owner, ancestor) => knownDescendant(owner, ancestor, parentOf);
  const list = [
    ask('per_own', 'ses_new'), ask('per_child', 'ses_child'), ask('per_grand', 'ses_grand'),
    ask('per_old', 'ses_old'), ask('per_cli', 'ses_cli_root'), { id: 'per_nowhere' },
  ];
  assert.deepEqual(requestsVisibleIn(list, 'ses_new', known).map((p) => p.id), ['per_own', 'per_child', 'per_grand']);
  assert.deepEqual(requestsVisibleIn(list, 'ses_new').map((p) => p.id), ['per_own'], 'without a way to know, only its own');
  assert.deepEqual(requestsVisibleIn(list, '', known), [], 'a panel without a session shows none');
  assert.deepEqual(requestsVisibleIn(null, 'ses_new', known), []);
  assert.deepEqual(requestsVisibleIn(list, 'ses_new', () => { throw new Error('boom'); }).map((p) => p.id), ['per_own']);

  // knownDescendant never asks anyone and fails closed.
  assert.equal(knownDescendant('ses_grand', 'ses_new', parentOf), true);
  assert.equal(knownDescendant('ses_new', 'ses_child', parentOf), false, 'ancestry has a direction');
  assert.equal(knownDescendant('ses_new', 'ses_new', parentOf), false);
  assert.equal(knownDescendant('ses_unknown', 'ses_new', parentOf), false);
  assert.equal(knownDescendant('a', 'ses_new', new Map([['a', 'b'], ['b', 'a']])), false, 'a cycle cannot hang it');
  assert.equal(knownDescendant('ses_child', 'ses_new', null), false);

  const render = source('ocp-v2-render.js');
  assert.match(render, /const permissions = requestsVisibleIn\(\s+s\.pendingPermissions\?\.length \? s\.pendingPermissions : \(s\.pendingPermission \? \[s\.pendingPermission\] : \[\]\),\s+s\.sessionId, isKnownDescendantSession,\s+\);/);
  assert.match(render, /const questions = requestsVisibleIn\(s\.pendingQuestions, s\.sessionId, isKnownDescendantSession\);/);
  assert.match(render, /for \(const q of questions\) \{/);
  assert.equal(/for \(const q of \(s\.pendingQuestions/.test(render), false, 'no card straight from the queue');
  // A link verifyDescendant had to fetch is remembered, so a recovered request passes the drawing check.
  assert.match(source('ocp-v2-ws.js'), /export function isKnownDescendantSession\(sessionId, ancestorId\) \{\s+return knownDescendant\(sessionId, ancestorId, _parentOf\);/);
});

test('R01: a click cannot answer a request of another session', async () => {
  const store = boundStore('ses_new');
  // However it got there: the old owner's request is in the new session's queue.
  store.addPendingPermission(ask('per_old', 'ses_old'));
  const sent = [];
  const api = { permissionReply: async (p) => { sent.push(p); return { status: 200, data: true }; } };
  const isDescendant = (owner, ancestor) => verifyDescendant(owner, ancestor, {
    parentOf: new Map([['ses_child', 'ses_new']]), fetchParent: async () => '',
  });

  const foreign = await replyToPermission(store, api, ask('per_old', 'ses_old'), 'once', { isDescendant });
  assert.deepEqual(foreign, { ok: false, foreign: true, error: FOREIGN_REQUEST_MESSAGE });
  assert.deepEqual(sent, [], 'nothing was sent on the old owner\'s session');
  assert.deepEqual(permissionIds(store), [], 'and it is off the queue');

  // Its own, and a verified sub-agent's, are answered on the owner's session.
  await replyToPermission(store, api, ask('per_own', 'ses_new'), 'always', { cwd: '/proj', isDescendant });
  await replyToPermission(store, api, ask('per_child', 'ses_child'), 'reject', { message: '  use npm  ', isDescendant });
  assert.deepEqual(sent, [
    { sessionId: 'ses_new', permissionId: 'per_own', response: 'always', cwd: '/proj', message: undefined },
    { sessionId: 'ses_child', permissionId: 'per_child', response: 'reject', cwd: undefined, message: 'use npm' },
  ]);

  // Without a way to verify ancestry a sub-agent's request is not answered either.
  sent.length = 0;
  assert.equal((await replyToPermission(store, api, ask('per_child2', 'ses_child'), 'once')).foreign, true);
  // A request that names no session belongs to nobody.
  assert.equal((await replyToPermission(store, api, { id: 'per_x' }, 'once', { isDescendant })).foreign, true);
  assert.deepEqual(sent, []);

  // The panel moved to another session while ancestry was being looked up.
  const slow = deferred();
  const moving = replyToPermission(store, api, ask('per_child3', 'ses_child'), 'once', { isDescendant: () => slow.promise });
  store.setSession('ses_third', { id: 'ses_third' });
  slow.resolve(true);
  // Review 3: a rebinding is not "foreign". Nothing is sent, and nothing is
  // taken off the queue of the binding the panel is on now.
  assert.deepEqual(await moving, { ok: false, moved: true });
  assert.deepEqual(sent, []);

  // A refused or failed reply is a failure the card can retry, not a foreign request.
  const back = boundStore('ses_new');
  back.addPendingPermission(ask('per_own', 'ses_new'));
  for (const reply of [async () => ({ ok: false, status: 409, error: 'busy' }), async () => { throw new Error('websocket closed'); }]) {
    const result = await replyToPermission(back, { permissionReply: reply }, ask('per_own', 'ses_new'), 'once');
    assert.equal(result.ok, false);
    assert.equal(result.foreign, undefined);
    assert.deepEqual(permissionIds(back), ['per_own'], 'the card stays');
  }
});

test('R01: questions follow the same ownership rule, and the renderer goes through it', async () => {
  const store = boundStore('ses_new');
  const isDescendant = async (owner, ancestor) => owner === 'ses_child' && ancestor === 'ses_new';
  assert.equal(await ownsRequest(store, question('q1', 'ses_new'), isDescendant), true);
  assert.equal(await ownsRequest(store, question('q2', 'ses_child'), isDescendant), true);
  assert.equal(await ownsRequest(store, question('q3', 'ses_old'), isDescendant), false);
  assert.equal(await ownsRequest(store, { id: 'q4' }, isDescendant), false);

  const render = source('ocp-v2-render.js');
  const safeReply = render.slice(render.indexOf('async function safeReply('), render.indexOf('function linkButton('));
  assert.match(safeReply, /const result = await replyToPermission\(store, api, perm, response, \{/);
  assert.match(safeReply, /isDescendant: isDescendantSession,/);
  assert.equal(render.includes('api.permissionReply('), false, 'the renderer never replies on its own');
  // Review 3 (T01): the exemption for transcript cards (`!req._viaToolPart`) is
  // gone. The renderer asks, rejects and aborts nothing on its own: every
  // question card goes through answerQuestion / skipQuestion, which check
  // ownership for queued and transcript cards alike (opencode-review3-flows).
  for (const direct of ['api.questionReply(', 'api.questionReject(', 'api.questionList(', 'api.abort(']) {
    assert.equal(render.includes(direct), false, `the renderer never calls ${direct}`);
  }
  assert.equal(render.includes('_viaToolPart &&'), false);
  const submit = render.slice(render.indexOf('async function submitAnswers('), render.indexOf('function getQuestionDirectory('));
  assert.match(submit, /result = await answerQuestion\(store, api, req, answers, \{ isDescendant: isDescendantSession \}\);/);
  assert.match(render, /const result = await skipQuestion\(store, api, req, \{ isDescendant: isDescendantSession \}\);/);
});

// ── R02 ─────────────────────────────────────────────────────────────────────

const assistant = (id, completed) => ({ info: { id, role: 'assistant', time: { created: 1, ...(completed ? { completed } : {}) } }, parts: [{ id: `${id}_p`, messageID: id, type: 'text', text: `text of ${id}` }] });

test('R02: a transcript that comes back after the panel moved lands nowhere', async () => {
  const store = boundStore('ses_a');
  const read = deferred();
  const api = { sessionMessages: () => read.promise };
  const pending = hydrateTranscript(store, api, { sessionId: 'ses_a' });
  store.clearMessages();
  store.setSession('ses_b', { id: 'ses_b' });           // the user switched tab
  read.resolve({ status: 200, data: [assistant('msg_a', 5)] });
  assert.deepEqual(await pending, { applied: false, superseded: true, error: '', items: [] });
  assert.equal(store.getState().messageOrder.length, 0, 'session A\'s messages are not in session B');

  // A → B → A: the first read of A is another binding's answer.
  const first = deferred();
  const again = boundStore('ses_a');
  const stale = hydrateTranscript(again, { sessionMessages: () => first.promise }, { sessionId: 'ses_a' });
  again.setSession('ses_b', { id: 'ses_b' });
  again.clearMessages();
  again.setSession('ses_a', { id: 'ses_a' });
  first.resolve({ status: 200, data: [assistant('msg_old', 5)] });
  assert.equal((await stale).superseded, true);
  assert.equal(again.getState().messageOrder.length, 0);

  // A panel that was already somewhere else when asked reads nothing.
  let asked = 0;
  const elsewhere = await hydrateTranscript(boundStore('ses_b'), { sessionMessages: async () => { asked += 1; return { status: 200, data: [] }; } }, { sessionId: 'ses_a' });
  assert.deepEqual([elsewhere.superseded, asked], [true, 0]);
});

test('R02: a finished snapshot never ends a turn that an event has just reported running', async () => {
  // The store already says running (the user sent a prompt). The snapshot was
  // read before the reply started streaming, so it shows no turn in flight.
  const store = boundStore('ses_a');
  store.setRunning(true);
  const read = deferred();
  const pending = hydrateTranscript(store, { sessionMessages: () => read.promise }, { sessionId: 'ses_a' });
  applyEvent(store, 'message.part.delta', { sessionID: 'ses_a', messageID: 'msg_live', partID: 'prt_1', field: 'text', delta: 'Hel' });
  read.resolve({ status: 200, data: [assistant('msg_done', 5)] });
  const out = await pending;
  assert.equal(out.applied, true, 'the messages themselves are taken');
  assert.equal(store.getState().running, true, 'a delta arrived meanwhile: the turn is running');

  // The same for the other live signs of a running turn.
  for (const [type, ev] of [
    ['message.updated', { info: { id: 'msg_live', role: 'assistant', time: { created: 9 } } }],
    ['message.part.updated', { part: { id: 'prt_t', messageID: 'msg_live', type: 'tool', state: { status: 'running' } } }],
    ['session.status', { status: { type: 'busy' } }],
  ]) {
    const s = boundStore('ses_a');
    s.setRunning(true);
    const r = deferred();
    const p = hydrateTranscript(s, { sessionMessages: () => r.promise }, { sessionId: 'ses_a' });
    applyEvent(s, type, ev);
    r.resolve({ status: 200, data: [assistant('msg_done', 5)] });
    await p;
    assert.equal(s.getState().running, true, type);
  }

  // Nothing live happened: the snapshot decides, both ways.
  const idle = boundStore('ses_a');
  idle.setRunning(true);                                  // stuck after a reload
  await hydrateTranscript(idle, { sessionMessages: async () => ({ status: 200, data: [assistant('msg_done', 5)] }) }, { sessionId: 'ses_a' });
  assert.equal(idle.getState().running, false);
  const busy = boundStore('ses_a');
  await hydrateTranscript(busy, { sessionMessages: async () => ({ status: 200, data: [assistant('msg_open')] }) }, { sessionId: 'ses_a' });
  assert.equal(busy.getState().running, true);
  // The composer's own reads leave the run state to the turn that is going on.
  const sending = boundStore('ses_a');
  sending.setRunning(true);
  const order = [];
  sending.subscribe((event) => order.push(event.type));
  await hydrateTranscript(sending, { sessionMessages: async () => ({ status: 200, data: [assistant('msg_done', 5)] }) }, {
    sessionId: 'ses_a', syncRunning: false, beforeApply: (items) => order.push(`before:${items.length}`),
  });
  assert.equal(sending.getState().running, true);
  assert.equal(order[0], 'before:1', 'beforeApply runs before the snapshot goes in');

  // A failed read applies nothing and says why.
  const failed = await hydrateTranscript(boundStore('ses_a'), { sessionMessages: async () => ({ status: 404, error: 'gone' }) }, { sessionId: 'ses_a' });
  assert.deepEqual([failed.applied, failed.superseded, failed.error], [false, false, 'gone']);
  const thrown = await hydrateTranscript(boundStore('ses_a'), { sessionMessages: async () => { throw new Error('websocket closed'); } }, { sessionId: 'ses_a' });
  assert.deepEqual([thrown.applied, thrown.error], [false, 'websocket closed']);
});

test('R02: a recovery that lost its session neither applies anything nor puts the session back', async () => {
  const quiet = { sessionStatus: async () => ({ ok: false, unsupported: true }), permissionList: async () => ({ ok: false, unsupported: true }), questionList: async () => ({ status: 200, data: [] }) };
  // Auto-heal: session:get is out when the user switches to another tab.
  const store = boundStore('ses_a');
  const info = deferred();
  let messagesAsked = 0;
  const api = { ...quiet, sessionGet: () => info.promise, sessionMessages: async () => { messagesAsked += 1; return { status: 200, data: [] }; } };
  const healing = rehydratePanelSession(store, api, { sessionId: 'ses_a', refreshInfo: true, requireInfo: true });
  store.setSession('ses_b', { id: 'ses_b', title: 'The one the user picked' });
  info.resolve({ status: 200, data: { id: 'ses_a', title: 'Old' } });
  const out = await healing;
  assert.equal(out.moved, true);
  assert.equal(out.unavailable, false);
  assert.equal(store.getState().sessionId, 'ses_b', 'the panel is not bound back to the session it left');
  assert.equal(store.getState().sessionInfo.title, 'The one the user picked');
  assert.equal(messagesAsked, 0);

  // The session is gone: say so and stop (the panel then opens a fresh one).
  const gone = await rehydratePanelSession(boundStore('ses_a'), { ...quiet, sessionGet: async () => ({ status: 404, error: 'Session not found' }), sessionMessages: async () => { throw new Error('must not be read'); } }, { sessionId: 'ses_a', refreshInfo: true, requireInfo: true });
  assert.deepEqual([gone.unavailable, gone.moved, gone.transcript, gone.error], [true, false, false, 'Session not found']);

  // The normal case still reads everything.
  const whole = boundStore('ses_a');
  const done = await rehydratePanelSession(whole, { ...quiet, sessionGet: async () => ({ status: 200, data: { id: 'ses_a', title: 'T' } }), sessionMessages: async () => ({ status: 200, data: [assistant('m1', 4)] }) }, { sessionId: 'ses_a', refreshInfo: true, requireInfo: true });
  assert.deepEqual([done.info, done.transcript, done.moved, done.unavailable], [true, true, false, false]);
  assert.equal(whole.getState().messageOrder.length, 1);
});

test('R02: every transcript read of the panel and the composer goes through the guarded path', () => {
  const panel = source('ocp-v2-panel.js');
  assert.equal(/\bhydrateMessages\(/.test(panel), false, 'the panel applies no snapshot itself');
  assert.equal(panel.includes('syncRunningFromHydration'), false);
  // Review 3 (T14): the export moved to readTranscriptExport, which builds the
  // download from a snapshot taken before the read. The panel itself reads no
  // transcript directly any more.
  assert.equal((panel.match(/api\.sessionMessages\(/g) || []).length, 0, 'the panel reads no transcript directly');
  assert.equal((source('ocp-v2-session-actions.js').match(/api\.sessionMessages\(/g) || []).length, 1, 'only the export does');
  assert.match(panel, /function hydrateBoundSession\(sessionId, \{ refreshInfo = false, requireInfo = false \} = \{\}\) \{\s+return rehydratePanelSession\(getDefaultStore\(\), api, \{/);
  const refresh = panel.slice(panel.indexOf('async function refreshSessionMessages('), panel.indexOf('function isRecoverablePanelError('));
  assert.match(refresh, /const out = await hydrateBoundSession\(sessionId\);/);
  const switchFn = panel.slice(panel.indexOf('async function switchToSession('), panel.indexOf('async function restoreSessionSelections('));
  assert.match(switchFn, /const hydrated = await hydrateBoundSession\(sid\);/);
  const boot = panel.slice(panel.indexOf('async function boot()'), panel.indexOf('function otherWindowTabIds()'));
  assert.match(boot, /const hydrated = await hydrateBoundSession\(targetSid\);/);
  const heal = panel.slice(panel.indexOf('async function rehydrateActiveSession()'), panel.indexOf('function hydrateBoundSession('));
  assert.match(heal, /const out = await hydrateBoundSession\(sid, \{ refreshInfo: true, requireInfo: true \}\);\s+[\s\S]{0,200}if \(out\.moved\) return;/);
  assert.equal(heal.includes('setSession('), false, 'auto-heal no longer binds the session itself');
  // A new session: what arrived for the old one while it was being created is dropped.
  const fresh = panel.slice(panel.indexOf('async function startFreshSession('), panel.indexOf('async function setActiveProject('));
  assert.match(fresh, /if \(getState\(\)\.messageOrder\.length\) clearMessages\(\);\s+setSession\(sess\.id, sess\);/);

  const send = source('ocp-v2-send.js');
  assert.equal(/store\.hydrateMessages\(/.test(send), false, 'the composer applies no snapshot itself');
  assert.equal((send.match(/await hydrateTranscript\(store, api, \{/g) || []).length, 3);
  assert.equal(send.includes('api.sessionMessages('), false);
});

test('R02: the end of a turn, or a late action answer, touches only the session it was for', async () => {
  // The store hands out its live state: an id has to be read before the await.
  const live = boundStore('ses_a');
  const s = live.getState();
  live.setSession('ses_b', { id: 'ses_b' });
  assert.equal(s.sessionId, 'ses_b', 'getState() is not a snapshot');

  // A turn of session A ends after the panel moved to B, which is running.
  const store = boundStore('ses_a');
  store.setRunning(true);
  store.setSession('ses_b', { id: 'ses_b' });
  store.setRunning(true);
  assert.equal(endTurn(store, 'ses_a'), false);
  assert.equal(store.getState().running, true, 'session B keeps running');
  assert.equal(endTurn(store, 'ses_b'), true);
  assert.equal(store.getState().running, false);
  const send = source('ocp-v2-send.js');
  assert.equal(/store\.setRunning\(false\)/.test(send), false, 'the composer ends a turn through endTurn only');
  assert.equal(send.includes('endTurn(store, s.sessionId)'), false, 'never with an id read from the live state after an await');
  // Review 3: a turn is identified by the binding token captured before its
  // first await (ocp-v2-binding.js), not by a session id: every endTurn of the
  // composer passes that token, and no id is read from the live state.
  assert.equal(/turnSessionId = s\.sessionId/.test(send), false);
  const endings = send.match(/endTurn\(store, [^)]*\)/g) || [];
  assert.ok(endings.length >= 5);
  // Review 4 (V07): a turn the composer starts is `run` = beginTurn(store, turn),
  // the binding token plus the turn's own identity; Stop's `turn` is the turn
  // that was running when it was pressed. Nothing else ends a turn.
  assert.deepEqual([...new Set(endings)].sort(), ['endTurn(store, run)', 'endTurn(store, turn)']);
  assert.equal((send.match(/const run = beginTurn\(store, turn\);/g) || []).length, 2, 'a prompt and a server turn each begin their turn');
  assert.match(send, /const turn = currentTurn\(store, captureBinding\(store\)\);/);
  assert.equal(/store\.setRunning\(true\)/.test(send), false, 'the composer starts a turn through beginTurn only');

  // An undo answered after the panel moved: session B is not marked reverted.
  const undo = storedPromptStore();
  const reply = deferred();
  const asked = [];
  const pending = revertToMessage(undo, {
    sessionRevert: (p) => { asked.push(p.sessionId); return reply.promise; },
    resourceList: async (p) => { asked.push(`resources:${p.sessionId}`); return { status: 200, data: [] }; },
  }, 'msg_u');
  undo.setSession('ses_b', { id: 'ses_b' });
  reply.resolve({ status: 200, data: { id: 'ses_1', revert: { messageID: 'msg_u' } } });
  // Review 3: the continuation of a binding the panel has left is dropped. It
  // resolves `moved` (no prompt for the composer of session B) and asks nothing more.
  assert.deepEqual(await pending, { ok: false, moved: true });
  assert.equal(undo.getState().sessionInfo.revert, undefined, 'the revert of session 1 did not land on session B');
  assert.deepEqual(asked, ['ses_1'], 'the revert went to session 1, and nothing was asked after the move');
});

// ── R03 ─────────────────────────────────────────────────────────────────────

test('R03: a pill for an inactive session restores the model the session has now, not the cached one', async () => {
  // What the tab cache holds after an earlier selection: a whole Session.
  const cached = { id: 'ses_b', title: 'B', directory: '/proj', version: '1.18.34', agent: 'build', model: { providerID: 'anthropic', id: 'old-model' } };
  // Another window (or the CLI) has since run it on another model and agent.
  const asked = [];
  const api = { sessionGet: async (id) => { asked.push(id); return { status: 200, data: { ...cached, agent: 'plan', model: { providerID: 'openai', id: 'new-model' } } }; } };
  const store = boundStore('ses_b');
  store.setModel({ providerID: 'deepseek', modelID: 'previous-tab' });

  const detail = await loadSessionDetail(api, 'ses_b', cached);
  assert.deepEqual(asked, ['ses_b'], 'the cached Session is not trusted');
  assert.equal(detail.fresh, true);
  applySessionSelections(store, detail.info);
  assert.deepEqual(store.getState().model, { providerID: 'openai', modelID: 'new-model' });
  assert.equal(store.getState().agent, 'plan');

  // The read fails: the cached Session is handed back for its title, marked not fresh.
  const offline = await loadSessionDetail({ sessionGet: async () => { throw new Error('websocket closed'); } }, 'ses_b', cached);
  assert.deepEqual(offline, { info: cached, fresh: false });
  // Review 3: the guard is in loadSelectedSession; the panel's callback (which
  // applies the selections) runs only after it.
  const actions = source('ocp-v2-session-actions.js');
  const selected = actions.slice(actions.indexOf('export async function loadSelectedSession('));
  assert.ok(selected.indexOf('if (!detail.fresh) return detail.info;') > 0);
  assert.ok(selected.indexOf('if (!detail.fresh) return detail.info;') < selected.indexOf('apply(detail.info);'), 'nothing is restored from a stale Session');
  let applied = 0;
  assert.deepEqual(await loadSelectedSession(store, { sessionGet: async () => { throw new Error('websocket closed'); } }, 'ses_b', cached, () => { applied += 1; }), cached);
  assert.equal(applied, 0, 'a failed read applies nothing');
});

// ── R04 ─────────────────────────────────────────────────────────────────────

// A user message as OpenCode 1.18.34 stores it for the prompt
// "look @src/app.js#beta and @notes:alpha" sent with a symbol part and an MCP
// resource part (captured from a live serve): the symbol part is kept with its
// source, the resource is replaced by two synthetic text parts.
const SYMBOL_PART = {
  type: 'file', mime: 'text/plain', filename: 'app.js', url: 'file:///proj/src/app.js?start=5&end=7',
  source: {
    text: { value: '@src/app.js#beta', start: 5, end: 21 }, type: 'symbol', path: '/proj/src/app.js',
    range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } }, name: 'beta', kind: 12,
  },
};
const PROMPT_TEXT = 'look @src/app.js#beta and @notes:alpha';
function storedPromptStore() {
  const store = boundStore('ses_1');
  store.upsertMessage({ id: 'msg_u', role: 'user' });
  store.upsertPart({ id: 'p1', messageID: 'msg_u', type: 'text', text: PROMPT_TEXT });
  store.upsertPart({ id: 'p2', messageID: 'msg_u', type: 'text', synthetic: true, text: 'Called the Read tool with the following input: {"filePath":"/proj/src/app.js","offset":5,"limit":3}' });
  store.upsertPart({ id: 'p3', messageID: 'msg_u', type: 'text', synthetic: true, text: '<path>/proj/src/app.js</path>\n<content>\n5: export function beta() {' });
  store.upsertPart({ id: 'p4', messageID: 'msg_u', sessionID: 'ses_1', ...SYMBOL_PART });
  store.upsertPart({ id: 'p5', messageID: 'msg_u', type: 'text', synthetic: true, text: 'Reading MCP resource: alpha (note://alpha)' });
  store.upsertPart({ id: 'p6', messageID: 'msg_u', type: 'text', synthetic: true, text: 'RESOURCE-BODY' });
  store.upsertMessage({ id: 'msg_a', role: 'assistant', parentID: 'msg_u', time: { completed: 2 } });
  store.upsertPart({ id: 'p7', messageID: 'msg_a', type: 'text', text: 'ok' });
  return store;
}
const RESOURCE_LIST = [
  { name: 'alpha', uri: 'note://alpha', client: 'notes', mimeType: 'text/plain', description: 'a note' },
  { name: 'beta', uri: 'note://beta', client: 'notes' },
];
const RESOURCE_PART = {
  type: 'file', mime: 'text/plain', filename: 'alpha', url: 'note://alpha',
  source: { type: 'resource', clientName: 'notes', uri: 'note://alpha', text: { value: '@notes:alpha', start: 26, end: 38 } },
};

test('R04: a prompt is read back with its symbol source and the resources it read', () => {
  const msg = storedPromptStore().getState().messages.get('msg_u');
  const prompt = replayablePrompt(msg);
  assert.equal(prompt.text, PROMPT_TEXT);
  assert.deepEqual(prompt.files, [SYMBOL_PART]);
  assert.deepEqual(prompt.resources, [{ name: 'alpha', uri: 'note://alpha' }]);
  assert.deepEqual(resourceReadsOf(msg), [{ name: 'alpha', uri: 'note://alpha' }]);
  // Only OpenCode's own marker counts: the same words typed by the user do not.
  const typed = boundStore('ses_1');
  typed.upsertMessage({ id: 'm', role: 'user' });
  typed.upsertPart({ id: 'a', messageID: 'm', type: 'text', text: 'Reading MCP resource: alpha (note://alpha)' });
  assert.deepEqual(resourceReadsOf(typed.getState().messages.get('m')), []);
  assert.deepEqual(resourceReadsOf(null), []);
});

test('R04: Undo puts a symbol back with its range and source, and a resource back as a resource', () => {
  const plan = draftRestorePlan({ text: PROMPT_TEXT, files: [SYMBOL_PART], resources: [{ name: 'alpha', uri: 'note://alpha' }], resourceList: RESOURCE_LIST });
  assert.deepEqual(plan.paths, [], 'a ranged symbol is not a whole-file path');
  assert.deepEqual(plan.lost, []);
  assert.deepEqual(plan.mentions.map((item) => [item.kind, item.token]), [['symbol', 'src/app.js#beta'], ['resource', 'notes:alpha']]);

  // What the composer sends from those picks is what the first send carried.
  const picked = new Map(plan.mentions.map((item) => [item.token, item]));
  assert.deepEqual(mentionFileParts(PROMPT_TEXT, picked, '/proj'), [SYMBOL_PART, RESOURCE_PART]);
  // The user edits the prompt: the position follows the text, the range and the source do not change.
  const edited = mentionFileParts(`please ${PROMPT_TEXT}`, picked, '/proj');
  assert.equal(edited[0].url, 'file:///proj/src/app.js?start=5&end=7');
  assert.deepEqual(edited[0].source, { ...SYMBOL_PART.source, text: { value: '@src/app.js#beta', start: 12, end: 28 } });
  // A mention the user removes from the text is not sent, like any other pick.
  assert.deepEqual(mentionFileParts('look and @notes:alpha', picked, '/proj').map((p) => p.source.type), ['resource']);

  // A file mention keeps its source too; an attachment and a path chip go where they came from.
  const fileMention = { type: 'file', mime: 'text/plain', filename: 'a.js', url: 'file:///proj/a.js', source: { type: 'file', path: '/proj/a.js', text: { value: '@a.js', start: 0, end: 5 } } };
  const mixed = draftRestorePlan({
    text: '@a.js and more',
    files: [
      fileMention,
      { type: 'file', mime: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,AAAA' },
      { type: 'file', mime: 'text/plain', filename: 'spec.md', url: 'file:///proj/docs/my%20spec.md' },
    ],
  });
  assert.deepEqual(mixed.attachments, [{ name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' }]);
  assert.deepEqual(mixed.paths, ['/proj/docs/my spec.md']);
  assert.deepEqual(mentionFileParts('@a.js and more', new Map(mixed.mentions.map((i) => [i.token, i])), '/elsewhere'), [fileMention]);

  // What cannot come back as what it was is named, never downgraded.
  const lost = draftRestorePlan({
    text: 'the token is gone',
    files: [SYMBOL_PART, { type: 'file', mime: 'text/plain', filename: 'x', url: 'https://example.test/x' }],
    resources: [{ name: 'alpha', uri: 'note://alpha' }, { name: 'gone', uri: 'note://gone' }],
    resourceList: RESOURCE_LIST,
  });
  assert.deepEqual([lost.paths, lost.mentions], [[], []]);
  assert.deepEqual(lost.lost, ['app.js', 'x', 'alpha (MCP resource)', 'gone (MCP resource)']);
  assert.equal(mentionItemOfPart({ type: 'file', url: 'file:///a', source: { type: 'file', text: { value: 'no at sign' } } }), null);
  assert.equal(mentionItemOfPart({ type: 'file', url: 'file:///a' }), null);
});

test('R04: the undo action hands all of it to the composer', async () => {
  const store = storedPromptStore();
  const asked = [];
  const api = {
    sessionRevert: async () => ({ status: 200, data: { id: 'ses_1', revert: { messageID: 'msg_u' } } }),
    resourceList: async (p) => { asked.push(p); return { status: 200, data: RESOURCE_LIST }; },
  };
  store.setCwd('/proj');
  const result = await revertToMessage(store, api, 'msg_u');
  assert.equal(result.ok, true);
  assert.deepEqual(asked, [{ sessionId: 'ses_1', cwd: '/proj' }], 'the resource list is read once, for this session');
  const mentions = [];
  const restored = restoreDraftAttachments(store, result, { addMentions: (items) => mentions.push(...items) });
  assert.deepEqual(restored, { restored: 2, lost: [] });
  assert.deepEqual(store.getState().pendingPaths, [], 'nothing became a plain path');
  assert.deepEqual(mentionFileParts(result.text, new Map(mentions.map((i) => [i.token, i])), '/proj'), [SYMBOL_PART, RESOURCE_PART]);

  // A composer that cannot take mentions, or a server without resource:list: said, not dropped.
  assert.deepEqual(restoreDraftAttachments(store, result).lost, ['beta', 'alpha']);
  const old = storedPromptStore();
  const without = await revertToMessage(old, { sessionRevert: api.sessionRevert, resourceList: async () => ({ ok: false, unsupported: true, status: 501 }) }, 'msg_u');
  assert.deepEqual(restoreDraftAttachments(old, without, { addMentions() {} }), { restored: 1, lost: ['alpha (MCP resource)'] });

  const panel = source('ocp-v2-panel.js');
  assert.match(panel, /\{ addMentions: \(items\) => composer\.restoreMentions\(items\) \},/);
  assert.match(panel, /if \(lost\.length\) \{\s+pushError\(/);
  const send = source('ocp-v2-send.js');
  assert.match(send, /restoreMentions\(items\) \{\s+for \(const item of Array\.isArray\(items\) \? items : \[\]\) \{\s+if \(item\?\.token\) _pickedMentions\.set\(item\.token, item\);/);
  assert.match(source('ocp-v2-render.js'), /opts\.onComposeText\?\.\(result\.text, \{ files: result\.files, resources: result\.resources, resourceList: result\.resourceList \}\);/);
});

test('R04: Retry sends the resource again, or refuses before it reverts', async () => {
  const store = storedPromptStore();
  const order = [];
  const api = {
    sessionRevert: async () => { order.push('revert'); return { status: 200, data: { id: 'ses_1' } }; },
    resourceList: async () => { order.push('resources'); return { status: 200, data: RESOURCE_LIST }; },
  };
  let sent = null;
  assert.deepEqual(await retryFromMessage(store, api, 'msg_a', async (text, extra) => { order.push('send'); sent = extra.files; return true; }), { ok: true });
  assert.deepEqual(order, ['resources', 'revert', 'send'], 'the list is read before anything changes');
  assert.deepEqual(sent, [SYMBOL_PART, RESOURCE_PART]);
  assert.deepEqual(resourceReplayParts({ text: PROMPT_TEXT, resources: [{ name: 'alpha', uri: 'note://alpha' }], resourceList: RESOURCE_LIST }), { parts: [RESOURCE_PART], lost: [] });

  // The resource is not offered any more: the turn is left as it is.
  const gone = storedPromptStore();
  let reverted = false;
  const refused = await retryFromMessage(gone, { sessionRevert: async () => { reverted = true; return { status: 200, data: {} }; }, resourceList: async () => ({ status: 200, data: [] }) }, 'msg_a', async () => true);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /alpha \(MCP resource\)/);
  assert.equal(reverted, false);
});

// ── R05 ─────────────────────────────────────────────────────────────────────

function bus() {
  const listeners = new Set();
  return {
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    emit: (type, ev) => { for (const fn of [...listeners]) fn(type, ev); },
    size: () => listeners.size,
  };
}
function fakeTimers() {
  const timers = [];
  return {
    setTimer: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimer: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
    run: (ms) => timers.filter((t) => t.live && t.ms === ms).forEach((t) => { t.live = false; t.fn(); }),
    live: () => timers.filter((t) => t.live).map((t) => t.ms),
  };
}
const settled = async (promise) => Promise.race([promise.then((v) => v), new Promise((r) => setTimeout(() => r('pending'), 5))]);

test('R05: another creation failing does not abort this one, however long its own checkout takes', async () => {
  const events = bus();
  const timers = fakeTimers();
  const watch = watchWorktree(events.subscribe, { timeoutMs: 60_000, ...timers });
  watch.identify('calm-river');
  // Another window's creation fails while this checkout is still running.
  events.emit('worktree.failed', { message: 'start command exited 1' });
  assert.deepEqual(timers.live(), [60_000], 'the failure arms nothing: only the last-resort timeout is running');
  timers.run(5000);                                     // the old grace period passes
  assert.equal(await settled(watch.result), 'pending', 'still waiting for its own worktree');
  events.emit('worktree.failed', { message: 'a second one' });
  assert.equal(await settled(watch.result), 'pending');
  // Its own worktree becomes ready much later.
  events.emit('worktree.ready', { name: 'calm-river', branch: 'opencode/calm-river' });
  assert.deepEqual(await watch.result, { ok: true });
  assert.equal(events.size(), 0);
  assert.deepEqual(timers.live(), []);

  // Last resort: no ready at all. What cannot be told apart is said.
  assert.deepEqual(worktreeTimeoutOutcome(''), { ok: false, error: 'The worktree was not ready in time.' });
  const withFailure = worktreeTimeoutOutcome('git worktree add failed');
  assert.equal(withFailure.failureSeen, 'git worktree add failed');
  assert.match(withFailure.error, /which may or may not be this one \(the report names no worktree\): git worktree add failed$/);
  assert.equal(source('ocp-v2-changes-logic.js').includes('failedGraceMs'), false, 'no failure timer is left');
});

// ── N01 / N03 ───────────────────────────────────────────────────────────────

function mcpHarness({ rows = { docs: { status: 'connected' } }, addStatus = 200, persistMcp } = {}) {
  const calls = [];
  const client = {
    extra: { mcp: { add: async (params) => { calls.push(['bound.mcp.add', params]); return { status: addStatus, data: rows }; } } },
    mcp: { status: async () => ({ status: 200, data: rows }) },
  };
  const sent = [];
  const deps = {
    send: (data) => sent.push(data),
    shared: { extra: { mcp: { add: async (params) => { calls.push(['shared.mcp.add', params]); return { status: 200, data: rows }; } } } },
    bound: (sessionId) => { calls.push(['resolve', sessionId]); return client; },
    proxy: async (...args) => { calls.push(['proxy', ...args]); return { status: 200, data: {} }; },
    baseUrlFor: () => 'http://127.0.0.1:1',
    directoryQuery: () => '',
  };
  if (persistMcp !== null) deps.persistMcp = persistMcp || (async (name, config) => { calls.push(['persist', name, config]); });
  return { deps, calls, sent };
}

test('N01: a panel server is registered once, on the session\'s runtime, and saved without a second start', async () => {
  const h = mcpHarness();
  await handleOpencodeV2Request({ type: 'mcp:add', id: 1, sessionId: 'ses_1', name: 'docs', cwd: '/proj', persist: true, config: { command: 'node', args: ['/srv/docs.js'], env: { TOKEN: 'x' } } }, h.deps);
  const config = { type: 'local', command: ['node', '/srv/docs.js'], environment: { TOKEN: 'x' }, enabled: true };
  assert.deepEqual(h.calls, [
    ['resolve', 'ses_1'],
    ['bound.mcp.add', { name: 'docs', config, directory: '/proj' }],
    ['persist', 'docs', config],
  ], 'one start on the session\'s serve; the save starts nothing and the shared serve is not touched');
  assert.deepEqual(h.sent, [{ type: 'mcp:add:result', id: 1, status: 200, data: [{ name: 'docs', status: 'connected', managed: false }], saved: true }]);
  // What is saved starts the same program later.
  assert.deepEqual(toOpenCodeMcpEntry(config), { type: 'local', enabled: true, command: ['node', '/srv/docs.js'], environment: { TOKEN: 'x' } });

  // Without `persist` (an older panel) nothing is written.
  const plain = mcpHarness();
  await handleOpencodeV2Request({ type: 'mcp:add', id: 2, sessionId: 'ses_1', name: 'docs', config: { command: 'node' } }, plain.deps);
  assert.equal(plain.calls.some(([what]) => what === 'persist'), false);
  assert.equal('saved' in plain.sent[0], false);

  // A server that did not start is never saved.
  const failed = mcpHarness({ rows: { docs: { status: 'failed', error: 'Executable not found in $PATH: "nope"' } } });
  await handleOpencodeV2Request({ type: 'mcp:add', id: 3, sessionId: 'ses_1', name: 'docs', persist: true, config: { command: 'nope' } }, failed.deps);
  assert.equal(failed.calls.some(([what]) => what === 'persist'), false);
  assert.equal(failed.sent[0].saved, false);

  // The write fails, or this server has no writer: it runs, and the reply says it was not saved.
  const denied = mcpHarness({ persistMcp: async () => { throw new Error('EACCES: permission denied'); } });
  await handleOpencodeV2Request({ type: 'mcp:add', id: 4, sessionId: 'ses_1', name: 'docs', persist: true, config: { command: 'node' } }, denied.deps);
  assert.deepEqual([denied.sent[0].status, denied.sent[0].saved, denied.sent[0].saveError], [200, false, 'EACCES: permission denied']);
  const none = mcpHarness({ persistMcp: null });
  await handleOpencodeV2Request({ type: 'mcp:add', id: 5, sessionId: 'ses_1', name: 'docs', persist: true, config: { command: 'node' } }, none.deps);
  assert.equal(none.sent[0].saved, false);

  // SynaBun stays read-only, whatever the case, with or without persist.
  for (const name of ['SynaBun', 'synabun', ' SYNABUN ']) {
    const managed = mcpHarness();
    await handleOpencodeV2Request({ type: 'mcp:add', id: 6, sessionId: 'ses_1', name, persist: true, config: { command: 'node', args: ['evil.js'] } }, managed.deps);
    assert.equal(managed.sent[0].status, 403, name);
    assert.deepEqual(managed.calls, [], 'nothing registered, nothing saved');
  }

  assert.ok(OPENCODE_V2_WS_FEATURES.includes('feature:mcp-add-persist'));
  assert.ok(opencodeV2WsCapabilities().includes('feature:mcp-add-persist'));
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /persistMcp: \(name, config\) => persistMcpToOpencodeConfig\(name, config\),/);
});

test('N01: starting a command-based server is confirmed with the exact command and arguments', async () => {
  const calls = [];
  const register = async (p) => { calls.push(p); return { status: 200, data: [{ name: p.name, status: 'connected' }], saved: p.persist === true }; };
  const asked = [];
  const input = 'API_KEY=abc npx -y "" " two words " some-mcp';

  // Declined: nothing is sent.
  const declined = await addMcpServer({ name: 'docs', input, register, confirm: async (text) => { asked.push(text); return false; } });
  assert.deepEqual([declined.ok, declined.cancelled, declined.saved, calls.length], [false, true, false, 0]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0], [
    'Start the MCP server "docs"?',
    '',
    'This runs a program on this computer, with your user\'s permissions:',
    '',
    'Command: "npx"',
    'Arguments (4):',
    '  1. "-y"',
    '  2. ""',
    '  3. " two words "',
    '  4. "some-mcp"',
    'Environment variables set: API_KEY',
    '',
    'It starts now on this session\'s OpenCode runtime and is saved to the OpenCode config, so later sessions start it too.',
  ].join('\n'));
  assert.equal(asked[0].includes('abc'), false, 'the value of an environment variable is not put on screen');

  // No confirm available, or anything but a plain yes: not started either.
  for (const confirm of [undefined, async () => 'yes', async () => { throw new Error('dialog closed'); }]) {
    assert.equal((await addMcpServer({ name: 'docs', input, register, confirm })).cancelled, true);
  }
  assert.equal(calls.length, 0);

  // Confirmed: one request that registers and saves, with what was shown.
  const ok = await addMcpServer({ name: 'docs', input, register, confirm: async () => true });
  assert.deepEqual([ok.ok, ok.saved], [true, true]);
  assert.deepEqual(calls, [{ name: 'docs', persist: true, config: { command: 'npx', args: ['-y', '', ' two words ', 'some-mcp'], env: { API_KEY: 'abc' } } }]);

  // A remote server starts nothing on this machine: no confirm.
  let remoteAsked = 0;
  const remote = await addMcpServer({ name: 'web', input: 'https://mcp.example.test/sse', register, confirm: async () => { remoteAsked += 1; return false; } });
  assert.deepEqual([remote.ok, remoteAsked], [true, 0]);
  assert.equal(mcpStartConfirmText('web', { url: 'https://mcp.example.test/sse' }), '');
  assert.match(mcpStartConfirmText('x', { command: 'node' }), /Arguments: none/);

  // A server that registers but cannot save yet (it predates the persist
  // feature): the panel asks for no save, says so in the confirm and in the
  // note, and does not fall back to the Settings route.
  calls.length = 0;
  let text = '';
  const older = await addMcpServer({ name: 'docs', input: 'node x.js', register, canPersist: false, confirm: async (t) => { text = t; return true; } });
  assert.equal(calls[0].persist, false);
  assert.match(text, /It is not saved: restart SynaBun to save servers from the panel\.$/);
  assert.deepEqual([older.ok, older.saved], [true, false]);
  assert.match(older.note, /was not saved for later ones: restart SynaBun/);
  assert.equal(source('ocp-v2-status.js').includes('/api/opencode/mcp'), false);
});

test('N03: arguments reach OpenCode exactly as typed, and the same argv is saved', async () => {
  const typed = 'node /srv/x.js "" " padded " --token " "';
  const parsed = parseMcpServerInput(typed);
  assert.deepEqual(parsed.config, { command: 'node', args: ['/srv/x.js', '', ' padded ', '--token', ' '] });
  const built = runtimeMcpConfigFor(parsed.config);
  assert.deepEqual(built, { ok: true, config: { type: 'local', command: ['node', '/srv/x.js', '', ' padded ', '--token', ' '], enabled: true } });
  // The Settings route's builder passes them through as well.
  assert.deepEqual(buildOpencodeRuntimeMcpConfig({ command: 'node', args: ['', ' a '] }).command, ['node', '', ' a ']);
  assert.deepEqual(buildOpencodeRuntimeMcpConfig({ command: ['npx', '-y', 'srv'], args: [7, null, 'x'] }).command, ['npx', '-y', 'srv', 'x']);

  // Registered and saved: the same array.
  const h = mcpHarness({ rows: { x: { status: 'connected' } } });
  await handleOpencodeV2Request({ type: 'mcp:add', id: 1, sessionId: 'ses_1', name: 'x', persist: true, config: parsed.config }, h.deps);
  const registered = h.calls.find(([what]) => what === 'bound.mcp.add')[1].config.command;
  const saved = toOpenCodeMcpEntry(h.calls.find(([what]) => what === 'persist')[2]).command;
  assert.deepEqual(registered, ['node', '/srv/x.js', '', ' padded ', '--token', ' ']);
  assert.deepEqual(saved, registered);

  // Validation refuses; it does not repair.
  for (const [config, error] of [
    [{ command: '' }, 'A command or a URL is required.'],
    [{ command: '   ', args: ['x'] }, 'A command or a URL is required.'],
    [{ args: ['x'] }, 'A command or a URL is required.'],
    [{ command: 'node', args: ['ok', 7] }, 'The command and its arguments must be text.'],
    [{ command: 'node', args: 'x' }, 'Arguments must be a list.'],
    [{ command: ['node', null] }, 'The command and its arguments must be text.'],
    [{ command: 'node', env: { A: 1 } }, 'Environment variables must be text.'],
  ]) assert.deepEqual(runtimeMcpConfigFor(config), { ok: false, error }, JSON.stringify(config));
  const bad = mcpHarness();
  await handleOpencodeV2Request({ type: 'mcp:add', id: 2, sessionId: 'ses_1', name: 'x', persist: true, config: { command: 'node', args: ['ok', 7] } }, bad.deps);
  assert.equal(bad.sent[0].status, 400);
  assert.deepEqual(bad.calls, []);
});

// ── N02 ─────────────────────────────────────────────────────────────────────

const AGENTS_A = [{ name: 'build' }, { name: 'plan' }];
const AGENTS_B = [{ name: 'build' }, { name: 'plan' }, { name: 'reviewer' }];

test('N02: after a directory change the previous project\'s agent list validates nothing', () => {
  const choice = createAgentChoice();
  assert.deepEqual(choice.agents(), [...DEFAULT_AGENTS]);
  assert.equal(choice.settle('reviewer', '/a'), null, 'the built-ins validate nothing');
  assert.equal(choice.accept('/a', AGENTS_A, '/a'), true);
  assert.equal(choice.isLoadedFor('/a'), true);

  // The panel switches to a session of project B; its catalog is on its way.
  choice.enter('/b', null);
  assert.equal(choice.isLoadedFor('/b'), false);
  assert.deepEqual(choice.agents(), [...DEFAULT_AGENTS], 'project A\'s agents are not offered in project B');
  // The session's agent is restored: project A's list must not throw it out.
  assert.equal(choice.settle('reviewer', '/b'), null);
  // A list that arrives for the directory the composer already left is ignored.
  assert.equal(choice.accept('/a', AGENTS_A, '/b'), false);
  assert.equal(choice.settle('reviewer', '/b'), null);
  // Project B's list arrives: the agent exists there and stays.
  assert.equal(choice.accept('/b', AGENTS_B, '/b'), true);
  assert.equal(choice.settle('reviewer', '/b'), null);
  assert.deepEqual(choice.agents().map((a) => a.name), ['build', 'plan', 'reviewer']);
  // An agent the project really does not have still falls back.
  assert.equal(choice.settle('ghost', '/b'), 'build');
  // An empty answer (OpenCode not up yet) is not a list.
  assert.equal(createAgentChoice().accept('/b', [], '/b'), false);
});

test('N02: an agent the wrong list replaced is put back when the right list offers it', () => {
  // The order at boot: the agent is restored while the composer is still on
  // the previous directory, whose list is loaded and does not have it.
  const choice = createAgentChoice();
  choice.accept('/a', AGENTS_A, '/a');
  assert.equal(choice.settle('reviewer', '/a'), 'build', 'not in project A: build for now');
  assert.equal(choice.settle('build', '/a'), null);
  choice.enter('/b', null);
  assert.equal(choice.settle('build', '/b'), null, 'nothing decided before the list is there');
  choice.accept('/b', AGENTS_B, '/b');
  assert.equal(choice.settle('build', '/b'), 'reviewer', 're-applied');
  assert.equal(choice.settle('reviewer', '/b'), null);
  assert.equal(choice.settle('build', '/b'), null, 'only once: a later build is the user\'s');

  // A list already known for the directory is used at once.
  const cached = createAgentChoice();
  cached.accept('/a', AGENTS_A, '/a');
  cached.settle('reviewer', '/a');
  cached.enter('/b', AGENTS_B);
  assert.equal(cached.isLoadedFor('/b'), true);
  assert.equal(cached.settle('build', '/b'), 'reviewer');

  // Not put back over a choice made since: the user's pick, or another agent set meanwhile.
  const picked = createAgentChoice();
  picked.accept('/a', AGENTS_A, '/a');
  picked.settle('reviewer', '/a');
  picked.forget();
  picked.enter('/b', AGENTS_B);
  assert.equal(picked.settle('build', '/b'), null);
  const moved = createAgentChoice();
  moved.accept('/a', AGENTS_A, '/a');
  moved.settle('reviewer', '/a');
  moved.enter('/b', AGENTS_B);
  assert.equal(moved.settle('plan', '/b'), null);
  assert.equal(moved.settle('build', '/b'), null);
  // And not when the new project does not have it either.
  const absent = createAgentChoice();
  absent.accept('/a', AGENTS_A, '/a');
  absent.settle('reviewer', '/a');
  absent.enter('/c', AGENTS_A);
  assert.equal(absent.settle('build', '/c'), null);
});

test('N02: the composer and the panel use it in that order', () => {
  const send = source('ocp-v2-send.js');
  assert.match(send, /_agentChoice\.enter\(cwd, _agentCatalog\.get\(cwd\)\);\s+renderAgentButtons\(\);\s+validateAgent\(\);\s+refreshAgents\(\);/);
  assert.match(send, /if \(!_root \|\| !_agentChoice\.accept\(cwd, agents, composerCwd\(\)\)\) return;\s+validateAgent\(\);\s+renderAgentButtons\(\);/);
  assert.equal(/\b_agentsLoaded\b/.test(send), false, 'no "loaded" flag that outlives its directory');
  assert.match(send, /_agentChoice\.forget\(\);\s+store\.setAgent\(next\);\s+storage\.setItem\(STOR_MODE, next\);/);
  // The session's directory is set before its agent is restored.
  const panel = source('ocp-v2-panel.js');
  const restore = panel.slice(panel.indexOf('async function restoreSessionSelections('), panel.indexOf('function beginRenameSession()'));
  assert.ok(restore.indexOf('setCwd(dir);') > 0 && restore.indexOf('setCwd(dir);') < restore.indexOf('applySessionSelections('));
});

// ── N04 ─────────────────────────────────────────────────────────────────────

test('N04: a command turn keeps the source of its file parts', () => {
  // Live on 1.18.34: without `source` a resource part of a command turn is
  // stored and never read; with it OpenCode reads the resource whatever the
  // text position says.
  const parts = commandFileParts({ mentions: [RESOURCE_PART, SYMBOL_PART] });
  assert.deepEqual(parts, [
    { type: 'file', mime: 'text/plain', filename: 'alpha', url: 'note://alpha',
      source: { type: 'resource', clientName: 'notes', uri: 'note://alpha', text: { value: '@notes:alpha', start: 0, end: 0 } } },
    { ...SYMBOL_PART, source: { ...SYMBOL_PART.source, text: { value: '@src/app.js#beta', start: 0, end: 0 } } },
  ]);
  // The originals are not changed (they go back to the composer when the command fails).
  assert.deepEqual(RESOURCE_PART.source.text, { value: '@notes:alpha', start: 26, end: 38 });
  // A part without a source (an attachment, a path chip) is passed as it is.
  const plain = { type: 'file', mime: 'image/png', filename: 'a.png', url: 'data:image/png;base64,AA' };
  assert.equal(commandMentionPart(plain), plain);
  assert.deepEqual(commandMentionPart({ type: 'file', url: 'x://y', source: { type: 'resource', clientName: 'c', uri: 'x://y' } }).source.text, { value: '', start: 0, end: 0 });
});

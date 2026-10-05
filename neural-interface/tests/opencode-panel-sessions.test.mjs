// OpenCode panel, cluster 3: session lifecycle. DOM-free logic and actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPanelStore } from '../public/shared/ocp-v2/ocp-v2-state.js';
import { applyEvent } from '../public/shared/ocp-v2/ocp-v2-events.js';
import {
  visibleMessageOrder, revertBannerView, messageText, turnStartFor, lastUserMessageId, messageActionsFor,
  menuSessions, pickReusableEmptySession, shareView, exportTranscript, SHARE_CONFIRM_TEXT,
} from '../public/shared/ocp-v2/ocp-v2-sessions-logic.js';
import {
  revertToMessage, undoLastTurn, restoreReverted, retryFromMessage, forkSession, deleteMessage,
  shareSession, unshareSession,
} from '../public/shared/ocp-v2/ocp-v2-session-actions.js';
import { UNSUPPORTED_MESSAGE } from '../public/shared/ocp-v2/ocp-v2-caps.js';

// u1 → a1, u2 → a2 (a2 answers u2 through parentID).
function conversation() {
  const store = createPanelStore();
  store.setSession('ses_1', { id: 'ses_1', title: 'T', directory: '/work/app' });
  const add = (id, role, text, extra = {}) => {
    store.upsertMessage({ id, role, time: { created: 1, completed: 2 }, ...extra });
    store.upsertPart({ id: `${id}-p`, messageID: id, type: 'text', text });
  };
  add('u1', 'user', 'first prompt');
  add('a1', 'assistant', 'first answer', { parentID: 'u1' });
  add('u2', 'user', 'second prompt');
  add('a2', 'assistant', 'second answer', { parentID: 'u2' });
  return store;
}
const all = () => true;
const none = () => false;
const okSession = (extra = {}) => ({ status: 200, data: { id: 'ses_1', title: 'T', ...extra } });

// ── O05 undo / redo ─────────────────────────────────────────────────────────

test('a reverted transcript shows only what came before the revert point', () => {
  const order = ['u1', 'a1', 'u2', 'a2'];
  assert.deepEqual(visibleMessageOrder(order, null), order);
  assert.deepEqual(visibleMessageOrder(order, { messageID: 'u2' }), ['u1', 'a1']);
  assert.deepEqual(visibleMessageOrder(order, { messageID: 'u1' }), []);
  assert.deepEqual(visibleMessageOrder(order, { messageID: 'gone' }), order, 'an unknown revert point hides nothing');
  // A prompt typed after the revert shows at once.
  assert.deepEqual(visibleMessageOrder([...order, 'local-user-9'], { messageID: 'u2' }), ['u1', 'a1', 'local-user-9']);
  assert.deepEqual(visibleMessageOrder(undefined, { messageID: 'u2' }), []);
});

test('revertBannerView counts what is hidden and mentions rolled-back files', () => {
  const order = ['u1', 'a1', 'u2', 'a2', 'local-user-9'];
  assert.equal(revertBannerView({ id: 's' }, order), null);
  assert.equal(revertBannerView(null, order), null);
  const view = revertBannerView({ revert: { messageID: 'u2', snapshot: 'x', diff: '' } }, order);
  assert.equal(view.hidden, 2);
  assert.match(view.text, /^Undone: 2 messages hidden/);
  assert.equal(view.hasFileChanges, false);
  assert.equal(revertBannerView({ revert: { messageID: 'a2', diff: 'diff --git a/x b/x' } }, order).hasFileChanges, true);
  assert.match(revertBannerView({ revert: { messageID: 'a2' } }, order).text, /1 message hidden/);
  assert.equal(revertBannerView({ revert: { messageID: 'gone' } }, order).hidden, 0);
});

test('undo reverts on the server, hides the turn and returns the prompt for the composer', async () => {
  const store = conversation();
  const calls = [];
  const api = {
    sessionRevert: async (p) => { calls.push(p); return okSession({ revert: { messageID: 'u2', snapshot: 'abc', diff: '' } }); },
  };
  const result = await revertToMessage(store, api, 'u2');
  assert.deepEqual(calls, [{ sessionId: 'ses_1', messageID: 'u2', cwd: '/work/app' }]);
  assert.equal(result.ok, true);
  assert.equal(result.text, 'second prompt');
  const s = store.getState();
  assert.deepEqual(s.sessionInfo.revert, { messageID: 'u2', snapshot: 'abc', diff: '' });
  assert.deepEqual(visibleMessageOrder(s.messageOrder, s.sessionInfo.revert), ['u1', 'a1']);
  assert.equal(s.messages.size, 4, 'nothing is deleted locally: restore brings it back');
});

test('undo is refused locally while a turn runs, and reports what the server refuses', async () => {
  const store = conversation();
  store.setRunning(true);
  let called = 0;
  const api = { sessionRevert: async () => { called += 1; return okSession(); } };
  assert.deepEqual(await revertToMessage(store, api, 'u2'), { ok: false, error: 'Stop the running turn before you undo.' });
  assert.equal(called, 0);
  store.setRunning(false);

  api.sessionRevert = async () => ({ ok: false, status: 409, error: 'Stop the running turn before you revert.' });
  assert.deepEqual(await revertToMessage(store, api, 'u2'), { ok: false, error: 'Stop the running turn before you revert.', unsupported: false });
  api.sessionRevert = async () => ({ ok: false, unsupported: true, status: 501, error: UNSUPPORTED_MESSAGE });
  assert.equal((await revertToMessage(store, api, 'u2')).unsupported, true);
  api.sessionRevert = async () => { throw new Error('websocket closed'); };
  assert.equal((await revertToMessage(store, api, 'u2')).error, 'websocket closed');
  assert.equal(store.getState().sessionInfo.revert, undefined);
  assert.equal((await revertToMessage(store, api, '')).ok, false);
});

test('/undo targets the newest prompt the server knows; /redo restores', async () => {
  const store = conversation();
  store.upsertMessage({ id: 'local-user-5', role: 'user' });
  assert.equal(lastUserMessageId(store.getState()), 'u2');
  const reverted = [];
  const api = {
    sessionRevert: async (p) => { reverted.push(p.messageID); return okSession({ revert: { messageID: p.messageID } }); },
    sessionUnrevert: async () => okSession(),
  };
  assert.equal((await undoLastTurn(store, api)).ok, true);
  // Undo again steps one prompt further back.
  assert.equal(lastUserMessageId(store.getState()), 'u1');
  assert.equal((await undoLastTurn(store, api)).ok, true);
  assert.deepEqual(reverted, ['u2', 'u1']);
  assert.deepEqual(await undoLastTurn(store, api), { ok: false, error: 'Nothing to undo.' });

  const restored = await restoreReverted(store, api);
  assert.equal(restored.ok, true);
  assert.equal(store.getState().sessionInfo.revert, undefined, 'the cleared field is removed, not kept by the merge');
  assert.deepEqual(await restoreReverted(store, api), { ok: false, error: 'Nothing to restore.' });
});

test('session.updated clears revert and share when OpenCode drops them', () => {
  const store = conversation();
  store.setSessionInfo({ id: 'ses_1', revert: { messageID: 'u2' }, share: { url: 'https://opncd.ai/s/a' } });
  // After a new prompt OpenCode deletes the undone messages and sends the bare Session.
  applyEvent(store, 'session.updated', { sessionID: 'ses_1', info: { id: 'ses_1', title: 'T', time: { created: 1, updated: 9 } } });
  assert.equal(store.getState().sessionInfo.revert, undefined);
  assert.equal(store.getState().sessionInfo.share, undefined);
  applyEvent(store, 'session.updated', { info: { id: 'ses_1', title: 'T', share: { url: 'https://opncd.ai/s/b' } } });
  assert.equal(store.getState().sessionInfo.share.url, 'https://opncd.ai/s/b');
});

// ── O31 message actions ─────────────────────────────────────────────────────

test('messageText is the visible prose of a message', () => {
  const store = conversation();
  store.upsertPart({ id: 'u2-ctx', messageID: 'u2', type: 'text', text: 'injected file contents', synthetic: true });
  store.upsertPart({ id: 'u2-more', messageID: 'u2', type: 'text', text: 'and a second paragraph' });
  store.upsertPart({ id: 'u2-img', messageID: 'u2', type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAA' });
  assert.equal(messageText(store.getState().messages.get('u2')), 'second prompt\n\nand a second paragraph');
  assert.equal(messageText(null), '');
});

test('turnStartFor finds the prompt of an assistant message', () => {
  const s = conversation().getState();
  assert.equal(turnStartFor(s, 'a2'), 'u2');
  assert.equal(turnStartFor(s, 'u1'), 'u1');
  assert.equal(turnStartFor(s, 'nope'), '');
  // Without parentID: the nearest earlier prompt.
  s.messages.get('a2').info = { id: 'a2', role: 'assistant' };
  assert.equal(turnStartFor(s, 'a2'), 'u2');
});

test('message actions depend on role, run state, capabilities and the kind of panel', () => {
  const store = conversation();
  const s = store.getState();
  const u2 = s.messages.get('u2');
  const a2 = s.messages.get('a2');
  assert.deepEqual(messageActionsFor(u2, s, { supports: all }), ['copy', 'undo', 'fork', 'delete']);
  assert.deepEqual(messageActionsFor(a2, s, { supports: all }), ['copy', 'retry']);
  // A server that predates the request types: copy only.
  assert.deepEqual(messageActionsFor(u2, s, { supports: none }), ['copy']);
  assert.deepEqual(messageActionsFor(a2, s, {}), ['copy']);
  assert.deepEqual(messageActionsFor(u2, s, { supports: (t) => t === 'session:fork' }), ['copy', 'fork']);
  // A sub-agent panel cannot open sessions or drive the composer.
  assert.deepEqual(messageActionsFor(u2, s, { supports: all, canOpenSessions: false, canCompose: false }), ['copy', 'delete']);
  store.setParentSession('ses_parent');
  assert.deepEqual(messageActionsFor(u2, store.getState(), { supports: all }), ['copy']);
  store.setParentSession(null);
  // While a turn runs nothing that rewrites the transcript is offered.
  store.setRunning(true);
  assert.deepEqual(messageActionsFor(u2, store.getState(), { supports: all }), ['copy', 'fork']);
  assert.deepEqual(messageActionsFor(a2, store.getState(), { supports: all }), ['copy']);
  store.setRunning(false);
  // The local bubble of a prompt still on its way has no server id.
  store.upsertMessage({ id: 'local-user-7', role: 'user' });
  store.upsertPart({ id: 'l', messageID: 'local-user-7', type: 'text', text: 'pending' });
  assert.deepEqual(messageActionsFor(store.getState().messages.get('local-user-7'), store.getState(), { supports: all }), ['copy']);
  assert.deepEqual(messageActionsFor(null, s, { supports: all }), []);
});

test('retry undoes back to the turn prompt and sends it again', async () => {
  const store = conversation();
  const sent = [];
  const api = { sessionRevert: async (p) => okSession({ revert: { messageID: p.messageID } }) };
  assert.deepEqual(await retryFromMessage(store, api, 'a2', async (text) => { sent.push(text); return true; }), { ok: true });
  assert.deepEqual(sent, ['second prompt']);
  assert.equal(store.getState().sessionInfo.revert.messageID, 'u2');

  const failed = await retryFromMessage(conversation(), api, 'a2', async () => false);
  assert.equal(failed.ok, false);
  assert.equal(failed.text, 'second prompt', 'the prompt is handed back so it is not lost');
  assert.equal((await retryFromMessage(conversation(), api, 'nope', async () => true)).ok, false);
  const refused = await retryFromMessage(conversation(), { sessionRevert: async () => ({ ok: false, error: 'no' }) }, 'a2', async () => { throw new Error('must not send'); });
  assert.deepEqual([refused.ok, refused.error], [false, 'no']);
});

test('delete removes the message once the server agrees', async () => {
  const store = conversation();
  const calls = [];
  const api = { messageDelete: async (p) => { calls.push(p); return { status: 200, data: true }; } };
  assert.deepEqual(await deleteMessage(store, api, 'u2'), { ok: true });
  assert.deepEqual(calls, [{ sessionId: 'ses_1', messageID: 'u2', cwd: '/work/app' }]);
  assert.deepEqual(store.getState().messageOrder, ['u1', 'a1', 'a2']);

  const kept = conversation();
  assert.equal((await deleteMessage(kept, { messageDelete: async () => ({ ok: false, status: 404, error: 'gone' }) }, 'u2')).error, 'gone');
  assert.equal(kept.getState().messages.has('u2'), true);
  kept.setRunning(true);
  assert.match((await deleteMessage(kept, api, 'u2')).error, /Stop the running turn/);
});

// ── O06 fork ────────────────────────────────────────────────────────────────

test('fork resolves the new session and leaves the current one untouched', async () => {
  const store = conversation();
  const calls = [];
  const api = { sessionFork: async (p) => { calls.push(p); return { status: 200, data: { id: 'ses_fork', title: 'T (fork #1)' } }; } };
  const atMessage = await forkSession(store, api, 'u2');
  const whole = await forkSession(store, api);
  assert.deepEqual(atMessage, { ok: true, session: { id: 'ses_fork', title: 'T (fork #1)' } });
  assert.equal(whole.ok, true);
  assert.deepEqual(calls, [
    { sessionId: 'ses_1', messageID: 'u2', cwd: '/work/app' },
    { sessionId: 'ses_1', messageID: undefined, cwd: '/work/app' },
  ]);
  assert.equal(store.getState().sessionId, 'ses_1');
  assert.equal((await forkSession(store, { sessionFork: async () => ({ status: 200, data: {} }) })).ok, false);
});

// ── O07 share ───────────────────────────────────────────────────────────────

test('sharing never happens without a yes from the confirm dialog', async () => {
  const store = conversation();
  let shares = 0;
  const api = { sessionShare: async () => { shares += 1; return okSession({ share: { url: 'https://opncd.ai/s/xyz' } }); } };

  assert.deepEqual(await shareSession(store, api, () => false), { ok: false, cancelled: true });
  assert.deepEqual(await shareSession(store, api, async () => undefined), { ok: false, cancelled: true });
  assert.deepEqual(await shareSession(store, api, () => 'yes'), { ok: false, cancelled: true }, 'only a literal true counts');
  assert.deepEqual(await shareSession(store, api, () => { throw new Error('dialog blocked'); }), { ok: false, cancelled: true });
  assert.equal(shares, 0);
  assert.equal(store.getState().sessionInfo.share, undefined);

  // Asked again on every call: one confirmation does not carry over.
  let asked = 0;
  const confirm = () => { asked += 1; return true; };
  assert.deepEqual(await shareSession(store, api, confirm), { ok: true, url: 'https://opncd.ai/s/xyz' });
  await shareSession(store, api, confirm);
  assert.equal(asked, 2);
  assert.equal(shares, 2);
  assert.equal(store.getState().sessionInfo.share.url, 'https://opncd.ai/s/xyz');
  assert.match(SHARE_CONFIRM_TEXT, /public URL/);
});

test('a refused share is reported; unshare clears the link', async () => {
  const store = conversation();
  const refused = await shareSession(store, { sessionShare: async () => ({ ok: false, status: 403, error: 'Sharing is disabled in the OpenCode config.' }) }, () => true);
  assert.deepEqual([refused.ok, refused.error], [false, 'Sharing is disabled in the OpenCode config.']);
  assert.equal((await shareSession(store, { sessionShare: async () => okSession() }, () => true)).error, 'OpenCode did not return a share link.');

  store.setSessionInfo({ id: 'ses_1', share: { url: 'https://opncd.ai/s/xyz' } });
  assert.deepEqual(await unshareSession(store, { sessionUnshare: async () => okSession() }), { ok: true });
  assert.equal(store.getState().sessionInfo.share, undefined);
});

test('shareView hides sharing when the config disables it or the server cannot do it', () => {
  const info = { id: 'ses_1' };
  assert.deepEqual(shareView(info, 'manual', all), { url: '', canShare: true, canUnshare: false, showLink: false });
  assert.deepEqual(shareView(info, 'disabled', all), { url: '', canShare: false, canUnshare: false, showLink: false });
  assert.deepEqual(shareView(info, 'manual', none), { url: '', canShare: false, canUnshare: false, showLink: false });
  const shared = { id: 'ses_1', share: { url: 'https://opncd.ai/s/xyz' } };
  assert.deepEqual(shareView(shared, 'auto', all), { url: 'https://opncd.ai/s/xyz', canShare: false, canUnshare: true, showLink: true });
  // Already shared, then sharing was disabled: the link is still shown so it can be found.
  assert.deepEqual(shareView(shared, 'disabled', all), { url: 'https://opncd.ai/s/xyz', canShare: false, canUnshare: false, showLink: true });
  assert.equal(shareView(null, 'manual', all).canShare, false);
});

// ── O17 session list ────────────────────────────────────────────────────────

test('the menu leaves sub-agent sessions out, filters and sorts newest first', () => {
  const sessions = [
    { id: 'a', title: 'Fix login', directory: '/work/app', time: { updated: 10 } },
    { id: 'b', title: 'explore: callers', parentID: 'a', time: { updated: 30 } },
    { id: 'c', title: 'Landing page', slug: 'red-moon', directory: '/work/site', time: { updated: 20 } },
    { id: 'd', title: 'old style child', parent_id: 'a', time: { updated: 40 } },
    { title: 'no id' },
    null,
  ];
  assert.deepEqual(menuSessions(sessions).map((s) => s.id), ['c', 'a']);
  assert.deepEqual(menuSessions(sessions, { search: 'LOGIN' }).map((s) => s.id), ['a']);
  assert.deepEqual(menuSessions(sessions, { search: 'red-moon' }).map((s) => s.id), ['c']);
  assert.deepEqual(menuSessions(sessions, { search: '/work/' }).map((s) => s.id), ['c', 'a']);
  assert.deepEqual(menuSessions(sessions, { search: 'zzz' }), []);
  assert.deepEqual(menuSessions(null), []);
});

test('an untouched session of the project is reused instead of creating one more', () => {
  const sessions = [
    { id: 'used', directory: '/work/app', messageCount: 4, time: { updated: 50 } },
    { id: 'empty-new', directory: '/work/app/', messageCount: 0, time: { updated: 40 } },
    { id: 'empty-old', directory: '/work/app', messageCount: 0, time: { updated: 10 } },
    { id: 'empty-other', directory: '/work/site', messageCount: 0, time: { updated: 60 } },
    { id: 'empty-child', directory: '/work/app', messageCount: 0, parentID: 'used', time: { updated: 70 } },
    { id: 'empty-archived', directory: '/work/app', messageCount: 0, time: { updated: 80, archived: 5 } },
  ];
  assert.equal(pickReusableEmptySession(sessions, '/work/app').id, 'empty-new');
  // A session another window has open as a tab is theirs.
  assert.equal(pickReusableEmptySession(sessions, '/work/app', { excludeIds: ['empty-new'] }).id, 'empty-old');
  assert.equal(pickReusableEmptySession(sessions, '/work/app', { excludeIds: ['empty-new', 'empty-old'] }), null);
  assert.equal(pickReusableEmptySession(sessions, '/work/nowhere'), null);
  assert.equal(pickReusableEmptySession(sessions, ''), null, 'no project, no guess');
});

// ── O24 export ──────────────────────────────────────────────────────────────

test('export is a dated JSON file of the transcript without inline image data', () => {
  const items = [
    { info: { id: 'u1', role: 'user' }, parts: [
      { id: 'p1', type: 'text', text: 'look at this' },
      { id: 'p2', type: 'file', mime: 'image/png', filename: 'shot.png', url: `data:image/png;base64,${'A'.repeat(5000)}` },
      { id: 'p3', type: 'file', mime: 'text/plain', url: 'file:///work/app/a.txt' },
    ] },
    { info: { id: 'a1', role: 'assistant' } },
  ];
  const { filename, json } = exportTranscript({ id: 'ses_1', slug: 'Calm River!', title: 'T' }, items, new Date('2026-10-03T12:00:00Z'));
  assert.equal(filename, 'opencode-calm-river-2026-10-03.json');
  const parsed = JSON.parse(json);
  assert.equal(parsed.exportedAt, '2026-10-03T12:00:00.000Z');
  assert.equal(parsed.session.id, 'ses_1');
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].parts[0].text, 'look at this');
  assert.match(parsed.messages[0].parts[1].url, /^data:image\/png;base64,\[omitted \d+ chars\]$/);
  assert.equal(parsed.messages[0].parts[2].url, 'file:///work/app/a.txt');
  assert.deepEqual(parsed.messages[1].parts, []);
  assert.ok(json.length < 2000);
  assert.equal(exportTranscript(null, null, new Date('2026-01-02T00:00:00Z')).filename, 'opencode-session-2026-01-02.json');
});

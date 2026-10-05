// Release-gate review 5 of the OpenCode panel: W01 to W07 (W08 is the log and
// the doc). The three invariants of review 4 are still the frame:
//   A. Nothing the user typed, attached, picked or queued is ever lost.
//   B. A late continuation acts only on the binding, the turn and the intent it
//      started for, and is not dropped when it should have been retried.
//   C. What the audit table says is what the code does.
// This file holds the DOM-free parts. The glue runs under the DOM stand-in,
// started at the end of the file:
//   opencode-review5-glue.run.mjs   the real composer, plan lifecycle, env popover and permission card
//   opencode-review5-panel.run.mjs  the real panel: closing tabs, rename, delete, recovery
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPanelStore, ERRORS_MAX } from '../public/shared/ocp-v2/ocp-v2-state.js';
import { captureBinding } from '../public/shared/ocp-v2/ocp-v2-binding.js';
import { settleFailedSend } from '../public/shared/ocp-v2/ocp-v2-send-logic.js';
import {
  createParkedPrompts, closeWithPromptsConfirm, parkingFullNotice, PARKED_SESSIONS_MAX,
} from '../public/shared/ocp-v2/ocp-v2-composer-logic.js';
import { skipQuestion } from '../public/shared/ocp-v2/ocp-v2-approvals.js';
import { createSignInFailures } from '../public/shared/ocp-v2/ocp-v2-status-logic.js';
import { recoveredErrorSweep, rehydrateSessionState } from '../public/shared/ocp-v2/ocp-v2-rehydrate.js';
import { createCardDrafts } from '../public/shared/ocp-v2/ocp-v2-render-logic.js';
import { renameSession, renameBox } from '../public/shared/ocp-v2/ocp-v2-session-actions.js';

const source = (name) => readFileSync(new URL(`../public/shared/ocp-v2/${name}`, import.meta.url), 'utf8');
const ok = (data) => ({ status: 200, data });
function boundStore(sessionId = 'ses_a', info = {}) {
  const store = createPanelStore();
  store.setSession(sessionId, { id: sessionId, ...info });
  return store;
}
const goTo = (store, sessionId) => store.setSession(sessionId, sessionId ? { id: sessionId, title: sessionId.toUpperCase() } : null);

// ═══ W01: parked prompts are never evicted; closing asks first ══════════════

test('W01: the 65th session with prompts waiting evicts nobody: every payload is still whole', () => {
  const parked = createParkedPrompts();
  const image = { name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' };
  const mention = { type: 'file', filename: 'a.js', url: 'file:///work/a.js?start=1&end=2', source: { type: 'symbol', name: 'run' } };
  for (let i = 0; i < PARKED_SESSIONS_MAX + 6; i += 1) {
    parked.leave(`ses_${i}`, [{ text: `queued in ${i}`, images: [image], paths: [`/work/${i}.md`], mentions: [mention] }]);
  }
  parked.park('ses_late', { item: { text: 'failed late', images: [image] }, error: 'provider down' });
  assert.equal(parked.size(), PARKED_SESSIONS_MAX + 7, 'nothing fell out');
  assert.equal(parked.isFull(), true);
  // The oldest one, which the bound used to drop: the whole prompt comes back.
  assert.deepEqual(parked.take('ses_0'), {
    items: [{ text: 'queued in 0', images: [image], paths: ['/work/0.md'], mentions: [mention] }], failed: 0, queued: 1, errors: [],
  });
  assert.deepEqual(parked.take('ses_late').items, [{ text: 'failed late', images: [image], paths: [], mentions: [] }]);
  // No eviction hook is left to call.
  const logic = source('ocp-v2-composer-logic.js');
  const body = logic.slice(logic.indexOf('export function createParkedPrompts('), logic.indexOf('/** The tray note for what came back from the parking'));
  assert.equal(/onDrop|enforceBound/.test(body), false, 'the parking has no eviction path');
  assert.equal(/bySession\.delete\(/.test(body.replace(/take\(sessionId\) \{[\s\S]*?\n    \},/, '').replace(/forget\(sessionId[\s\S]*?\n    \},/, '')), false, 'entries leave only through take and forget');
});

test('W01: the bound refuses one more queue instead: the composer says so and takes nothing from the box', () => {
  const small = createParkedPrompts({ max: 2 });
  assert.equal(small.isFull(), false);
  small.leave('s1', [{ text: 'a' }]);
  assert.equal(small.isFull(), false);
  small.park('s2', { item: { text: 'b' } });
  assert.equal(small.isFull(), true, 'two sessions have prompts waiting');
  // What is already queued or on its way is still taken, always.
  assert.equal(small.leave('s3', [{ text: 'c' }]), 1);
  assert.equal(small.park('s4', { item: { text: 'd' } }), true);
  small.take('s1'); small.take('s2'); small.take('s3');
  assert.equal(small.isFull(), false, 'room again once their sessions took them back');

  assert.equal(parkingFullNotice(), `Not queued: ${PARKED_SESSIONS_MAX} other tabs already hold prompts that are waiting. Resume or clear some of those first.`);
  // The composer: checked before the prompt enters the queue, and before the
  // box, the strips and the picked mentions are cleared.
  const send = source('ocp-v2-send.js');
  const enter = send.slice(send.indexOf('  async function onEnter() {'), send.indexOf('  function clearInput() {'));
  const refuse = enter.indexOf('if (!_queue.size() && _parked.isFull()) {');
  assert.ok(refuse > 0, 'the queue path asks the parking');
  assert.match(enter.slice(refuse), /^if \(!_queue\.size\(\) && _parked\.isFull\(\)\) \{\s+store\.pushError\(\{ message: parkingFullNotice\(\) \}\);\s+return false;\s+\}/);
  assert.ok(refuse < enter.indexOf('_queue.add('), 'before the prompt is queued');
  assert.ok(refuse < enter.indexOf('clearInput();'), 'before the box is cleared');
  assert.equal(/createParkedPrompts\(\{\s*[^)]*onDrop/.test(send), false, 'no drop listener');
  // The banner is not a reason for the panel to recover (it would be cleared).
  const panel = source('ocp-v2-panel.js');
  assert.match(panel, /rename failed\|could not delete\|could not unarchive\|not queued\/i\.test\(msg\)\) return false;/);
});

test('W01: what is waiting for a session can be read without taking it, and the question names it', () => {
  const parked = createParkedPrompts();
  parked.leave('ses_a', [{ text: 'queued one' }, { text: '', images: [{ name: 'x.png' }] }]);
  parked.park('ses_a', { item: { text: '/review src', command: { command: 'review', args: 'src' } }, error: 'down' });
  const waiting = parked.peek('ses_a');
  assert.deepEqual(waiting.map((item) => item.text), ['/review src', 'queued one', '']);
  assert.equal(parked.has('ses_a'), true, 'peek removes nothing');
  assert.deepEqual(parked.peek('ses_none'), []);
  assert.equal(
    closeWithPromptsConfirm({ items: waiting, label: 'Fix the build' }),
    'Close “Fix the build”?\n\n3 prompts are still waiting to be sent there and will be discarded:\n• “/review src” (command)\n• “queued one”\n• (attachments)',
  );
  assert.equal(
    closeWithPromptsConfirm({ items: [{ text: 'only one' }], lead: 'Delete "X"? The session and its history are removed from OpenCode.' }),
    'Delete "X"? The session and its history are removed from OpenCode.\n\nA prompt is still waiting to be sent there and will be discarded:\n• “only one”',
  );
  const many = Array.from({ length: 8 }, (_, i) => ({ text: `prompt ${i}` }));
  assert.match(closeWithPromptsConfirm({ items: many, label: 'L' }), /• “prompt 4”\n• and 3 more$/);
  assert.equal(closeWithPromptsConfirm({ items: [], label: 'L' }), '', 'nothing waiting: no question');
});

test('W01: a session that is gone keeps nothing new: a late failure is not parked for nobody', () => {
  const store = boundStore('ses_a');
  const parked = createParkedPrompts({ max: 2 });
  const item = { text: 'was running', images: [], paths: [], mentions: [] };
  // The user closed the tab (asked first when something was waiting).
  assert.deepEqual(parked.forget('ses_a'), []);
  assert.equal(parked.goneAs('ses_a'), 'closed');
  const turn = captureBinding(store);
  goTo(store, 'ses_b');
  assert.deepEqual(settleFailedSend(turn, parked, { item, error: 'Aborted' }), { here: false, parked: false });
  assert.equal(parked.size(), 0, 'no entry for a session nobody can return to (it would count against the bound for ever)');
  // A session that was lost (deleted elsewhere): the same, and the composer tells the user.
  parked.leave('ses_lost', [{ text: 'queued' }]);
  assert.deepEqual(parked.forget('ses_lost', { lost: true }).map((entry) => entry.text), ['queued']);
  assert.equal(parked.goneAs('ses_lost'), 'lost');
  assert.equal(parked.park('ses_lost', { item }), false);
  assert.equal(parked.leave('ses_lost', [{ text: 'typed after it was lost' }]), 0, 'nor a queue typed into it afterwards');
  assert.equal(parked.has('ses_lost'), false);
  // Back on screen (an archived session opened again): it exists.
  parked.reopen('ses_a');
  assert.equal(parked.goneAs('ses_a'), '');
  assert.equal(parked.park('ses_a', { item }), true);
  assert.equal(parked.goneAs('ses_never'), '');

  const send = source('ocp-v2-send.js');
  assert.match(send, /if \(left\) tellIfLost\(left, _queue\.list\(\)\);\s+if \(left\) _parked\.leave\(left, _queue\.list\(\)\);[\s\S]{0,220}if \(_queueSessionId\) _parked\.reopen\(_queueSessionId\);/);
  assert.match(send, /function tellIfLost\(sessionId, item\) \{\s+const items = \(Array\.isArray\(item\) \? item : \[item\]\)\.filter\(Boolean\);\s+if \(!items\.length \|\| _parked\.goneAs\(sessionId\) !== 'lost'\) return;/);
  assert.match(send, /if \(!_parked\.park\(sessionId, \{ item, error \}\)\) \{ tellIfLost\(sessionId, item\); return false; \}/);
  assert.equal((send.match(/else tellIfLost\(turn\.sessionId, promptItem\);/g) || []).length, 2, 'both prompt paths');
});

test('W01: every close the user starts asks before anything is closed or deleted', () => {
  const panel = source('ocp-v2-panel.js');
  // The question is asked in the panel, in two steps (ocp-v2-confirm-logic.js),
  // never with a native dialog: nothing waiting is no question, and the
  // answer counts only for the prompts the question listed.
  const may = panel.slice(panel.indexOf('async function mayCloseTab('), panel.indexOf('// `byUser`: the user closed the tab'));
  assert.match(may, /const waiting = promptsWaitingFor\(sessionId\);\s+const text = closeWithPromptsConfirm\(\{ items: waiting, label: tabLabelFor\(sessionId\), lead \}\) \|\| lead;\s+if \(!text\) return true;/);
  assert.match(may, /if \(!\(await _confirms\.ask\(\{ key, surface, text, confirmLabel \}\)\)\) return false;\s+if \(samePrompts\(promptsWaitingFor\(sessionId\), waiting\)\) return true;/);
  assert.equal(/window\.confirm/.test(panel), false, 'no native dialog in the panel');
  // The tab's ×.
  const pill = panel.slice(panel.indexOf("pill.querySelector('.term-minimized-pill-close')"), panel.indexOf('  tray.appendChild(pill);'));
  assert.ok(pill.indexOf('if (!(await mayCloseTab(sessionId))) return;') > 0, 'the × asks');
  assert.ok(pill.indexOf('if (!(await mayCloseTab(sessionId))) return;') < pill.indexOf('closeSessionBackend('), 'before the session is deleted');
  assert.match(pill, /await handlePillClose\(sessionId, \{ byUser: true \}\);/);
  // The header's X.
  const close = panel.slice(panel.indexOf('async function closeCurrentSession() {'), panel.indexOf('function deleteSessionBestEffort('));
  assert.ok(close.indexOf('if (!(await mayCloseTab(id))) return;') > 0 && close.indexOf('if (!(await mayCloseTab(id))) return;') < close.indexOf('closeSessionBackend('), 'the header X asks before the backend close');
  // The session menu: Delete (one question, asked even when nothing is
  // waiting, before anything is deleted) and Archive (before its request).
  const del = panel.slice(panel.indexOf("delBtn.addEventListener('click'"), panel.indexOf('item.appendChild(delBtn);'));
  const asksDelete = del.indexOf("if (!(await mayCloseTab(sid, { key: `session-delete:${sid}`, surface: 'menu', lead, confirmLabel: 'Delete session' }))) return;");
  assert.ok(asksDelete > 0 && asksDelete < del.indexOf('closeSessionBackend(') && asksDelete < del.indexOf('item.remove();'), 'Delete asks before it deletes');
  const archive = panel.slice(panel.indexOf("archiveBtn.addEventListener('click'"), panel.indexOf('item.appendChild(archiveBtn);'));
  assert.ok(archive.indexOf('if (closesTab && !(await mayCloseTab(sid, question()))) return;') > 0 && archive.indexOf('if (closesTab && !(await mayCloseTab(sid, question()))) return;') < archive.indexOf('api.sessionUpdate('), 'Archive asks before it archives');
  // ...and again, should what is waiting when the archive is back not be what
  // was asked about (review 6, N01: compared by the prompts, not by their number).
  assert.match(archive, /const mayClose = closesTab && \(samePrompts\(promptsWaitingFor\(sid\), confirmed\) \|\| await mayCloseTab\(sid, question\(\)\)\);\s+if \(mayClose && _tabSessionIds\.includes\(sid\)\) await handlePillClose\(sid, \{ byUser: true \}\)/);
  // A close nobody started by hand cannot ask: it is `lost`, and reported.
  assert.match(panel, /handlePillClose\(sid\)\.catch\(\(err\) => console\.warn\('\[ocp-v2-panel\] close of a deleted session failed', err\)\);/);
  assert.match(panel, /console\.warn\('\[ocp-v2-panel\] auto-heal session refresh failed', out\.error\);\s+removeTab\(sid\);/);
});

// ═══ W02: a typed rejection reason lives as long as its request ═════════════

test('W02: a draft is never evicted while its request is open, and goes when the request does, whoever answered', () => {
  const drafts = createCardDrafts();
  drafts.set('per_first', 'use the staging database', { sessionId: 'ses_a' });
  for (let i = 0; i < 400; i += 1) drafts.set(`per_${i}`, `reason ${i}`, { sessionId: i % 2 ? 'ses_a' : 'ses_b' });
  assert.equal(drafts.get('per_first'), 'use the staging database', 'the oldest draft is still there after 400 more');
  assert.equal(drafts.size(), 401);
  // Retyping keeps the owner.
  drafts.set('per_first', 'use staging');
  assert.equal(drafts.get('per_first'), 'use staging');
  // Answered somewhere else (permission.replied): gone, by id.
  assert.equal(drafts.clear('per_first'), true);
  assert.equal(drafts.get('per_first'), '');
  assert.equal(drafts.clear('per_first'), false);
  // The server lists session A's open requests: A's other drafts were answered
  // while nobody was listening. B's are not A's to settle.
  assert.equal(drafts.settle('ses_a', ['per_1', 'per_3', 'per_0']), 198);
  assert.deepEqual([drafts.get('per_1'), drafts.get('per_3'), drafts.get('per_5'), drafts.get('per_0')], ['reason 1', 'reason 3', '', 'reason 0']);
  assert.equal(drafts.settle('', []), 0);
  // The session is deleted: its requests are gone with it.
  assert.equal(drafts.forgetSession('ses_b'), 200);
  assert.equal(drafts.size(), 2);
  assert.equal(drafts.forgetSession(''), 0);
  drafts.set('per_1', '');
  assert.equal(drafts.size(), 1, 'emptied by the user');

  const logic = source('ocp-v2-render-logic.js');
  const body = logic.slice(logic.indexOf('export function createCardDrafts('));
  assert.equal(/\bmax\b|drafts\.keys\(\)\.next\(\)/.test(body), false, 'no bound that evicts');
  const render = source('ocp-v2-render.js');
  assert.match(render, /onEvent\(\(eventType, ev\) => \{\s+if \(eventType === 'permission\.replied'\) _permissionReasons\.clear\(permissionKeyOf\(ev\)\);\s+else if \(eventType === 'session\.deleted'\) _permissionReasons\.forgetSession\(ev\?\.info\?\.id \|\| ev\?\.sessionID \|\| ev\?\.sessionId\);\s+\}\);/);
  assert.match(render, /if \(event\?\.type === 'permission:set' && event\.listed\) settlePermissionReasons\(state\);/);
});

test('W02: only the server\'s own list settles drafts: a local edit of the queue, or a switch, is not one', async () => {
  const store = boundStore('ses_a');
  const events = [];
  store.subscribe((event) => { if (event?.type === 'permission:set') events.push(event.listed === true); });
  store.addPendingPermission({ id: 'per_1', sessionID: 'ses_a' });
  store.setPendingPermissions([{ id: 'per_1', sessionID: 'ses_a' }]);
  store.removePendingPermission('per_1');
  assert.deepEqual(events, [false, false, false], 'local edits are not a list');
  // The recovery's read is.
  const api = {
    sessionStatus: async () => ({ ok: false }),
    permissionList: async () => ok([{ id: 'per_2', sessionID: 'ses_a' }]),
    questionList: async () => ({ ok: false }),
    sessionTodo: async () => ({ ok: false }),
  };
  const applied = await rehydrateSessionState(store, api, { sessionId: 'ses_a' });
  assert.equal(applied.permissions, true);
  assert.equal(events[events.length - 1], true, 'the listed flag is on the event');
  // A read the server does not support (or that failed) settles nothing.
  events.length = 0;
  await rehydrateSessionState(store, { ...api, permissionList: async () => ({ ok: false, unsupported: true, status: 501 }) }, { sessionId: 'ses_a' });
  assert.deepEqual(events, [], 'no list, no event');
});

// ═══ W04: a sign-in link belongs to the attempt that is open ════════════════

test('W04: with two sessions signing in to a server of the same name, a failed link is shown in neither', () => {
  let clock = 1_000;
  const failures = createSignInFailures({ now: () => clock, ttlMs: 60_000 });
  const rows = [{ name: 'linear', status: 'needs_auth' }];
  const a = failures.expect('ses_a', 'linear');
  const b = failures.expect('ses_b', 'linear');
  assert.notEqual(a.id, b.id, 'each attempt has its own identity');
  assert.equal(failures.open(), 2);
  // A's page could not be opened. Nothing in the event says it is A's.
  assert.equal(failures.record({ mcpName: 'linear', url: 'https://linear.app/oauth?state=a' }), '', 'not attributed to the newest attempt');
  assert.deepEqual(failures.forSession('ses_b', rows), [], 'B does not get A\'s link');
  assert.deepEqual(failures.forSession('ses_a', rows), [], 'and A is not guessed either');
  // B's request ends: A's is the only one open, and the next failure is A's.
  b.done();
  assert.equal(failures.open(), 1);
  assert.equal(failures.record({ mcpName: 'linear', url: 'https://linear.app/oauth?state=a2' }), 'ses_a');
  assert.deepEqual(failures.forSession('ses_a', rows), [{ mcpName: 'linear', url: 'https://linear.app/oauth?state=a2' }]);
  assert.deepEqual(failures.forSession('ses_b', rows), []);
});

test('W04: an attempt is retired when its request ends: a later failure of that name has no owner here', () => {
  let clock = 1_000;
  const failures = createSignInFailures({ now: () => clock, ttlMs: 60_000 });
  const rows = [{ name: 'linear', status: 'needs_auth' }];
  const attempt = failures.expect('ses_a', 'linear');
  attempt.done();
  attempt.done();                                  // twice is harmless
  assert.equal(failures.open(), 0);
  // Seconds later, another window (or the CLI) fails to open a page for a server of that name.
  clock += 5_000;
  assert.equal(failures.record({ mcpName: 'linear', url: 'https://linear.app/oauth?state=elsewhere' }), '', 'an ended request owns nothing');
  assert.deepEqual(failures.forSession('ses_a', rows), []);
  // Two attempts of one session for one server (a double click): still that session's.
  const first = failures.expect('ses_a', 'linear');
  failures.expect('ses_a', 'linear');
  assert.equal(failures.record({ mcpName: 'linear', url: 'https://linear.app/oauth?state=mine' }), 'ses_a');
  first.done();
  assert.equal(failures.open(), 1);
  // No session or no name: nothing to open, and done() exists anyway.
  failures.expect('', 'linear').done();
  failures.expect('ses_a', '').done();
  assert.equal(failures.open(), 1);
  // The session is gone: its attempts and its links with it.
  failures.forget('ses_a');
  assert.equal(failures.open(), 0);
  assert.deepEqual(failures.forSession('ses_a', rows), []);

  const status = source('ocp-v2-status.js');
  assert.match(status, /const res = await call\.catch\(\(err\) => \(\{ ok: false, error: err\?\.message \}\)\);\s+attempt\?\.done\(\);/);
  assert.match(status, /\}\)\.finally\(\(\) => attempt\.done\(\)\);/);
  const logic = source('ocp-v2-status-logic.js');
  assert.equal(/\.reverse\(\)\.find\(/.test(logic.slice(logic.indexOf('export function createSignInFailures('))), false, 'no "newest expectation" guess');
});

// ═══ W05: a rename the server refused is a failure ══════════════════════════

test('W05: an error reply to the rename is a failure: nothing is renamed locally and the caller is told', async () => {
  // What the server answers when OpenCode refuses (server.js `session:update`).
  const refusals = [
    { type: 'session:update:result', id: 7, status: 500, data: { error: 'Rename failed upstream' } },
    { type: 'session:update:result', id: 7, ok: false, status: 404, error: 'Session not found' },
    { type: 'error', id: 7, error: 'handler blew up' },
    { type: 'session:update:result', id: 7, status: 403 },
  ];
  const texts = ['Rename failed upstream', 'Session not found', 'handler blew up', 'Rename failed (HTTP 403)'];
  for (const [i, reply] of refusals.entries()) {
    const store = boundStore('ses_a', { title: 'Old title' });
    const out = await renameSession(store, { sessionUpdate: async () => reply }, 'New title');
    assert.deepEqual(out, { ok: false, sessionId: 'ses_a', title: 'New title', applied: false, current: true, error: texts[i] }, `reply ${i}`);
    assert.equal(store.getState().sessionInfo.title, 'Old title', `reply ${i}: the store kept the title the session has`);
  }
  // Refused after the panel moved: not this session's banner.
  const moved = boundStore('ses_a', { title: 'Old title' });
  const target = captureBinding(moved);
  goTo(moved, 'ses_b');
  const late = await renameSession(moved, { sessionUpdate: async () => refusals[0] }, 'New title', { binding: target });
  assert.deepEqual([late.ok, late.current, late.applied], [false, false, false]);
  // A good reply still renames (also the bare `true` an older server sends).
  for (const reply of [ok({ id: 'ses_a', title: 'New title' }), { type: 'session:update:result', id: 1, status: 200, data: true }]) {
    const store = boundStore('ses_a', { title: 'Old title' });
    assert.deepEqual(await renameSession(store, { sessionUpdate: async () => reply }, 'New title'), { ok: true, sessionId: 'ses_a', title: 'New title', applied: true });
    assert.equal(store.getState().sessionInfo.title, 'New title');
  }
  // Through the box both panels use: the caller sees the failure.
  const store = boundStore('ses_a', { title: 'Old title' });
  const seen = [];
  let restored = 0;
  const finish = renameBox({
    currentTitle: 'Old title',
    read: () => 'New title',
    rename: (next) => renameSession(store, { sessionUpdate: async () => refusals[0] }, next),
    after: (result) => seen.push(result),
    restore: () => { restored += 1; },
  });
  await finish(false);
  assert.deepEqual([seen[0].ok, seen[0].error, restored], [false, 'Rename failed upstream', 1]);
});

test('W05: the panel takes its own title back when a rename is refused, and the other callers look at their reply', () => {
  const panel = source('ocp-v2-panel.js');
  // The header box and the naming dialog: no second request races the rename,
  // and the optimistic title is taken back on a failure.
  // (Review 6, N03: the title state a rename found is kept on its pending
  // record, and the take-back goes through settleRename.)
  assert.match(panel, /rename = _pendingRenames\.begin\(target\.sessionId, next, titleStateBefore\(target\.sessionId\)\);\s+markOpenCodeTitleManual\(target\.sessionId, next\);\s+cancelTitleReassert\(target\.sessionId\);\s+return renameSession\(getDefaultStore\(\), api, next, \{ binding: target \}\);/);
  assert.match(panel, /settleRename\(rename, result\.ok\);\s+if \(result\.ok\) \{[\s\S]{0,420}console\.warn\('\[ocp-v2-panel\] rename failed', result\.error\);/);
  assert.match(panel, /const rename = _pendingRenames\.begin\(sid, nextTitle, titleStateBefore\(sid\)\);\s+markOpenCodeTitleManual\(sid, nextTitle\);\s+cancelTitleReassert\(sid\);/);
  assert.match(panel, /if \(!_pendingRenames\.end\(rename, ok\) \|\| ok\) return;\s+takeBackRenamedTitle\(rename\.sessionId, rename\.before, rename\.title\);/);
  // The pushed-back title: a refused push relabels nothing.
  assert.match(panel, /api\.sessionUpdate\(sessionId, \{ title: latest\.title \}\)\.then\(\(res\) => \{[\s\S]{0,260}if \(replyFailed\(res\) \|\| _sessionTitleState\.get\(sessionId\)\?\.title !== latest\.title\) return;\s+updateOpenCodeTitleLocally\(sessionId, latest\.title\);/);
  // Opening an archived row, and the menu's Delete.
  assert.match(panel, /if \(archived && replyFailed\(unarchived\) && getState\(\)\.sessionId === sid\) \{\s+pushError\(\{ message: `Could not unarchive “\$\{title\}”: \$\{replyError\(unarchived, 'no answer'\)\}` \}\);/);
  assert.match(panel, /if \(!replyFailed\(res\)\) return \{ ok: true \};\s+const error = replyError\(res, 'Delete failed'\);/);
  assert.match(panel, /if \(out && out\.ok === false\) pushError\(\{ message: `Could not delete “\$\{title\}”: \$\{out\.error \|\| 'no answer'\}` \}\);/);
  // The create-time rename is best effort and shows nothing as set: a refusal is logged.
  assert.match(panel, /const named = await api\.sessionUpdate\(sess\.id, \{ title \}\);\s+if \(replyFailed\(named\)\) console\.warn\(/);
  // The child panel uses the helper and shows its failure.
  const child = source('ocp-v2-childpanel.js');
  assert.match(child, /rename: \(next\) => renameSession\(store, api, next, \{ binding: target \}\),\s+after: \(result\) => \{\s+if \(result\.ok\) return;/);
});

test('W05 (same mistake): a Skip the server refused is not a success', async () => {
  const req = { id: 'que_1', sessionID: 'ses_a' };
  const refused = { type: 'question:reject:result', id: 3, ok: false, error: 'no such question' };
  const store = boundStore('ses_a');
  store.addPendingQuestion(req);
  assert.deepEqual(await skipQuestion(store, { questionReject: async () => refused }, req), { ok: false, error: 'no such question' });
  assert.deepEqual(await skipQuestion(store, { questionReject: async () => ({ status: 500, data: { error: 'upstream' } }) }, req), { ok: false, error: 'upstream' });
  assert.deepEqual(await skipQuestion(store, { questionReject: async () => ok(true) }, req), { ok: true });
  // A transcript card: the turn is stopped; a refused stop is said.
  const card = { id: 'tool_1', _viaToolPart: true, sessionID: 'ses_a', _binding: store.getBinding() };
  assert.deepEqual(await skipQuestion(store, { abort: async () => ({ type: 'message:abort:result', ok: false, error: 'serve is gone' }) }, card), { ok: false, error: 'serve is gone' });
  assert.deepEqual(await skipQuestion(store, { abort: async () => ({ type: 'message:abort:result', ok: true }) }, card), { ok: true });
  // The panel moved while it was out: `moved`, whatever the server said.
  const moving = boundStore('ses_a');
  moving.addPendingQuestion(req);
  const out = skipQuestion(moving, { questionReject: async () => { goTo(moving, 'ses_b'); return refused; } }, req);
  assert.deepEqual(await out, { ok: false, moved: true });
  // The card: a refused skip is a banner, the card is usable again and keeps its answers.
  const render = source('ocp-v2-render.js');
  assert.match(render, /else if \(result\.ok === false && !result\.moved\) \{\s+store\.pushError\(\{ message: result\.error \|\| 'Question skip failed' \}\);\s+wrap\.classList\.remove\('ocpv2-question-locked'\);\s+return;\s+\}\s+if \(!result\.moved\) clearQuestionSelection\(req\.id\);/);
});

// ═══ W06: a recovery clears what it recovered from, nothing newer ═══════════

test('W06: an error that appears while a recovery is out is still there when it is done', () => {
  const store = boundStore('ses_a');
  store.pushError({ message: 'websocket closed' });
  store.pushError({ message: 'request timeout: session:get' });
  store.pushError({ message: 'something was dropped', notice: true });
  const sweep = recoveredErrorSweep(store);
  // While the recovery waits, the user's send and rename fail on the same session.
  store.pushError({ message: 'Provider refused the prompt' });
  store.pushError({ message: 'Rename failed' });
  assert.equal(sweep.clear(), true);
  assert.deepEqual(store.getState().errors.map((err) => err.message), ['something was dropped', 'Provider refused the prompt', 'Rename failed']);
  // One of the old errors was dismissed meanwhile: fine.
  const other = boundStore('ses_a');
  other.pushError({ message: 'websocket closed' });
  const again = recoveredErrorSweep(other);
  other.dismissError(other.getState().errors[0].id);
  other.pushError({ message: 'newer' });
  assert.equal(again.clear(), true);
  assert.deepEqual(other.getState().errors.map((err) => err.message), ['newer']);
  // Nothing was on screen when it began: nothing is cleared, and no event is raised.
  const quiet = boundStore('ses_a');
  const none = recoveredErrorSweep(quiet);
  quiet.pushError({ message: 'newer' });
  const events = [];
  quiet.subscribe((event) => events.push(event?.type));
  assert.equal(none.clear(), true);
  assert.deepEqual([quiet.getState().errors.length, events], [1, []]);
  // clearErrors() with no list still clears every error (Clear all), never a notice.
  store.clearErrors();
  assert.deepEqual(store.getState().errors.map((err) => err.message), ['something was dropped']);
});

// ═══ W07: a notice is not pushed out by errors ══════════════════════════════

test('W07: a notice stays until it is dismissed, however many errors follow it', () => {
  const store = boundStore('ses_a');
  store.pushError({ message: 'kept until dismissed', notice: true });
  for (let i = 0; i < ERRORS_MAX * 3; i += 1) store.pushError({ message: `error ${i}` });
  const errors = store.getState().errors;
  assert.equal(errors[0].message, 'kept until dismissed', 'the notice is still first');
  assert.equal(errors.filter((err) => !err.notice).length, ERRORS_MAX, 'errors are still bounded');
  assert.deepEqual(errors.slice(1).map((err) => err.message), Array.from({ length: ERRORS_MAX }, (_, i) => `error ${ERRORS_MAX * 2 + i}`), 'the oldest errors went, in order');
  // Notices do not push each other out either, nor errors.
  for (let i = 0; i < 30; i += 1) store.pushError({ message: `notice ${i}`, notice: true });
  assert.equal(store.getState().errors.filter((err) => err.notice).length, 31);
  assert.equal(store.getState().errors.filter((err) => !err.notice).length, ERRORS_MAX);
  // The newest entry is still the last one (the composer reads it there).
  store.pushError({ message: 'last error' });
  assert.equal(store.getState().errors[store.getState().errors.length - 1].message, 'last error');
  // Dismissed by the user.
  const first = store.getState().errors.find((err) => err.message === 'kept until dismissed');
  store.dismissError(first.id);
  assert.equal(store.getState().errors.some((err) => err.message === 'kept until dismissed'), false);
});

// ═══ W03 and the glue ═══════════════════════════════════════════════════════

test('W03: the finalization lock is held per plan turn, and a turned-away finalizer is noted on it', () => {
  const plan = source('ocp-v2-plan.js');
  assert.match(plan, /const lockKey = `\$\{at\.binding\}:\$\{planTurnId\}`;/);
  assert.match(plan, /if \(held\) \{[\s\S]{0,420}held\.again = \{ reason, force: force \|\| held\.again\?\.force === true, lenient: lenient \|\| held\.again\?\.lenient === true \};\s+return false;\s+\}/);
  assert.match(plan, /if \(locks\.get\(lockKey\) === lock\) locks\.delete\(lockKey\);/);
  assert.match(plan, /if \(again && !completed && planTurnStillOpen\(store, at, planTurnId\)\) \{/);
  assert.equal(/_finalizing\.set\(store, at\.binding\)/.test(plan), false, 'no binding-only lock');
});

function runGlue(name) {
  const file = fileURLToPath(new URL(`./${name}`, import.meta.url));
  const env = { ...process.env, SYNABUN_TYPESAFE: 'off' };
  delete env.SYNABUN_ASSISTANT_SESSION;
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 120_000, env });
  const stdout = String(result.stdout || '');
  const output = `${stdout}\n${result.stderr || ''}`;
  assert.equal(result.status, 0, output.slice(-6000));
  assert.match(stdout, /no problems/, output.slice(-6000));
  return stdout;
}

test('W01, W02, W03, W04: the real composer, plan lifecycle, env popover and permission card', () => {
  const stdout = runGlue('opencode-review5-glue.run.mjs');
  assert.ok((stdout.match(/^ok {3}/gm) || []).length >= 6, stdout.slice(-3000));
});

test('W01, W05, W06: the real panel', () => {
  const stdout = runGlue('opencode-review5-panel.run.mjs');
  assert.ok((stdout.match(/^ok {3}/gm) || []).length >= 6, stdout.slice(-3000));
});

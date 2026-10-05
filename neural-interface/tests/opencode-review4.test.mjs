// Code review 4 of the OpenCode panel. Three invariants, and every finding
// (V01 to V13, the rest of T13) is an instance of one of them:
//   A. Nothing the user typed, attached, picked or queued is ever lost.
//   B. A late continuation acts only on the thing it started for: the same
//      session binding AND, where there is one, the same turn or the same
//      navigation intent.
//   C. What the audit table says is what the code does.
// This file holds the DOM-free parts: the mechanisms (turn identity,
// navigation intents, the parking of a session's queue) and each finding's
// logic. The glue runs under the DOM stand-in, started at the end of the file:
//   opencode-review4-glue.run.mjs   the real composer, plan lifecycle and env popover
//   opencode-review4-panel.run.mjs  the real panel: tabs, New session, boot, rename, menu, recovery
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPanelStore, MAX_ATTACHED } from '../public/shared/ocp-v2/ocp-v2-state.js';
import { captureBinding, createNavigation, latestFor, isBindingToken } from '../public/shared/ocp-v2/ocp-v2-binding.js';
import { beginTurn, currentTurn, endTurn, settleFailedSend } from '../public/shared/ocp-v2/ocp-v2-send-logic.js';
import {
  createParkedPrompts, parkedPromptsNotice, keptPromptNotice, createPromptQueue, PARKED_SESSIONS_MAX, prefilledDraft,
} from '../public/shared/ocp-v2/ocp-v2-composer-logic.js';
import { replyToPermission, skipQuestion } from '../public/shared/ocp-v2/ocp-v2-approvals.js';
import { createSignInFailures } from '../public/shared/ocp-v2/ocp-v2-status-logic.js';
import { recoveredErrorSweep } from '../public/shared/ocp-v2/ocp-v2-rehydrate.js';
import { createCardDrafts } from '../public/shared/ocp-v2/ocp-v2-render-logic.js';
import {
  navigateAfter, adoptReusableSession, landWithoutTabs, shouldNameCreatedSession, renameBox, renameSession,
  createSessionForNavigation, stopForNavigation,
} from '../public/shared/ocp-v2/ocp-v2-session-actions.js';

const source = (name) => readFileSync(new URL(`../public/shared/ocp-v2/${name}`, import.meta.url), 'utf8');
const deferred = () => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const ok = (data) => ({ status: 200, data });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function boundStore(sessionId = 'ses_a', info = {}) {
  const store = createPanelStore();
  store.setSession(sessionId, { id: sessionId, ...info });
  return store;
}
const goTo = (store, sessionId) => store.setSession(sessionId, sessionId ? { id: sessionId, title: sessionId.toUpperCase() } : null);

// ═══ Invariant A: nothing of the user's is lost ═════════════════════════════

test('V01: a session\'s queue is parked when the panel leaves and handed back whole, over several switches', () => {
  const parked = createParkedPrompts();
  const image = { name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' };
  const mention = { type: 'file', mime: 'text/plain', filename: 'a.js', url: 'file:///work/a/a.js?start=3&end=9', source: { type: 'symbol', name: 'run' } };
  const queueOfA = [
    { id: 'q1', text: 'first for A', images: [image], paths: ['/work/a/notes.md'], mentions: [mention] },
    { id: 'q2', text: 'second for A', images: [], paths: [], mentions: [] },
  ];
  assert.equal(parked.leave('ses_a', queueOfA), 2);
  assert.equal(parked.leave('ses_b', []), 0, 'an empty queue leaves nothing behind');
  assert.equal(parked.has('ses_b'), false);
  assert.equal(parked.leave('', queueOfA), 0, 'no session, no parking');

  // The panel is on B, then on C: A's queue is untouched, and never theirs.
  assert.equal(parked.take('ses_b'), null);
  assert.equal(parked.take('ses_c'), null);
  // A prompt of A that was already on its way fails while the panel is away.
  assert.equal(parked.park('ses_a', { item: { text: 'was in flight', images: [], paths: [], mentions: [] }, error: 'provider is down' }), true);

  const back = parked.take('ses_a');
  assert.deepEqual(back.items.map((item) => item.text), ['was in flight', 'first for A', 'second for A'], 'what was on its way goes first, the queue keeps its order');
  assert.deepEqual([back.failed, back.queued, back.errors], [1, 2, ['provider is down']]);
  assert.deepEqual(back.items[1], { text: 'first for A', images: [image], paths: ['/work/a/notes.md'], mentions: [mention] }, 'attachments, paths and picked mentions come back with the prompt');
  assert.equal(parked.take('ses_a'), null, 'handed out once');

  // The same queue, parked and taken again and again, loses nothing.
  const queue = createPromptQueue();
  let entry = back;
  for (let round = 0; round < 4; round += 1) {
    queue.clear();
    assert.equal(queue.restore(entry.items), 3);
    assert.equal(queue.isPaused(), true, 'restored paused: nothing goes out until the user resumes');
    parked.leave('ses_a', queue.list());
    entry = parked.take('ses_a');
    assert.deepEqual(entry.items.map((item) => item.text), ['was in flight', 'first for A', 'second for A'], `round ${round}`);
    assert.deepEqual(entry.items[1].mentions, [mention], `round ${round}: mentions`);
  }

  // The note for the tray says what came back and why.
  assert.equal(
    parkedPromptsNotice(back),
    'A prompt sent to this session was not delivered (provider is down). 2 prompts were waiting in this session\'s queue when you left it. They are in the queue, paused: resume to send, or remove.',
  );
  assert.equal(
    parkedPromptsNotice({ items: [{}], failed: 0, queued: 1, errors: [] }),
    'A prompt was waiting in this session\'s queue when you left it. It is in the queue, paused: resume to send, or remove.',
  );
});

test('V01: no eviction at all: past the bound nothing falls out (review 5, W01); a closed session hands back what waited for it', () => {
  assert.ok(PARKED_SESSIONS_MAX >= 50, 'generous');
  const small = createParkedPrompts({ max: 2 });
  small.leave('s1', [{ text: 'one of s1' }, { text: 'two of s1' }]);
  small.park('s2', { item: { text: 'failed in s2' } });
  small.leave('s3', [{ text: 'of s3' }]);
  small.park('s2', { item: { text: 'again s2' } });
  small.leave('s4', [{ text: 'of s4' }]);
  assert.deepEqual([small.has('s1'), small.has('s2'), small.has('s3'), small.has('s4')], [true, true, true, true], 'every session keeps what is waiting for it');
  assert.deepEqual(small.take('s1').items.map((item) => item.text), ['one of s1', 'two of s1']);

  // A session that was closed: what waited for it is handed back.
  const parked = createParkedPrompts();
  parked.leave('ses_gone', [{ text: 'never sent' }]);
  parked.park('ses_gone', { item: { text: 'failed', images: [{ name: 'x' }] } });
  const dropped = parked.forget('ses_gone');
  assert.deepEqual(dropped.map((item) => item.text), ['failed', 'never sent']);
  assert.equal(parked.has('ses_gone'), false);
  assert.deepEqual(parked.forget('ses_gone'), []);

  // Review 6, N02: this test used to assert the one-line notice that named
  // the dropped prompts and pointed at the prompt history ("What you typed is
  // still in the prompt history"), which keeps 50 entries and no attachment.
  // Each prompt is kept on a notice of its own now, and the notice says so.
  assert.deepEqual(dropped.map((item) => keptPromptNotice({ item, label: 'Fix the build' })), [
    'Not sent: “failed” with 1 attachment was waiting for “Fix the build”, and that session is gone. It is kept here until you put it back into the box or discard it; reloading the page drops it.',
    'Not sent: “never sent” was waiting for “Fix the build”, and that session is gone. It is kept here until you put it back into the box or discard it; reloading the page drops it.',
  ]);
  assert.match(keptPromptNotice({ item: { text: `prompt 0 ${'x'.repeat(80)}` }, label: 'L' }), /^Not sent: “prompt 0 x{51}…” was waiting for “L”/);
  assert.equal(keptPromptNotice({}), '');
});

test('V01: a notice about dropped prompts is not an error of the transcript: it survives a switch and a recovery', () => {
  const store = boundStore('ses_a');
  store.pushError({ message: 'websocket closed' });
  store.pushError({ message: 'A queued prompt was dropped', notice: true });
  // What a session switch does first.
  store.clearMessages();
  assert.deepEqual(store.getState().errors.map((err) => err.message), ['A queued prompt was dropped']);
  store.pushError({ message: 'request timeout' });
  store.clearErrors();
  assert.deepEqual(store.getState().errors.map((err) => err.message), ['A queued prompt was dropped'], 'clearErrors keeps it too');
  // The user dismisses it.
  store.dismissError(store.getState().errors[0].id);
  assert.equal(store.getState().errors.length, 0);

  // The composer does not hold the queue for a notice, the panel does not try
  // to recover from one.
  const send = source('ocp-v2-send.js');
  assert.match(send, /if \(event\?\.type === 'error:push' && !state\.errors\[state\.errors\.length - 1\]\?\.notice\) _queue\.pause\(\);/);
  const panel = source('ocp-v2-panel.js');
  assert.match(panel, /function isRecoverablePanelError\(err\) \{\s+[^\n]*\n\s+if \(err\?\.notice\) return false;/);
  // A session that went away by itself hands its parked prompts to the user as
  // notices (review 5: a tab the user closes asks first instead; review 6: the
  // composer keeps each prompt whole on its notice).
  assert.match(panel, /_composer\?\.forgetSession\?\.\(sessionId, \{ lost: !byUser, label: tabLabelFor\(sessionId\) \}\);/);
  assert.match(send, /if \(lost\) keepPrompts\(dropped, label \|\| sessionLabel\(sessionId\)\);/);
  assert.match(send, /store\.pushError\(\{\s+message: keptPromptNotice\(\{ item: kept, label \}\),\s+notice: true,/);
});

test('V02: a slash command that could not run is a queue item that stays that command, with what it took', () => {
  const parked = createParkedPrompts();
  const image = { name: 'diagram.png', mime: 'image/png', dataUrl: 'data:image/png;base64,BBBB' };
  const mention = { type: 'file', mime: 'text/plain', filename: 'README.md', url: 'file:///work/a/README.md', source: { type: 'resource', uri: 'docs://readme' } };
  parked.park('ses_a', {
    item: { text: '/review the diff', images: [image], paths: ['/work/a/src'], mentions: [mention], command: { command: 'review', args: 'the diff' } },
    error: '/review failed',
  });
  const back = parked.take('ses_a');
  assert.deepEqual(back.items, [{
    text: '/review the diff', images: [image], paths: ['/work/a/src'], mentions: [mention], command: { command: 'review', args: 'the diff' },
  }]);
  const queue = createPromptQueue();
  queue.restore(back.items);
  const [item] = queue.list();
  assert.deepEqual(item.command, { command: 'review', args: 'the diff' }, 'the queue keeps it a command');
  assert.deepEqual([item.images, item.paths, item.mentions], [[image], ['/work/a/src'], [mention]]);
  assert.equal(queue.isPaused(), true, 'and never runs it by itself');
  // Only the parking makes command items: what the user queues is a prompt.
  const typed = createPromptQueue();
  assert.equal(typed.add({ text: '/review x', command: { command: 'review', args: 'x' } }).command, undefined);
  // The queue runs it as the command, never through the prompt path.
  const send = source('ocp-v2-send.js');
  assert.match(send, /const sent = item\.command\s+\? \(await runCommandFor\(item\)\)\.ran\s+: await sendTextMessage\(item\.text, \{/);
  const sendText = send.slice(send.indexOf('async function sendTextMessage(text, options = {}) {'), send.indexOf('async function waitForAsyncTurn('));
  assert.equal(/resolveSlash|runShell|runCommand/.test(sendText), false, 'sendTextMessage still never interprets text');
});

test('V02 / V09: an attachment that is put back is never refused for the strip\'s limit', () => {
  const store = boundStore('ses_a');
  const img = (i) => ({ name: `f${i}.png`, mime: 'image/png', dataUrl: `data:image/png;base64,${i}` });
  for (let i = 0; i < MAX_ATTACHED; i += 1) assert.equal(store.addAttachedImage(img(i)), true);
  assert.equal(store.addAttachedImage(img('x')), false, 'adding is limited');
  assert.equal(store.addAttachedImage(img('back'), { restore: true }), true, 'putting back is not');
  assert.equal(store.getState().attachedImages.length, MAX_ATTACHED + 1);
  const send = source('ocp-v2-send.js');
  assert.equal((send.match(/store\.addAttachedImage\(img, \{ restore: true \}\)/g) || []).length, 3, 'the failed prompt, the failed command and a kept prompt put back (review 6, N02)');
});

test('a prompt handed to the composer does not replace a draft that is being written', () => {
  assert.equal(prefilledDraft('', 'continue the work'), 'continue the work');
  assert.equal(prefilledDraft('   ', 'continue the work'), 'continue the work');
  assert.equal(prefilledDraft('my half-typed thought  ', 'continue the work'), 'my half-typed thought\n\ncontinue the work', 'the draft stays, the handoff goes under it');
  assert.equal(prefilledDraft('my draft', ''), 'my draft');
  assert.equal(prefilledDraft('continue the work', 'continue the work'), 'continue the work', 'handed over twice: once in the box');
  assert.match(source('ocp-v2-panel.js'), /ta\.value = prefilledDraft\(ta\.value, text\);/);
  assert.equal(/ta\.value = String\(text \|\| ''\);/.test(source('ocp-v2-panel.js')), false);
});

test('text typed into a card comes back with the card: a reject reason, like a question\'s answers', () => {
  const drafts = createCardDrafts();
  drafts.set('per_1', 'use the staging database instead');
  assert.equal(drafts.get('per_1'), 'use the staging database instead', 'a rebuilt card (a state event, a session switch and back) finds it');
  assert.equal(drafts.get('per_2'), '');
  drafts.set('per_1', '');
  assert.equal(drafts.get('per_1'), '', 'cleared by the user');
  drafts.set('per_1', 'a'); drafts.set('per_2', 'b'); drafts.set('per_3', 'c');
  assert.deepEqual([drafts.get('per_1'), drafts.get('per_2'), drafts.get('per_3'), drafts.size()], ['a', 'b', 'c', 3], 'a draft is never evicted to make room (review 5, W02)');
  drafts.clear('per_2');
  assert.equal(drafts.get('per_2'), '', 'cleared once the reply went out');
  drafts.set('', 'x');
  assert.equal(drafts.size(), 2);
  const render = source('ocp-v2-render.js');
  assert.match(render, /const typedReason = _permissionReasons\.get\(reasonKey\);\s+if \(typedReason\) \{ reasonInput\.value = typedReason; reasonRow\.hidden = false; \}\s+reasonInput\.addEventListener\('input', \(\) => _permissionReasons\.set\(reasonKey, reasonInput\.value, \{ sessionId: reasonOwner \}\)\);/);
  assert.match(render, /if \(!ok\) unlock\(\);\s+else _permissionReasons\.clear\(reasonKey\);/);
  // The question card keeps its selections and typed answers the same way (by request id).
  assert.match(render, /const sectionAnswers = _getOrInitSelection\(req\.id, total\);/);
  assert.match(render, /if \(sectionAnswers\[qIdx\]\.custom\) customInput\.value = sectionAnswers\[qIdx\]\.custom;/);
});

// ═══ Invariant B: a late continuation acts only on what it started for ═════

test('V07: a turn has an identity: an older send\'s completion does not end a newer turn of the same session', () => {
  const store = boundStore('ses_a');
  // Turn 1 goes out.
  const first = beginTurn(store, captureBinding(store));
  assert.equal(store.getState().running, true);
  assert.equal(isBindingToken(first), true);
  assert.equal(first.sessionId, 'ses_a');
  // The session goes idle (the event) while turn 1's send is still reading the
  // transcript, and the next prompt goes out.
  store.setRunning(false);
  const second = beginTurn(store, captureBinding(store));
  assert.equal(store.getState().running, true);
  // Turn 1's continuation arrives.
  assert.equal(first.onBinding(), true, 'same session, same binding: the transcript is still its session\'s');
  assert.equal(first.isCurrent(), false, 'but the turn is not the newest one any more');
  assert.equal(endTurn(store, first), false);
  assert.equal(store.getState().running, true, 'turn 2 keeps running');
  assert.equal(endTurn(store, second), true);
  assert.equal(store.getState().running, false);

  // Without any overlap nothing changes: the turn ends itself, also after the
  // idle event already cleared the flag, and after events re-raised it.
  const solo = boundStore('ses_a');
  const turn = beginTurn(solo, captureBinding(solo));
  solo.setRunning(false);
  solo.setRunning(true);              // session.status busy: begins no turn
  assert.equal(endTurn(solo, turn), true);
  assert.equal(solo.getState().running, false);

  // Stop: the turn that was running when it was pressed.
  const stopping = boundStore('ses_a');
  beginTurn(stopping, captureBinding(stopping));
  const stop = currentTurn(stopping, captureBinding(stopping));
  assert.equal(stop.isCurrent(), true);
  stopping.setRunning(false);
  const next = beginTurn(stopping, captureBinding(stopping));
  assert.equal(endTurn(stopping, stop), false, 'a Stop that comes back late does not end the next prompt');
  assert.equal(stopping.getState().running, true);
  assert.equal(endTurn(stopping, next), true);

  // The binding still counts: A → B → A is another binding, whatever the turn.
  const moved = boundStore('ses_a');
  const old = beginTurn(moved, captureBinding(moved));
  goTo(moved, 'ses_b'); goTo(moved, 'ses_a');
  moved.setRunning(true);
  assert.equal(endTurn(moved, old), false);
  assert.equal(moved.getState().running, true);

  // A failure of the older turn is still the session's (its banner and its
  // strips are restored here), only its turn state is not touched.
  const failing = boundStore('ses_a');
  const one = beginTurn(failing, captureBinding(failing));
  failing.setRunning(false);
  beginTurn(failing, captureBinding(failing));
  assert.deepEqual(settleFailedSend(one, createParkedPrompts(), { item: { text: 'x' }, error: 'boom' }), { here: true, parked: false });
});

test('V07: plan turns have an identity too', () => {
  const store = boundStore('ses_a');
  assert.equal(store.getState().planTurnId, 0);
  const first = store.beginPlanTurn();
  const second = store.beginPlanTurn();
  assert.ok(first > 0 && second > first, 'a new number for every plan turn, also within one millisecond');
  assert.equal(store.getState().planTurnId, second);
  store.clearPlanState();
  assert.equal(store.getState().planTurnId, 0);
  // Leaving plan mode ends the plan turn without clearing it: the guard reads
  // planTurnActive as well as the identity.
  const third = store.beginPlanTurn();
  store.setMode('build');
  assert.deepEqual([store.getState().planTurnActive, store.getState().planTurnId], [false, third]);
  const plan = source('ocp-v2-plan.js');
  assert.match(plan, /return at\.isCurrent\(\) && s\.planTurnActive === true && s\.planTurnId === planTurnId;/);
  assert.match(plan, /if \(planTurn && s\.planTurnId !== planTurn\) return false;/);
  // The deferred finalizers (the tick after idle, a sub-agent going idle) name the plan turn they were raised for.
  assert.match(plan, /const planTurn = store\.getState\(\)\.planTurnId;\s+setTimeout\(\(\) => \{\s+if \(!at\.isCurrent\(\)\) return;\s+maybeFinalizePlanTurn\(reason, store, \{ lenient: true, planTurn \}\)/);
  assert.match(source('ocp-v2-manager.js'), /maybeFinalizePlanTurn\('child:idle', _primary\.store, \{ lenient: true, planTurn \}\)/);
  const send = source('ocp-v2-send.js');
  assert.match(send, /const planTurn = isPlanTurn \? beginPlanTurnForSend\(store\) : 0;/);
  assert.equal((send.match(/maybeFinalizePlanTurn\('[a-z:]+', store, \{ lenient: true, planTurn \}\)/g) || []).length, 2, 'both finalizers of a send name their plan turn');
  assert.match(send, /if \(isPlanTurn && store\.getState\(\)\.planTurnId === planTurn\) store\.clearPlanState\(\{ preserveMode: true \}\);/);
});

test('navigation intents: the latest choice wins, also before anything was bound', () => {
  const store = boundStore('ses_a');
  const navigation = createNavigation(store);
  // Two clicks, neither has bound anything yet: a binding token cannot tell
  // them apart, the intents can.
  const older = navigation.begin();
  const olderBinding = captureBinding(store);
  const newer = navigation.begin();
  assert.equal(olderBinding.isCurrent(), true, 'the binding has not changed');
  assert.equal(older.isCurrent(), false);
  assert.equal(newer.isCurrent(), true);
  assert.equal(older.sessionId, 'ses_a');
  // The older one may not bind any more; the newer one binds, and stays current through its own rebinding.
  assert.equal(older.apply(() => goTo(store, 'ses_x')), false);
  assert.equal(store.getState().sessionId, 'ses_a');
  assert.equal(newer.apply(() => { goTo(store, null); goTo(store, 'ses_b'); }), true);
  assert.equal(store.getState().sessionId, 'ses_b');
  assert.equal(newer.isCurrent(), true, 'its own rebinding does not overtake it');

  // A rebinding nobody announced (the active tab was closed) overtakes every pending intent.
  const pending = navigation.begin();
  goTo(store, null);
  assert.equal(pending.isCurrent(), false);

  // observe(): what the panel starts itself. It overtakes nothing, and stands
  // down for any choice made after it.
  const choice = navigation.begin();
  const boot = navigation.observe();
  assert.equal(choice.isCurrent(), true, 'the user\'s earlier choice still stands');
  assert.equal(boot.isCurrent(), true);
  assert.equal(boot.apply(() => goTo(store, 'ses_tab')), true);
  assert.equal(choice.isCurrent(), true, 'and still does after boot landed');
  assert.equal(choice.apply(() => goTo(store, 'ses_choice')), true);
  assert.equal(boot.isCurrent(), false, 'and boot stands down for a rebinding it did not make');
  assert.equal(boot.apply(() => goTo(store, 'ses_late')), false);
  assert.equal(store.getState().sessionId, 'ses_choice');
  const focus = navigation.observe();
  navigation.begin();
  assert.equal(focus.isCurrent(), false, 'a choice made after it wins');

  // repair(): the session on screen is gone and has to be replaced. A choice
  // that has bound nothing yet does not leave the dead session on screen...
  const dead = createPanelStore();
  goTo(dead, 'ses_dead');
  const nav2 = createNavigation(dead);
  const repair = nav2.repair();
  const pendingChoice = nav2.begin();              // e.g. New session, still being created
  assert.equal(repair.isCurrent(), true);
  assert.equal(repair.apply(() => goTo(dead, 'ses_fresh')), true);
  // ...and still wins when it binds.
  assert.equal(pendingChoice.isCurrent(), true, 'the repair overtook nothing');
  assert.equal(pendingChoice.apply(() => goTo(dead, 'ses_wanted')), true);
  // Taken somewhere else while the replacement was being created: it stands down.
  const late = nav2.repair();
  nav2.begin().apply(() => goTo(dead, 'ses_elsewhere'));
  assert.equal(late.isCurrent(), false);
  assert.equal(late.apply(() => goTo(dead, 'ses_fresh_2')), false);
  assert.equal(dead.getState().sessionId, 'ses_elsewhere');
  nav2.destroy();
  // A same-session setSession (fresh metadata) is not a navigation.
  const steady = navigation.begin();
  store.setSession('ses_choice', { id: 'ses_choice', title: 'renamed' });
  assert.equal(steady.isCurrent(), true);
  // The session-actions helpers take an intent wherever they took a binding token.
  assert.equal(isBindingToken(steady), true);
  navigation.destroy();
});

test('V06: a tab click that waited for the panel to open does nothing once a newer click was made', async () => {
  const store = boundStore('ses_a');
  const navigation = createNavigation(store);
  const went = [];
  // Click on tab X while the panel is hidden: it has to wait for the panel.
  const opening = deferred();
  const first = navigation.begin();
  const firstDone = navigateAfter(first, () => opening.promise, (nav) => { went.push('ses_x'); nav.apply(() => goTo(store, 'ses_x')); });
  // The panel is visible by now; a click on tab Y switches at once.
  const second = navigation.begin();
  assert.equal(await navigateAfter(second, () => null, (nav) => { went.push('ses_y'); nav.apply(() => goTo(store, 'ses_y')); }), true);
  // The first click resumes.
  opening.resolve();
  assert.equal(await firstDone, false);
  assert.deepEqual(went, ['ses_y']);
  assert.equal(store.getState().sessionId, 'ses_y', 'the newer click stands');
  // Nothing in between: the click goes through, also when its wait failed.
  const third = navigation.begin();
  assert.equal(await navigateAfter(third, () => Promise.reject(new Error('socket')), () => { went.push('ses_z'); }), true);
  assert.deepEqual(went, ['ses_y', 'ses_z']);

  const panel = source('ocp-v2-panel.js');
  const click = panel.slice(panel.indexOf('async function handlePillClick(sessionId) {'), panel.indexOf('async function handlePillClose(sessionId) {'));
  assert.ok(click.indexOf('const nav = _nav.begin();') > 0 && click.indexOf('const nav = _nav.begin();') < click.indexOf('await'), 'the intent begins at the click, before anything is awaited');
  assert.match(click, /const went = await navigateAfter\(\s+nav,\s+\(\) => \(_visible \? null : showPrimaryOpencodePanel\(\)\),\s+\(\) => switchToSession\(sessionId, _tabInfoCache\.get\(sessionId\) \|\| null, \{ nav \}\),\s+\);/);
  const sw = panel.slice(panel.indexOf('async function switchToSession('), panel.indexOf('async function restoreSessionSelections('));
  assert.match(sw, /const intent = nav \|\| _nav\.begin\(\);/);
  assert.match(sw, /const bound = intent\.apply\(\(\) => \{\s+clearMessages\(\);\s+setSession\(sid, info\);/);
  assert.match(sw, /if \(!bound\) \{ ensureTab\(sid, info\); renderPill\(\); return; \}/);
  // Every rebinding of the panel that follows a wait goes through an intent.
  for (const fn of ['const bootNav = _nav.observe();', 'await startFreshSession({ cwd, nav: _nav.repair() });', 'const owner = nav || _nav.begin();', 'if (focus && _nav.latest() === attachBegan) {']) {
    assert.ok(panel.includes(fn), fn);
  }
});

test('V05: boot lands nowhere once the user chose something, also when the adoption lookup failed', async () => {
  // The lookup fails after the user navigated: nothing is adopted, nothing is created.
  {
    const store = createPanelStore();
    const navigation = createNavigation(store);
    const boot = navigation.observe();
    const list = deferred();
    const created = [];
    const landing = landWithoutTabs(boot, {
      adopt: (nav) => adoptReusableSession(nav, { list: () => list.promise, pick: (sessions) => sessions[0] || null, bind: (s) => goTo(store, s.id) }),
      create: async (nav) => { created.push('boot'); nav.apply(() => goTo(store, 'ses_boot')); },
    });
    const click = navigation.begin();
    click.apply(() => goTo(store, 'ses_user'));
    list.reject(new Error('socket closed'));
    assert.equal(await landing, 'moved');
    assert.deepEqual(created, [], 'no session is created over the user\'s selection');
    assert.equal(store.getState().sessionId, 'ses_user');
  }
  // The user's choice has not bound anything yet (New session is being created): same answer.
  {
    const store = createPanelStore();
    const navigation = createNavigation(store);
    const boot = navigation.observe();
    const list = deferred();
    let created = 0;
    const landing = landWithoutTabs(boot, {
      adopt: (nav) => adoptReusableSession(nav, { list: () => list.promise, pick: (sessions) => sessions[0] || null, bind: (s) => goTo(store, s.id) }),
      create: async () => { created += 1; },
    });
    navigation.begin();
    list.resolve([{ id: 'ses_empty' }]);
    assert.equal(await landing, 'moved');
    assert.equal(created, 0);
    assert.equal(store.getState().sessionId, null, 'the reusable session was not adopted over the pending choice');
  }
  // Nobody navigated: an untouched session is adopted; with none (or a failed lookup) one is created.
  {
    const store = createPanelStore();
    const navigation = createNavigation(store);
    const adopt = (sessions, fail = false) => (nav) => adoptReusableSession(nav, {
      list: async () => { if (fail) throw new Error('nope'); return sessions; }, pick: (list) => list[0] || null, bind: (s) => goTo(store, s.id),
    });
    let created = 0;
    const create = async (nav) => { created += 1; nav.apply(() => goTo(store, `ses_new_${created}`)); };
    assert.equal(await landWithoutTabs(navigation.observe(), { adopt: adopt([{ id: 'ses_empty' }]), create }), 'adopted');
    assert.equal(store.getState().sessionId, 'ses_empty');
    assert.equal(await landWithoutTabs(navigation.observe(), { adopt: adopt([]), create }), 'created');
    assert.equal(await landWithoutTabs(navigation.observe(), { adopt: adopt([], true), create }), 'created');
    assert.equal(created, 2);
  }
  const panel = source('ocp-v2-panel.js');
  const boot = panel.slice(panel.indexOf('async function boot() {'), panel.indexOf('function otherWindowTabIds() {'));
  assert.ok(boot.indexOf('const bootNav = _nav.observe();') > 0 && boot.indexOf('const bootNav = _nav.observe();') < boot.indexOf('await api.init();'), 'captured before boot\'s first wait');
  assert.match(boot, /await landWithoutTabs\(bootNav, \{\s+adopt: \(nav\) => adoptEmptySession\(lastProject, nav\),\s+create: \(nav\) => startFreshSession\(\{ cwd: lastProject \|\| undefined, nav \}\),\s+\}\);/);
});

test('V04: the naming dialog is for the session New session created, while it is still what the panel shows', async () => {
  const store = boundStore('ses_a');
  const navigation = createNavigation(store);
  // Created and on screen: the dialog opens (as it always did).
  const nav = navigation.begin();
  nav.apply(() => goTo(store, 'ses_new'));
  const created = { sessionId: 'ses_new', activated: true };
  assert.equal(shouldNameCreatedSession(store, nav, created), true);
  // The user went to another session while the project list was loading.
  const elsewhere = navigation.begin();
  elsewhere.apply(() => goTo(store, 'ses_b'));
  assert.equal(shouldNameCreatedSession(store, nav, created), false);
  // ... or back to the new one by a newer choice: that choice was not "name it".
  navigation.begin().apply(() => goTo(store, 'ses_new'));
  assert.equal(shouldNameCreatedSession(store, nav, created), false);
  // It was kept as a tab (the user had navigated while it was being created).
  const tabbed = navigation.begin();
  assert.equal(shouldNameCreatedSession(store, tabbed, { sessionId: 'ses_t', activated: false }), false);
  // The creation failed: there is no session to name, whoever is on screen.
  const failed = navigation.begin();
  assert.equal(shouldNameCreatedSession(store, failed, null), false);
  assert.equal(shouldNameCreatedSession(store, failed, undefined), false);

  const panel = source('ocp-v2-panel.js');
  const begin = panel.slice(panel.indexOf('function beginNewSession() {'), panel.indexOf('async function startFreshSession('));
  assert.ok(begin.indexOf('const nav = _nav.begin();') < begin.indexOf('startFreshSession({ cwd, nav })'));
  assert.equal(/promptNameNewSession\(created\?\.sessionId \|\| null\)/.test(panel), false, 'no dialog with a null target');
  const dialog = panel.slice(panel.indexOf('function promptNameNewSession('), panel.indexOf('async function startSessionInNewWorktree('));
  assert.match(dialog, /if \(!target\.sessionId \|\| !target\.isCurrent\(\)\) return;/);
  assert.match(dialog, /const nav = \(plan\.worktree \|\| projectChanged\) \? _nav\.begin\(\) : null;/);
});

test('T13 (rest): a creation, a project change and a stop take an intent, and the newer choice stands', async () => {
  const store = boundStore('ses_a');
  const navigation = createNavigation(store);
  // New session, then (before it exists) New session again or a tab click that has not bound yet.
  const first = navigation.begin();
  const create = deferred();
  const made = createSessionForNavigation(store, { sessionCreate: () => create.promise }, { cwd: '/proj', nav: first });
  navigation.begin();                           // a newer choice, nothing bound yet
  create.resolve(ok({ id: 'ses_first' }));
  assert.deepEqual(await made, { session: { id: 'ses_first' }, activate: false }, 'kept as a tab');
  // A project change that stops the running turn first.
  store.setRunning(true);
  const project = navigation.begin();
  const abort = deferred();
  const stopping = stopForNavigation(store, { abort: () => abort.promise }, project);
  navigation.begin();
  abort.resolve(ok(true));
  assert.equal(await stopping, false, 'the project change no longer owns the panel');
  // The latest one goes through.
  const latest = navigation.begin();
  assert.equal((await createSessionForNavigation(store, { sessionCreate: async () => ok({ id: 'ses_latest' }) }, { nav: latest })).activate, true);
});

test('V03: a recovery clears the errors of the binding it started on, never those of the session the user went to', () => {
  // The user switched while the recovery was out.
  const store = boundStore('ses_a');
  store.pushError({ message: 'websocket closed' });
  const sweep = recoveredErrorSweep(store);
  store.clearMessages();                         // what the switch does
  goTo(store, 'ses_b');
  store.pushError({ message: 'Rename failed' });
  assert.equal(sweep.clear(), false);
  assert.deepEqual(store.getState().errors.map((err) => err.message), ['Rename failed'], 'session B keeps its error');
  // A → B → A: the errors on screen are the newer binding's.
  const back = boundStore('ses_a');
  const stale = recoveredErrorSweep(back);
  goTo(back, 'ses_b'); goTo(back, 'ses_a');
  back.pushError({ message: 'newer' });
  assert.equal(stale.clear(), false);
  assert.equal(back.getState().errors.length, 1);
  // Nobody moved: the errors the recovery started from go, as before; a
  // notice stays, and so does an error that appeared while the recovery was
  // out (review 5, W06: this test used to assert that it was deleted).
  const same = boundStore('ses_a');
  same.pushError({ message: 'websocket closed' });
  same.pushError({ message: 'dropped', notice: true });
  const own = recoveredErrorSweep(same);
  same.pushError({ message: 'request timeout' });
  assert.equal(own.clear(), true);
  assert.deepEqual(same.getState().errors.map((err) => err.message), ['dropped', 'request timeout']);

  const panel = source('ocp-v2-panel.js');
  const heal = panel.slice(panel.indexOf('async function runAutoHeal(reason) {'), panel.indexOf('async function rehydrateActiveSession() {'));
  assert.ok(heal.indexOf('const recovered = recoveredErrorSweep(getDefaultStore());') < heal.indexOf('await connect();'), 'captured before the recovery waits');
  assert.match(heal, /await rehydrateActiveSession\(\);\s+recovered\.clear\(\);/);
  assert.equal(/\bclearErrors\(\);/.test(heal), false, 'no unconditional clear');
});

test('V11: a sign-in page OpenCode could not open belongs to the session and the server that asked', () => {
  let clock = 1_000;
  const failures = createSignInFailures({ now: () => clock, ttlMs: 60_000 });
  // Session A asks to sign in to "linear".
  const attemptA = failures.expect('ses_a', 'linear');
  assert.equal(failures.record({ mcpName: 'linear', url: 'https://linear.app/oauth?state=a' }), 'ses_a');
  const rowsA = [{ name: 'linear', status: 'needs_auth' }, { name: 'github', status: 'connected' }];
  assert.deepEqual(failures.forSession('ses_a', rowsA), [{ mcpName: 'linear', url: 'https://linear.app/oauth?state=a' }]);
  // Session B, a sub-agent panel, a session with a server of the same name: nothing.
  assert.deepEqual(failures.forSession('ses_b', rowsA), []);
  assert.deepEqual(failures.forSession('ses_child', [{ name: 'linear', status: 'needs_auth' }]), []);
  assert.deepEqual(failures.forSession('', rowsA), []);
  // Only next to a server the session lists, and not once it is connected.
  assert.deepEqual(failures.forSession('ses_a', [{ name: 'github', status: 'connected' }]), []);
  assert.deepEqual(failures.forSession('ses_a', [{ name: 'linear', status: 'connected' }]), []);
  // A failure nobody on this page asked for has no owner and is shown nowhere.
  assert.equal(failures.record({ mcpName: 'sentry', url: 'https://sentry.io/x' }), '');
  assert.equal(failures.record({ mcpName: '', url: 'https://x' }), '');
  assert.equal(failures.record({ mcpName: 'linear' }), '');
  // Review 5, W04: an attempt is open while its request is out. A's has ended;
  // B's is the only one open for the name, so the next failure is B's. (This
  // test used to assert "the newest request for a name owns the next failure"
  // with A's still open: with two open, nothing says whose page it is.)
  attemptA.done();
  const attemptB = failures.expect('ses_b', 'linear');
  assert.equal(failures.record({ mcpName: 'linear', url: 'https://linear.app/oauth?state=b' }), 'ses_b');
  assert.deepEqual(failures.forSession('ses_b', rowsA), [{ mcpName: 'linear', url: 'https://linear.app/oauth?state=b' }]);
  // Review 6, N04: this line used to assert that A keeps its link after its
  // request was done ("A keeps its own"). A link lives as long as its attempt.
  assert.deepEqual(failures.forSession('ses_a', rowsA), [], 'A\'s request has ended: its link went with it');
  attemptB.done();
  failures.expect('ses_a', 'linear');
  assert.deepEqual(failures.forSession('ses_a', rowsA), [], 'a new attempt: the old page is no longer offered');
  // An attempt whose request never ends does not stay open for ever.
  clock += 61_000;
  assert.equal(failures.record({ mcpName: 'linear', url: 'https://late' }), '');
  failures.forget('ses_b');
  assert.deepEqual(failures.forSession('ses_b', rowsA), []);

  const status = source('ocp-v2-status.js');
  assert.equal(status.includes('_browserOpenFailed'), false, 'no page-wide link');
  assert.match(status, /const attempt = view\.action !== 'disconnect' \? _signInFailures\.expect\(at\.sessionId, row\.name\) : null;/);
  assert.match(status, /for \(const failed of _signInFailures\.forSession\(at\.sessionId, rows\)\) \{/);
});

test('V12: a list read paints only when it is the newest one, for the filters still on screen', () => {
  const reads = latestFor();
  // A live list is asked, then the archived one; the live answer comes back last.
  const live = reads.begin({ search: '', archived: false });
  const archived = reads.begin({ search: '', archived: true });
  assert.equal(archived({ search: '', archived: true }), true);
  assert.equal(live({ search: '', archived: true }), false, 'overtaken: neither its rows nor its failure are painted');
  assert.equal(live({ search: '', archived: false }), false, 'also when the filters happen to match again');
  // The newest read, but the filters changed and the next read is only scheduled.
  const typed = reads.begin({ search: 'fix', archived: false });
  assert.equal(typed({ search: 'fix', archived: false }), true);
  assert.equal(typed({ search: 'fixt', archived: false }), false);
  assert.equal(typed({ search: 'fix', archived: true }), false);
  reads.cancel();
  assert.equal(typed({ search: 'fix', archived: false }), false);

  const panel = source('ocp-v2-panel.js');
  const body = panel.slice(panel.indexOf('async function refreshSessionMenuBody() {'), panel.indexOf('// Share / export / fork for the session that is open.'));
  assert.match(body, /const asked = _sessionMenuReads\.begin\(\{ search, archived \}\);/);
  assert.match(body, /console\.warn\('\[ocp-v2-panel\] sessionList failed', err\);\s+if \(!fresh\(\)\) return;\s+body\.innerHTML = /, 'a failure is checked like a success');
  assert.match(body, /if \(!fresh\(\)\) return; \/\/ a newer refresh is on its way/);
});

// ═══ Invariant C: the audit table and the code say the same ═════════════════

test('V08: a rename box is taken out once it is answered, also after a rename that worked', async () => {
  const store = boundStore('ses_a', { title: 'Old' });
  const calls = [];
  const box = (value, { fail = false } = {}) => {
    const state = { mounted: true, restored: 0 };
    const finish = renameBox({
      currentTitle: 'Old',
      read: () => value,
      rename: (next) => renameSession(store, { sessionUpdate: async (id, patch) => { calls.push([id, patch.title]); if (fail) throw new Error('socket closed'); return ok({}); } }, next),
      restore: () => { state.mounted = false; state.restored += 1; },
      after: (result) => { state.result = result; },
    });
    return { state, finish };
  };
  // A rename that works: the request goes out, and the box goes.
  const first = box('First name');
  const result = await first.finish(false);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [['ses_a', 'First name']]);
  assert.equal(first.state.mounted, false, 'the label is back: the next Rename opens a fresh box');
  assert.equal(store.getState().sessionInfo.title, 'First name');
  // Enter and then blur: once.
  assert.equal(await first.finish(false), null);
  assert.equal(first.state.restored, 1);
  assert.equal(calls.length, 1);
  // The second rename is a new box, and it works.
  const second = box('Second name');
  await second.finish(false);
  assert.deepEqual(calls[1], ['ses_a', 'Second name']);
  assert.equal(second.state.mounted, false);
  // Cancelled, unchanged, empty, failed: the box goes every time.
  for (const [value, cancel] of [['x', true], ['Old', false], ['   ', false]]) {
    const b = box(value);
    assert.equal(await b.finish(cancel), null);
    assert.equal(b.state.mounted, false);
  }
  assert.equal(calls.length, 2, 'none of those sent anything');
  const failing = box('Third', { fail: true });
  const failed = await failing.finish(false);
  assert.deepEqual([failed.ok, failed.error, failing.state.mounted, failing.state.result === failed], [false, 'socket closed', false, true]);

  // Both panels use it; neither keeps a `finished` flag of its own.
  for (const [file, from, to] of [
    ['ocp-v2-panel.js', 'function beginRenameSession() {', 'async function boot() {'],
    ['ocp-v2-childpanel.js', 'function beginRenameSession() {', 'function destroy() {'],
  ]) {
    const src = source(file);
    const rename = src.slice(src.indexOf(from), src.indexOf(to));
    assert.match(rename, /const finish = renameBox\(\{/, file);
    assert.match(rename, /restore: restoreLabel,/, file);
    assert.equal(/let finished = false;/.test(rename), false, file);
  }
});

test('V10: a binding token is a snapshot all the way down', () => {
  const store = boundStore('ses_a', { title: 'A', directory: '/work/a', share: { url: 'https://s/a' }, time: { created: 1, updated: 2 }, tags: ['x', { deep: true }] });
  store.setModel({ providerID: 'anthropic', modelID: 'claude', options: { thinking: { budget: 1 } } });
  const at = captureBinding(store);
  // The store edits its own objects in place afterwards.
  store.getState().model.modelID = 'other';
  store.getState().model.options.thinking.budget = 99;
  store.getState().sessionInfo.share.url = 'https://s/changed';
  store.getState().sessionInfo.tags[1].deep = false;
  store.setSessionInfo({ id: 'ses_a', title: 'Renamed' });
  assert.deepEqual(at.model, { providerID: 'anthropic', modelID: 'claude', options: { thinking: { budget: 1 } } });
  assert.deepEqual(at.sessionInfo, { id: 'ses_a', title: 'A', directory: '/work/a', share: { url: 'https://s/a' }, time: { created: 1, updated: 2 }, tags: ['x', { deep: true }] });
  // And a continuation cannot change the store through its token.
  for (const value of [at, at.model, at.model.options, at.model.options.thinking, at.sessionInfo, at.sessionInfo.share, at.sessionInfo.time, at.sessionInfo.tags, at.sessionInfo.tags[1]]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => { 'use strict'; at.model.modelID = 'x'; }, TypeError);
  assert.throws(() => { 'use strict'; at.sessionInfo.share.url = 'x'; }, TypeError);
  assert.notEqual(at.model, store.getState().model, 'not the live object');
  // Nothing to copy: null, as before.
  const bare = captureBinding(createPanelStore());
  assert.deepEqual([bare.model, bare.sessionInfo], [null, null]);
  // A turn token keeps the snapshot.
  const turn = beginTurn(store, at);
  assert.equal(Object.isFrozen(turn), true);
  assert.deepEqual(turn.model, at.model);
});

test('V13: a permission reply and a skipped question say `moved` when the panel left while they were out', async () => {
  const isDescendant = async () => false;
  for (const move of [(s) => goTo(s, 'ses_b'), (s) => { goTo(s, 'ses_b'); goTo(s, 'ses_a'); }]) {
    // The reply was sent to its verified owner, and stands; its result is nobody's to show.
    const store = boundStore('ses_a');
    store.addPendingPermission({ id: 'per_1', sessionID: 'ses_a' });
    const reply = deferred();
    const sent = [];
    const pending = replyToPermission(store, { permissionReply: (args) => { sent.push(args); return reply.promise; } }, { id: 'per_1', sessionID: 'ses_a' }, 'once', { isDescendant });
    await tick();
    assert.equal(sent.length, 1);
    move(store);
    reply.resolve(ok(true));
    assert.deepEqual(await pending, { ok: false, moved: true });
    // The same for a failure: no banner in the session on screen.
    const failing = boundStore('ses_a');
    const failure = deferred();
    const failed = replyToPermission(failing, { permissionReply: () => failure.promise }, { id: 'per_2', sessionID: 'ses_a' }, 'reject', { isDescendant });
    await tick();
    move(failing);
    failure.resolve({ ok: false, error: 'gone' });
    assert.deepEqual(await failed, { ok: false, moved: true });

    // Skip on a queued question.
    const asking = boundStore('ses_a');
    const reject = deferred();
    const rejected = [];
    const skipping = skipQuestion(asking, { questionReject: (args) => { rejected.push(args); return reject.promise; } }, { id: 'que_1', sessionID: 'ses_a' }, { isDescendant });
    await tick();
    assert.deepEqual(rejected, [{ requestId: 'que_1', sessionId: 'ses_a' }]);
    move(asking);
    reject.resolve(ok(true));
    assert.deepEqual(await skipping, { ok: false, moved: true });
    // Skip on a transcript card (it stops the turn of the card's owner).
    const card = boundStore('ses_a');
    const abort = deferred();
    const aborted = [];
    const stopping = skipQuestion(card, { abort: (id) => { aborted.push(id); return abort.promise; } }, { id: 'call_q', sessionID: 'ses_a', _viaToolPart: true, _binding: card.getBinding() }, { isDescendant });
    await tick();
    assert.deepEqual(aborted, ['ses_a']);
    move(card);
    abort.resolve(ok(true));
    assert.deepEqual(await stopping, { ok: false, moved: true });
  }
  // Nobody moved: the results are what they were.
  const store = boundStore('ses_a');
  assert.deepEqual(await replyToPermission(store, { permissionReply: async () => ok(true) }, { id: 'per_1', sessionID: 'ses_a' }, 'once', { isDescendant }), { ok: true });
  assert.deepEqual(await replyToPermission(store, { permissionReply: async () => ({ ok: false, error: 'no' }) }, { id: 'per_1', sessionID: 'ses_a' }, 'once', { isDescendant }), { ok: false, error: 'no' });
  assert.deepEqual(await skipQuestion(store, { questionReject: async () => ok(true) }, { id: 'que_1', sessionID: 'ses_a' }, { isDescendant }), { ok: true });
  assert.deepEqual(await skipQuestion(store, { abort: async () => ok(true) }, { id: 'c', sessionID: 'ses_a', _viaToolPart: true, _binding: store.getBinding() }, { isDescendant }), { ok: true });
});

test('the flows review 4 found missing from the audit table are guarded', () => {
  const plan = source('ocp-v2-plan.js');
  // dispatchPostPlanAction: its late error is for the binding it was started on.
  const shim = plan.slice(plan.indexOf('export function dispatchPostPlanAction(action) {'), plan.indexOf('function syncMessages('));
  assert.match(shim, /const at = captureBinding\(first\);\s+handlePostPlanAction\(action, first\)\.catch\(\(err\) => \{\s+if \(at\.isCurrent\(\)\) first\.pushError\(/);
  // The plan editor's events are applied to their owner only; one without an owner to nobody.
  assert.match(plan, /const ownsEditorEvent = \(state, tabId\) => !!tabId && !!state\.sessionId && tabId === state\.sessionId;/);
  assert.equal((plan.match(/if \(!ownsEditorEvent\(s, tabId\)\) continue;/g) || []).length, 2);
  assert.equal(/if \(tabId && tabId !== s\.sessionId\) continue;/.test(plan), false);

  const panel = source('ocp-v2-panel.js');
  // Copy share link: a failed copy is reported in the session whose link it was.
  assert.match(panel, /const at = captureBinding\(getDefaultStore\(\)\);\s+try \{ await navigator\.clipboard\.writeText\(share\.url\); \} catch \(err\) \{\s+if \(at\.isCurrent\(\)\) pushError\(/);
  // Worktree Remove: the list is re-read only for the dialog and the project it was clicked in.
  assert.match(panel, /if \(done \|\| projectSel\?\.value !== path\) return;\s+refreshWorktrees\(path\);/);
  // The pickers that load before they open.
  const bar = source('ocp-v2-projectbar.js');
  assert.equal((bar.match(/const wanted = _menuOpenings\.begin\(\);/g) || []).length, 4, 'project, branch, tool profile, recall');
  assert.match(bar, /try \{ await _ctx\.ensureProjectsLoaded\?\.\(\); \} catch \{\}\s+if \(!wanted\(\)\) return;\s+paintProjectMenu\(\);/);
  assert.match(bar, /if \(!wanted\(\) \|\| getState\(\)\.running\) return;\s+paintProfileMenu\(\);/);
  assert.match(bar, /if \(!wanted\(\)\) return;\s+paintRecallMenu\(\);/);
  assert.match(bar, /if \(!except\) _menuOpenings\.cancel\(\);/);
  // Fork is a navigation with an intent of its own, from every entry point.
  assert.equal((panel.match(/const nav = _nav\.begin\(\);\s+const result = (?:failIfRefused|report)\(await forkSession\(getDefaultStore\(\), api\), 'Fork failed'\);\s+if \(result\?\.ok\) await openCreatedSession\(result\.session, \{ activate: !result\.moved, nav \}\);/g) || []).length, 2);
  assert.match(source('ocp-v2-render.js'), /const nav = opts\.onNavigate\?\.\(\);\s+const result = report\(await forkSession\(store, api, msg\.id\), 'Fork failed'\);/);
});

// ── The glue, under the DOM stand-in ────────────────────────────────────────

function runGlue(name) {
  const script = fileURLToPath(new URL(`./${name}`, import.meta.url));
  const env = { ...process.env, SYNABUN_TYPESAFE: 'off' };
  delete env.SYNABUN_ASSISTANT_SESSION;
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 120_000, env });
  const stdout = String(result.stdout || '');
  const output = `${stdout}\n${result.stderr || ''}`;
  assert.equal(result.status, 0, output.slice(-6000));
  assert.match(stdout, /no problems/, output.slice(-6000));
  return stdout;
}

test('V01, V02, V07, V09, V11 and the plan editor: the real composer, plan lifecycle and env popover', () => {
  const stdout = runGlue('opencode-review4-glue.run.mjs');
  assert.ok((stdout.match(/^ok {3}/gm) || []).length >= 12, stdout.slice(-3000));
});

test('V03, V04, V05, V06, V08, V12 and the dropped-prompt notice: the real panel', () => {
  const stdout = runGlue('opencode-review4-panel.run.mjs');
  assert.ok((stdout.match(/^ok {3}/gm) || []).length >= 8, stdout.slice(-3000));
});

// Code review 4 of the OpenCode panel: the composer, the plan lifecycle and the
// env popover, run for real under the DOM stand-in of the smoke run. Started by
// opencode-review4.test.mjs in a child process. A socket stand-in holds every
// answer back until the step has done what the finding is about: switched
// session (several times), let a second turn start, left plan mode.
// Prints one line per step and ends with "no problems" or the list of them.
import { installDom, makeNode } from './opencode-panel-dom.fixtures.mjs';
const { doc, FakeWS } = installDom();
const base = new URL('../public/shared/ocp-v2/', import.meta.url).href;
const problems = [];
process.on('unhandledRejection', (err) => problems.push(`unhandledRejection: ${err?.stack?.split('\n').slice(0, 3).join(' | ') || err}`));
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (err) { problems.push(`${name}: ${err?.stack?.split('\n').slice(0, 4).join(' | ')}`); console.log('FAIL', name, '-', err?.message); } };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const expect = (cond, message) => { if (!cond) throw new Error(message); };
const same = (actual, expected, message) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); };

const state = await import(base + 'ocp-v2-state.js');
const ws = await import(base + 'ocp-v2-ws.js');
const send = await import(base + 'ocp-v2-send.js');
const plan = await import(base + 'ocp-v2-plan.js');
const status = await import(base + 'ocp-v2-status.js');
const shared = await import(base + '../state.js');
const reqMod = await import(new URL('../lib/opencode-v2-ws-requests.js', import.meta.url).href);

// ── The panel under test ────────────────────────────────────────────────────
const store = state.createPanelStore();
const DIRS = { ses_a: '/work/a', ses_b: '/work/b', ses_c: '/work/c' };
// What the panel's switchToSession does to the store.
function goTo(sessionId) {
  store.clearMessages();
  store.setSession(sessionId, sessionId ? { id: sessionId, title: sessionId.toUpperCase(), directory: DIRS[sessionId] } : null);
  if (sessionId) store.setCwd(DIRS[sessionId]);
}
goTo('ses_a');

const panel = makeNode('div'); doc.body.appendChild(panel);
const composeEl = makeNode('div'); panel.appendChild(composeEl);
const envCtl = status.mountEnvironmentPopover(panel, store, { onAttachPath: (path) => composer.appendPath(path) });
const composer = send.mountCompose(composeEl, store, { pickers: false });

const walk = (n, fn) => { fn(n); for (const c of n.children || []) walk(c, fn); };
const find = (root, pred) => { let hit = null; walk(root, (n) => { if (!hit && pred(n)) hit = n; }); return hit; };
const all = (root, pred) => { const out = []; walk(root, (n) => { if (pred(n)) out.push(n); }); return out; };
const hasClass = (n, cls) => String(n.className || '').split(/\s+/).includes(cls);
const textOf = (root) => { const out = []; walk(root, (n) => { if (n.textContent) out.push(String(n.textContent)); if (n.data) out.push(String(n.data)); }); return out.join(' | '); };
const input = find(panel, (n) => n.tagName === 'TEXTAREA');
const key = (k, extra = {}) => input._fire('keydown', { key: k, isTrusted: true, isComposing: false, shiftKey: false, ...extra });
const type = (text) => { input.value = text; input.selectionStart = input.selectionEnd = text.length; input._fire('input', { isTrusted: true }); };
const tray = () => find(panel, (n) => hasClass(n, 'ocpv2-queue-tray'));
const trayTexts = () => all(tray(), (n) => hasClass(n, 'ocpv2-queue-text')).map((n) => String(n.textContent));
const trayHead = () => find(tray(), (n) => /^(Queue paused|Queued)/.test(String(n.textContent)));
const trayButton = (label) => find(tray(), (n) => n.tagName === 'BUTTON' && String(n.textContent) === label);
const IMAGE = { name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' };

// ── The socket stand-in: every request is held until the step answers it ────
const connecting = ws.connect();
const sock = FakeWS.last;
sock.readyState = 1; sock._emit('open');
await connecting;
sock._emit('message', { data: JSON.stringify({ type: 'capabilities', capabilities: reqMod.opencodeV2WsCapabilities() }) });
const requests = [];
const AUTO = {
  'agent:list': [{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }],
  'command:list': [{ name: 'review', description: 'Review the changes' }],
  'session:share:policy': { share: 'manual' }, 'resource:list': [], 'reference:list': [], 'find:symbols': [],
};
const answer = (entry, data, extra = {}) => {
  entry.done = true;
  sock._emit('message', { data: JSON.stringify({ type: `${entry.msg.type}:result`, id: entry.msg.id, status: 200, data, ...extra }) });
};
const emitEvent = (eventType, event) => sock._emit('message', { data: JSON.stringify({ type: 'event', eventType, event }) });
sock.send = function sendRaw(raw) {
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  if (msg.id == null) return;
  const entry = { msg, done: false };
  requests.push(entry);
  if (msg.type in AUTO) setTimeout(() => answer(entry, AUTO[msg.type]), 1);
};
const waiting = (type, pred = () => true) => requests.filter((r) => !r.done && r.msg.type === type && pred(r.msg));
const settle = () => { for (const r of requests) r.done = true; };
async function reset() {
  for (const entry of [...waiting('message:send'), ...waiting('message:abort'), ...waiting('command:run')]) answer(entry, true);
  await tick(10);
  for (const entry of waiting('session:messages')) answer(entry, []);
  await tick(10);
  settle();
  store.setRunning(false);
  goTo(null);
  for (const id of Object.keys(DIRS)) composer.forgetSession(id);
  goTo('ses_a');
  store.setAgent('build');
  store.clearPlanState();
  store.clearErrors();
  for (const err of [...store.getState().errors]) store.dismissError(err.id);
  store.clearAttachedImages(); store.clearPendingPaths();
  input.value = ''; input._fire('input', { isTrusted: true });
  trayButton('Clear')?._fire('click');
  await tick(10);
}
// The slash catalog of every project the steps use (command:list answers itself).
for (const id of Object.keys(DIRS)) { goTo(id); await tick(15); }
goTo('ses_a');
await tick(30);

// ═══ V01: the queue of a session survives the panel leaving it ══════════════
await step('V01 a queue is parked when the panel leaves, kept over several switches, and comes back paused with what it carried', async () => {
  await reset();
  store.setRunning(true);
  type('q one'); key('Enter'); await tick(10);
  store.addAttachedImage(IMAGE);
  store.addPendingPath('/work/a/notes.md');
  composer.restoreMentions([{ token: 'src/run.js', kind: 'file', path: 'src/run.js' }]);
  type('q two @src/run.js'); key('Enter'); await tick(10);
  same(trayTexts(), ['q one', 'q two @src/run.js  +2'], 'two prompts are queued in session A');

  goTo('ses_b');
  await tick(10);
  expect(tray().hidden === true, 'session A\'s queue is on screen in session B');
  store.setRunning(true);
  type('b one'); key('Enter'); await tick(10);
  same(trayTexts(), ['b one'], 'session B has its own queue');
  goTo('ses_c');
  await tick(10);
  expect(tray().hidden === true, 'session C shows a queue');
  await tick(380);
  same(waiting('message:send').length, 0, 'a prompt queued for another session went out in session C');

  goTo('ses_a');
  await tick(10);
  same(trayTexts(), ['q one', 'q two @src/run.js  +2'], 'session A\'s queue did not come back');
  expect(/^Queue paused · 2 waiting/.test(String(trayHead()?.textContent)), 'the restored queue is not paused');
  expect(/2 prompts were waiting in this session's queue when you left it/.test(String(trayHead().title || '')), `the note does not say why: ${trayHead().title}`);
  await tick(380);
  same(waiting('message:send').length, 0, 'a restored prompt went out without the user resuming');

  // Away and back again, twice: still everything, each session its own.
  goTo('ses_b'); await tick(10);
  same(trayTexts(), ['b one'], 'session B\'s queue did not come back');
  goTo('ses_a'); await tick(10);
  goTo('ses_c'); await tick(10);
  goTo('ses_a'); await tick(10);
  same(trayTexts(), ['q one', 'q two @src/run.js  +2'], 'session A\'s queue was lost on a later switch');

  // Resume: they go out, in order, to session A, with their attachments and mention.
  trayButton('Resume')._fire('click');
  await tick(380);
  const [first] = waiting('message:send');
  expect(first, 'Resume did not send the first prompt');
  same([first.msg.sessionId, first.msg.parts.map((p) => p.text || p.type)], ['ses_a', ['q one']], 'the first prompt, to session A');
  answer(first, { info: { id: 'msg_r1', role: 'assistant', sessionID: 'ses_a', time: { created: 1, completed: 2 } }, parts: [] });
  await tick(20);
  for (const entry of waiting('session:messages')) answer(entry, []);
  await tick(420);
  const [second] = waiting('message:send');
  expect(second, 'the second prompt did not follow');
  same(second.msg.sessionId, 'ses_a', 'the second prompt went to session A');
  same(second.msg.parts.map((p) => p.type), ['text', 'file', 'file', 'file'], 'text, the image, the referenced path and the mention');
  same(second.msg.parts[3].url, 'file:///work/a/src/run.js', 'the mention is the file that was picked, in session A\'s project');
});

await step('V01 a prompt that fails while the panel is away comes back in front of the parked queue', async () => {
  await reset();
  type('in flight'); key('Enter'); await tick(20);
  const [sent] = waiting('message:send');
  expect(sent && sent.msg.sessionId === 'ses_a', 'the prompt was not sent to session A');
  type('queued behind'); key('Enter'); await tick(10);
  same(trayTexts(), ['queued behind'], 'the second prompt was queued behind the running turn');
  goTo('ses_b'); await tick(10);
  goTo('ses_c'); await tick(10);
  answer(sent, null, { error: 'provider is down' });
  await tick(40);
  expect(tray().hidden === true, 'session A\'s failed prompt is in session C\'s queue');
  same(store.getState().errors.length, 0, 'session A\'s failure is a banner of session C');
  same(input.value, '', 'session A\'s text was put into session C\'s box');
  goTo('ses_b'); await tick(10);
  expect(tray().hidden === true, 'session B got it');
  goTo('ses_a'); await tick(10);
  same(trayTexts(), ['in flight', 'queued behind'], 'both prompts, the failed one first');
  const note = String(trayHead().title || '');
  expect(/not delivered \(provider is down\)/.test(note) && /A prompt was waiting in this session's queue/.test(note), `the note names both: ${note}`);
});

await step('V01 a failure that arrives when the panel is already back on the session (A → B → A) is in its queue at once', async () => {
  await reset();
  type('boomerang'); key('Enter'); await tick(20);
  const [sent] = waiting('message:send');
  expect(sent, 'not sent');
  goTo('ses_b'); await tick(10);
  goTo('ses_a'); await tick(10);
  expect(tray().hidden === true, 'nothing is parked yet');
  answer(sent, null, { error: 'rate limited' });
  await tick(40);
  same(trayTexts(), ['boomerang'], 'the failed prompt waits, unseen, for the next rebinding');
  expect(/^Queue paused/.test(String(trayHead()?.textContent)), 'held');
  expect(/rate limited/.test(String(trayHead().title || '')), 'with the reason');
  same(input.value, '', 'an older binding\'s failure does not write into the box');
  // It is the session's own prompt again: Resume sends it there.
  trayButton('Resume')._fire('click');
  await tick(380);
  const [again] = waiting('message:send');
  expect(again && again.msg.sessionId === 'ses_a' && again.msg.parts[0].text === 'boomerang', 'Resume did not send it to session A');
});

await step('V01 a session that is closed hands back what was waiting for it, and a notice does not hold the queue', async () => {
  await reset();
  store.setRunning(true);
  type('orphan one'); key('Enter'); await tick(10);
  type('orphan two'); key('Enter'); await tick(10);
  goTo('ses_b'); await tick(10);
  const dropped = composer.forgetSession('ses_a');
  same(dropped.map((item) => item.text), ['orphan one', 'orphan two'], 'the prompts that were dropped with the session');
  same(composer.forgetSession('ses_a'), [], 'once');
  goTo('ses_a'); await tick(10);
  expect(tray().hidden === true, 'a forgotten queue came back');
  // The session on screen is the one that is lost: its visible queue goes with it.
  store.setRunning(true);
  type('still here'); key('Enter'); await tick(10);
  same(composer.forgetSession('ses_a').map((item) => item.text), ['still here'], 'the queue on screen is handed back too');
  expect(tray().hidden === true, 'and is gone from the tray');
  // A notice is not an error of the turn: the queue is not paused by it.
  type('after the notice'); key('Enter'); await tick(10);
  store.pushError({ message: 'A queued prompt was dropped', notice: true });
  expect(/^Queued · 1/.test(String(trayHead()?.textContent)), `a notice paused the queue: ${trayHead()?.textContent}`);
  store.pushError({ message: 'a real error' });
  expect(/^Queue paused/.test(String(trayHead()?.textContent)), 'an error still holds it');
});

// ═══ V02: a slash command that fails after the panel moved ══════════════════
await step('V02 a command that fails after a switch is parked with its attachments and mention, and runs as that command on Resume', async () => {
  await reset();
  store.addAttachedImage(IMAGE);
  store.addPendingPath('/work/a/notes.md');
  composer.restoreMentions([{ token: 'src/run.js', kind: 'file', path: 'src/run.js' }]);
  type('/review the @src/run.js diff'); key('Enter'); await tick(20);
  const [run] = waiting('command:run');
  expect(run, 'the command was not run');
  same([run.msg.sessionId, run.msg.command, run.msg.arguments, run.msg.parts.length], ['ses_a', 'review', 'the @src/run.js diff', 3], 'the command, for session A, with three file parts');
  same([store.getState().attachedImages.length, store.getState().pendingPaths.length], [0, 0], 'the command took the draft\'s attachments');
  goTo('ses_b'); await tick(10);
  answer(run, null, { error: 'model overloaded' });
  await tick(40);
  const s = store.getState();
  same([s.errors.length, s.attachedImages.length, s.pendingPaths.length, input.value], [0, 0, 0, ''], 'nothing of session A\'s command lands in session B');
  expect(tray().hidden === true, 'session B got a queue');

  goTo('ses_a'); await tick(10);
  same(trayTexts(), ['/review the @src/run.js diff  +2'], 'the command is back in its own session, with its two attachments');
  expect(/^Queue paused/.test(String(trayHead()?.textContent)), 'held');
  expect(/model overloaded/.test(String(trayHead().title || '')), 'with the reason');
  await tick(380);
  same([waiting('command:run').length, waiting('message:send').length], [0, 0], 'it ran without the user asking');
  // Sending something else does not release it either: only Resume does.
  type('an unrelated prompt'); key('Enter'); await tick(20);
  const [other] = waiting('message:send');
  expect(other && other.msg.parts[0].text === 'an unrelated prompt', 'the unrelated prompt was not sent');
  answer(other, { info: { id: 'msg_o', role: 'assistant', sessionID: 'ses_a', time: { created: 1, completed: 2 } }, parts: [] });
  await tick(20);
  for (const entry of waiting('session:messages')) answer(entry, []);
  await tick(420);
  same(waiting('command:run').length, 0, 'the parked command ran because something else was sent');
  expect(/^Queue paused/.test(String(trayHead()?.textContent)), 'the parked command is no longer held');
  trayButton('Resume')._fire('click');
  await tick(380);
  same(waiting('message:send').length, 0, 'the command was sent as a prompt');
  const [again] = waiting('command:run');
  expect(again, 'Resume did not run the command');
  same([again.msg.sessionId, again.msg.command, again.msg.arguments], ['ses_a', 'review', 'the @src/run.js diff'], 'the same command, for session A');
  same(again.msg.parts.map((p) => p.url), [IMAGE.dataUrl, 'file:///work/a/notes.md', 'file:///work/a/src/run.js'], 'with the image, the path and the mention it was typed with');
  answer(again, { info: { id: 'msg_c', role: 'assistant', sessionID: 'ses_a' }, parts: [] });
  await tick(20);
  for (const entry of waiting('session:messages')) answer(entry, []);
  await tick(40);
  expect(tray().hidden === true, 'the command stayed in the queue after it ran');
});

await step('V02 a command that fails with nobody moving puts everything back in the draft (as before)', async () => {
  await reset();
  store.addAttachedImage(IMAGE);
  composer.restoreMentions([{ token: 'src/run.js', kind: 'file', path: 'src/run.js' }]);
  type('/review @src/run.js'); key('Enter'); await tick(20);
  const [run] = waiting('command:run');
  expect(run, 'not run');
  answer(run, null, { error: 'nope' });
  await tick(40);
  same([store.getState().errors.map((e) => e.message), store.getState().attachedImages.length, input.value], [['nope'], 1, '/review @src/run.js'], 'banner, attachment and text are back');
  expect(tray().hidden === true, 'nothing is parked on the binding it failed on');
  store.dismissError(store.getState().errors[0].id);
  key('Enter'); await tick(20);
  const [again] = waiting('command:run');
  same(again.msg.parts.map((p) => p.url), [IMAGE.dataUrl, 'file:///work/a/src/run.js'], 'the retry carries the image and the mention again');
});

// ═══ V09: a failed prompt keeps its picked mentions ═════════════════════════
await step('V09 a prompt that fails with nobody moving gets its picked symbol and resource mentions back, and resends them', async () => {
  await reset();
  composer.restoreMentions([
    { token: 'run', kind: 'symbol', path: '/work/a/src/run.js', name: 'run', range: { start: { line: 2 }, end: { line: 8 } } },
    { token: 'docs:readme', kind: 'resource', uri: 'docs://readme', client: 'docs', label: 'readme' },
  ]);
  type('explain @run with @docs:readme'); key('Enter'); await tick(20);
  const [sent] = waiting('message:send');
  expect(sent, 'not sent');
  const urls = (entry) => entry.msg.parts.filter((p) => p.type === 'file').map((p) => p.url).sort();
  same(urls(sent), ['docs://readme', 'file:///work/a/src/run.js?start=3&end=9'], 'the symbol (with its range) and the resource went out');
  answer(sent, null, { error: 'provider is down' });
  await tick(40);
  same(input.value, 'explain @run with @docs:readme', 'the text is back in the box');
  store.dismissError(store.getState().errors[0].id);
  key('Enter'); await tick(20);
  const [again] = waiting('message:send');
  expect(again, 'the restored prompt was not sent');
  same(urls(again), ['docs://readme', 'file:///work/a/src/run.js?start=3&end=9'], 'sending the restored text again left its mentions out');
});

// ═══ V07: two turns of one session overlapping ══════════════════════════════
await step('V07 an older send that completes late does not end the newer turn of the same session', async () => {
  await reset();
  type('turn one'); key('Enter'); await tick(20);
  const [first] = waiting('message:send');
  expect(first, 'turn one was not sent');
  answer(first, { info: { id: 'msg_1', role: 'assistant', sessionID: 'ses_a', time: { created: 1, completed: 2 } }, parts: [] });
  await tick(20);
  const [reading] = waiting('session:messages');
  expect(reading, 'turn one is not reading the transcript');
  // The session goes idle (the event), and the next prompt goes out.
  emitEvent('session.idle', { sessionID: 'ses_a' });
  store.setRunning(false);
  type('turn two'); key('Enter'); await tick(20);
  const [second] = waiting('message:send');
  expect(second && second.msg.parts[0].text === 'turn two', 'turn two was not sent');
  expect(store.getState().running === true, 'turn two is not running');
  // Turn one's transcript read comes back.
  answer(reading, []);
  await tick(40);
  expect(store.getState().running === true, 'turn one\'s completion ended turn two');
  // Turn two ends itself.
  answer(second, { info: { id: 'msg_2', role: 'assistant', sessionID: 'ses_a', time: { created: 3, completed: 4 } }, parts: [] });
  await tick(20);
  for (const entry of waiting('session:messages')) answer(entry, []);
  await tick(40);
  expect(store.getState().running === false, 'turn two did not end');
});

await step('V07 a Stop that comes back late does not end the next prompt, and a late failure of the older turn keeps the newer one running', async () => {
  await reset();
  type('to be stopped'); key('Enter'); await tick(20);
  const [first] = waiting('message:send');
  key('Escape'); key('Escape'); await tick(20);
  const [abort] = waiting('message:abort');
  expect(abort, 'no abort went out');
  store.setRunning(false);                      // session.idle beat the abort's answer
  type('next prompt'); key('Enter'); await tick(20);
  const second = waiting('message:send').find((r) => r.msg.parts[0].text === 'next prompt');
  expect(second && store.getState().running === true, 'the next prompt is not running');
  answer(abort, true);
  await tick(40);
  expect(store.getState().running === true, 'the late Stop ended the next prompt');
  answer(first, null, { error: 'upstream closed the stream' });
  await tick(40);
  expect(store.getState().running === true, 'the older turn\'s failure ended the newer turn');
});

const planTranscript = (sessionID) => [
  { info: { id: `msg_u_${sessionID}`, role: 'user', sessionID, time: { created: 1 } }, parts: [{ id: `p_u_${sessionID}`, messageID: `msg_u_${sessionID}`, sessionID, type: 'text', text: 'plan it' }] },
  { info: { id: `msg_p_${sessionID}`, role: 'assistant', sessionID, time: { created: 2, completed: 3 } }, parts: [
    { id: `p_t_${sessionID}`, messageID: `msg_p_${sessionID}`, sessionID, type: 'text', text: `# Plan of ${sessionID}\n\n- one\n- two\n- three\n\nThis is a long enough plan body to count as a real plan for the lifecycle.` },
  ] },
];
await step('V07 a plan finalization does not complete after the user left plan mode, nor for an older plan turn', async () => {
  await reset();
  store.setAgent('plan');
  store.beginPlanTurn({ sessionId: 'ses_a', startMessageCount: 0 });
  const finalizing = plan.maybeFinalizePlanTurn('test', store, { lenient: true });
  await tick(10);
  const [read] = waiting('session:messages');
  expect(read, 'the transcript was not read');
  store.setMode('build');                       // the user switches to Build while the read is out
  answer(read, planTranscript('ses_a'));
  expect(await finalizing === false, 'the finalization reported a plan');
  same([store.getState().showPostPlanActions, store.getState().planContent], [false, ''], 'PLAN COMPLETE after the user left plan mode');

  // An older turn's finalizer never touches a newer plan turn of the same session.
  await reset();
  store.setAgent('plan');
  const older = store.beginPlanTurn({ sessionId: 'ses_a', startMessageCount: 0 });
  const newer = store.beginPlanTurn({ sessionId: 'ses_a', startMessageCount: 0 });
  expect(await plan.maybeFinalizePlanTurn('send:complete', store, { lenient: true, planTurn: older }) === false, 'the older turn finalized');
  same(waiting('session:messages').length, 0, 'it even read the transcript');
  expect(store.getState().planTurnActive === true && store.getState().planTurnId === newer, 'the newer plan turn was touched');
  // Its own finalizer still works.
  const own = plan.maybeFinalizePlanTurn('send:complete', store, { lenient: true, planTurn: newer });
  await tick(10);
  answer(waiting('session:messages')[0], planTranscript('ses_a'));
  expect(await own === true, 'the plan turn\'s own finalization failed');
  expect(/Plan of ses_a/.test(store.getState().planContent), 'no plan');
});

await step('V07 through the composer: plan turn one\'s late completion does not finalize or end plan turn two', async () => {
  await reset();
  store.setAgent('plan');
  type('plan one'); key('Enter'); await tick(20);
  const [first] = waiting('message:send');
  expect(first && first.msg.mode === 'plan', 'plan turn one was not sent');
  const firstPlanTurn = store.getState().planTurnId;
  answer(first, { info: { id: 'msg_p1', role: 'assistant', sessionID: 'ses_a', time: { created: 1, completed: 2 } }, parts: [] });
  await tick(20);
  const reading = waiting('session:messages')[0];
  expect(reading, 'turn one is not reading its transcript');
  // The user stops waiting, clears the plan and sends the next plan prompt.
  store.clearPlanState({ preserveMode: true });
  store.setRunning(false);
  type('plan two'); key('Enter'); await tick(20);
  const second = waiting('message:send').find((r) => r.msg.parts[0].text === 'plan two');
  expect(second, 'plan turn two was not sent');
  const secondPlanTurn = store.getState().planTurnId;
  expect(secondPlanTurn && secondPlanTurn !== firstPlanTurn, 'the second plan turn has no identity of its own');
  // Turn one's read returns, with turn one's plan in it.
  for (const entry of waiting('session:messages')) answer(entry, planTranscript('ses_a'));
  await tick(60);
  for (const entry of waiting('session:messages')) answer(entry, planTranscript('ses_a'));
  await tick(40);
  const s = store.getState();
  same([s.showPostPlanActions, s.planTurnActive, s.planTurnId, s.running], [false, true, secondPlanTurn, true], 'plan turn two was finalized or ended by turn one');
});

// ═══ V11: a sign-in page that could not be opened ═══════════════════════════
await step('V11 a failed sign-in URL is shown in the popover of the session that asked, and in no other', async () => {
  await reset();
  // (It has no button of its own: it opens through its controller, as "Manage" does.)
  const envBtn = { _fire: () => envCtl.toggle() };
  const pop = find(panel, (n) => hasClass(n, 'ocpv2-env-popover'));
  const answerStatus = async (sessionId, rows) => {
    await tick(10);
    for (const entry of waiting('mcp:status', (m) => m.sessionId === sessionId)) answer(entry, rows);
    for (const entry of waiting('env:status')) answer(entry, { lsp: [], formatter: [], references: [] });
    await tick(20);
  };
  const ROWS = [{ name: 'linear', status: 'needs_auth' }];
  // The stand-in does not empty a node on `textContent = ''` as a browser
  // does: what an earlier paint left is taken out by hand before each repaint.
  const wipe = () => { pop.children.length = 0; pop.childNodes.length = 0; };
  envBtn._fire('click');
  await answerStatus('ses_a', ROWS);
  const signIn = find(pop, (n) => n.tagName === 'BUTTON' && hasClass(n, 'ocpv2-permission-link') && !/server|Providers/.test(String(n.textContent)));
  expect(signIn, `no sign-in action on the row: ${textOf(pop)}`);
  wipe();
  signIn._fire('click');
  await tick(10);
  expect(waiting('mcp:authenticate', (m) => m.sessionId === 'ses_a' && m.name === 'linear').length === 1, 'the sign-in request did not go out for session A');
  wipe();
  emitEvent('mcp.browser.open.failed', { mcpName: 'linear', url: 'https://linear.app/oauth?state=a' });
  await answerStatus('ses_a', ROWS);
  expect(/Open this page to sign in to linear/.test(textOf(pop)), `session A does not offer its own sign-in page: ${textOf(pop)}`);

  // Another session with a server of the same name: nothing.
  wipe();
  goTo('ses_b');
  await answerStatus('ses_b', ROWS);
  expect(/linear/.test(textOf(pop)), 'session B\'s popover was not painted');
  expect(!/Open this page to sign in/.test(textOf(pop)), 'session A\'s sign-in URL is offered in session B\'s popover');
  // A failure nobody here asked for (another window) is shown nowhere.
  wipe();
  emitEvent('mcp.browser.open.failed', { mcpName: 'github', url: 'https://github.com/login/oauth' });
  store.setServerStatus({ status: 'ready' });        // (an unowned failure repaints nothing by itself)
  await answerStatus('ses_b', [...ROWS, { name: 'github', status: 'needs_auth' }]);
  expect(!/Open this page to sign in/.test(textOf(pop)), 'an unowned sign-in URL is offered');
  // Back on A: its own page is still there.
  wipe();
  goTo('ses_a');
  await answerStatus('ses_a', ROWS);
  expect(/Open this page to sign in to linear/.test(textOf(pop)), 'session A lost its sign-in page');
  envBtn._fire('click');
});

// ═══ The plan editor's events ═══════════════════════════════════════════════
await step('a plan-editor event is applied to the session it names, and one that names none to nobody', async () => {
  await reset();
  store.completePlanTurn({ content: '# Plan of A\n\n- a' });
  shared.emit('plan-saved', { content: '# edited by nobody', source: 'opencode' });
  same(store.getState().editedPlanContent, '', 'an event with no owner was applied');
  shared.emit('plan-saved', { content: '# edited for B', source: 'opencode', tabId: 'ses_b' });
  same(store.getState().editedPlanContent, '', 'session B\'s edit was applied to session A');
  store.setPostPlanActions(false);
  shared.emit('plan-edit-cancelled', { source: 'opencode' });
  same(store.getState().showPostPlanActions, false, 'a cancel with no owner brought the card back');
  shared.emit('plan-edit-cancelled', { source: 'opencode', tabId: 'ses_a' });
  same(store.getState().showPostPlanActions, true, 'its own cancel does not bring the card back');
  shared.emit('plan-saved', { content: '# edited for A', source: 'opencode', tabId: 'ses_a', filePath: '/plans/a.md' });
  same([store.getState().editedPlanContent, store.getState().planFilePath], ['# edited for A', '/plans/a.md'], 'its own edit was not applied');
});

settle();
console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.join('\n') : '\nno problems');
process.exit(0);

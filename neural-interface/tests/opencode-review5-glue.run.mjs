// Release-gate review 5 of the OpenCode panel: the composer, the plan
// lifecycle, the env popover and the permission card, run for real under the
// DOM stand-in of the smoke run. Started by opencode-review5.test.mjs in a
// child process. A socket stand-in holds every answer back until the step has
// done what the finding is about. None of the steps needs a session switch to
// show its defect except where the finding is about two sessions (W04).
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
const render = await import(base + 'ocp-v2-render.js');
const logic = await import(base + 'ocp-v2-composer-logic.js');
const reqMod = await import(new URL('../lib/opencode-v2-ws-requests.js', import.meta.url).href);

// ── The panel under test ────────────────────────────────────────────────────
const store = state.createPanelStore();
// What the panel's switchToSession does to the store. One project for all.
function goTo(sessionId) {
  store.clearMessages();
  store.setSession(sessionId, sessionId ? { id: sessionId, title: sessionId.toUpperCase(), directory: '/work/a' } : null);
  if (sessionId) store.setCwd('/work/a');
}
goTo('ses_a');

const panel = makeNode('div'); doc.body.appendChild(panel);
const messages = makeNode('div'); panel.appendChild(messages);
const composeEl = makeNode('div'); panel.appendChild(composeEl);
const envCtl = status.mountEnvironmentPopover(panel, store, { onAttachPath: (path) => composer.appendPath(path) });
render.mountRenderer(messages, store, { onOpenSession() {}, onComposeText() {}, onSendText: async () => true, onOpenChild() {} });
const composer = send.mountCompose(composeEl, store, { pickers: false });

const walk = (n, fn) => { fn(n); for (const c of n.children || []) walk(c, fn); };
const find = (root, pred) => { let hit = null; walk(root, (n) => { if (!hit && pred(n)) hit = n; }); return hit; };
const all = (root, pred) => { const out = []; walk(root, (n) => { if (pred(n)) out.push(n); }); return out; };
const hasClass = (n, cls) => String(n.className || '').split(/\s+/).includes(cls);
const textOf = (root) => { const out = []; walk(root, (n) => { if (n.textContent) out.push(String(n.textContent)); if (n.data) out.push(String(n.data)); }); return out.join(' | '); };
const input = find(composeEl, (n) => n.tagName === 'TEXTAREA');
const key = (k, extra = {}) => input._fire('keydown', { key: k, isTrusted: true, isComposing: false, shiftKey: false, ...extra });
const type = (text) => { input.value = text; input.selectionStart = input.selectionEnd = text.length; input._fire('input', { isTrusted: true }); };
const tray = () => find(panel, (n) => hasClass(n, 'ocpv2-queue-tray'));
const trayTexts = () => all(tray(), (n) => hasClass(n, 'ocpv2-queue-text')).map((n) => String(n.textContent));
const trayButton = (label) => find(tray(), (n) => n.tagName === 'BUTTON' && String(n.textContent) === label);
const errors = () => store.getState().errors.map((err) => err.message);
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
const forgotten = new Set(['ses_a', 'ses_b', 'ses_c']);
async function reset() {
  for (const entry of [...waiting('message:send'), ...waiting('message:abort'), ...waiting('command:run'), ...waiting('mcp:authenticate'), ...waiting('mcp:connect')]) answer(entry, true);
  await tick(10);
  for (const entry of waiting('session:messages')) answer(entry, []);
  await tick(10);
  settle();
  store.setRunning(false);
  goTo(null);
  for (const id of forgotten) composer.forgetSession(id);
  goTo('ses_a');
  store.setAgent('build');
  store.clearPlanState();
  for (const err of [...store.getState().errors]) store.dismissError(err.id);
  store.clearAttachedImages(); store.clearPendingPaths();
  input.value = ''; input._fire('input', { isTrusted: true });
  trayButton('Clear')?._fire('click');
  await tick(10);
}
goTo('ses_a');
await tick(30);

const planTranscript = (sessionID, label = sessionID) => [
  { info: { id: `msg_u_${label}`, role: 'user', sessionID, time: { created: 1 } }, parts: [{ id: `p_u_${label}`, messageID: `msg_u_${label}`, sessionID, type: 'text', text: 'plan it' }] },
  { info: { id: `msg_p_${label}`, role: 'assistant', sessionID, time: { created: 2, completed: 3 } }, parts: [
    { id: `p_t_${label}`, messageID: `msg_p_${label}`, sessionID, type: 'text', text: `# Plan of ${label}\n\n- one\n- two\n- three\n\nThis is a long enough plan body to count as a real plan for the lifecycle.` },
  ] },
];

// ═══ W03: the finalization lock ═════════════════════════════════════════════
await step('W03 plan two completes while plan one\'s transcript read is still out, with no session switch', async () => {
  await reset();
  store.setAgent('plan');
  const one = store.beginPlanTurn({ sessionId: 'ses_a', startMessageCount: 0 });
  const first = plan.maybeFinalizePlanTurn('send:complete', store, { lenient: true, planTurn: one });
  await tick(10);
  const [heldRead] = waiting('session:messages');
  expect(heldRead, 'plan one is not reading its transcript');
  // Plan one is abandoned and plan two starts and finishes, on the same session.
  const two = store.beginPlanTurn({ sessionId: 'ses_a', startMessageCount: 0 });
  expect(two && two !== one, 'plan two has no identity of its own');
  const second = plan.maybeFinalizePlanTurn('session.idle', store, { lenient: true, planTurn: two });
  await tick(10);
  const ownRead = waiting('session:messages').find((r) => r !== heldRead);
  expect(ownRead, 'plan two\'s finalizer was turned away by plan one\'s lock: nothing reads its transcript');
  answer(ownRead, planTranscript('ses_a', 'two'));
  expect(await second === true, 'plan two was not finalized');
  let s = store.getState();
  same([s.planTurnActive, s.showPostPlanActions, /Plan of two/.test(s.planContent)], [false, true, true], 'plan two has no PLAN COMPLETE card');
  // Plan one's read comes back: it rejects itself and changes nothing.
  answer(heldRead, planTranscript('ses_a', 'one'));
  expect(await first === false, 'plan one finalized something');
  s = store.getState();
  same([s.planTurnActive, s.showPostPlanActions, /Plan of two/.test(s.planContent)], [false, true, true], 'plan one\'s late read touched plan two\'s card');
  same(waiting('session:messages').length, 0, 'a read was left out');
});

await step('W03 a finalizer that is turned away while its own turn is being read runs when that read is back', async () => {
  await reset();
  store.setAgent('plan');
  const turn = store.beginPlanTurn({ sessionId: 'ses_a', startMessageCount: 0 });
  const first = plan.maybeFinalizePlanTurn('send:complete', store, { lenient: true, planTurn: turn });
  await tick(10);
  const [early] = waiting('session:messages');
  expect(early, 'no read');
  // The idle event arrives while that read is out: its finalizer is turned away.
  expect(await plan.maybeFinalizePlanTurn('session.idle', store, { lenient: true, planTurn: turn }) === false, 'the second finalizer was not turned away');
  same(waiting('session:messages').length, 1, 'two reads of one plan turn at once');
  // The first read was taken before the plan was in the transcript.
  answer(early, []);
  await tick(20);
  const [again] = waiting('session:messages');
  expect(again, 'the turned-away finalizer was lost: nobody reads the transcript again, and the plan turn stays open for ever');
  answer(again, planTranscript('ses_a'));
  expect(await first === true, 'the retried finalization did not complete the plan');
  const s = store.getState();
  same([s.planTurnActive, s.showPostPlanActions], [false, true], 'no PLAN COMPLETE card');
  // A read that completes the plan is not followed by another one.
  await reset();
  store.setAgent('plan');
  const next = store.beginPlanTurn({ sessionId: 'ses_a', startMessageCount: 0 });
  const done = plan.maybeFinalizePlanTurn('send:complete', store, { lenient: true, planTurn: next });
  await tick(10);
  await plan.maybeFinalizePlanTurn('session.idle', store, { lenient: true, planTurn: next });
  answer(waiting('session:messages')[0], planTranscript('ses_a'));
  expect(await done === true, 'not completed');
  await tick(20);
  same(waiting('session:messages').length, 0, 'a completed plan was read again');
  // Prose questions are said once, not once per read.
  await reset();
  store.setAgent('plan');
  const asking = store.beginPlanTurn({ sessionId: 'ses_a', startMessageCount: 0 });
  const prose = [{ info: { id: 'msg_q', role: 'assistant', sessionID: 'ses_a', time: { created: 2, completed: 3 } }, parts: [{ id: 'p_q', messageID: 'msg_q', sessionID: 'ses_a', type: 'text', text: 'Before I plan this I need to know two things.\n\nWhich database do you use?\nAnd which branch should this go to?' }] }];
  const asked = plan.maybeFinalizePlanTurn('send:complete', store, { lenient: true, planTurn: asking });
  await tick(10);
  await plan.maybeFinalizePlanTurn('session.idle', store, { lenient: true, planTurn: asking });
  answer(waiting('session:messages')[0], prose);
  await tick(20);
  for (const entry of waiting('session:messages')) answer(entry, prose);
  expect(await asked === false, 'prose questions completed a plan');
  same(errors().filter((m) => /clarification questions in prose/.test(m)).length, 1, 'the prose-question banner was not shown exactly once');
});

// ═══ W01: the parking never evicts ══════════════════════════════════════════
await step('W01 with prompts waiting in as many sessions as the parking takes, one more queue is refused and nothing is evicted', async () => {
  await reset();
  const max = logic.PARKED_SESSIONS_MAX;
  for (let i = 0; i < max; i += 1) {
    const id = `ses_p${i}`;
    forgotten.add(id);
    goTo(id);
    store.setRunning(true);
    if (i === 0) store.addAttachedImage(IMAGE);
    type(`waiting in ${i}`); key('Enter');
    await tick(2);
  }
  goTo('ses_a');
  await tick(10);
  // Session A: a turn is running, and the user queues a prompt with an attachment.
  store.setRunning(true);
  store.addAttachedImage(IMAGE);
  type('one too many'); key('Enter');
  await tick(10);
  same(errors(), [logic.parkingFullNotice()], 'the refusal was not said');
  same([input.value, store.getState().attachedImages.length], ['one too many', 1], 'the refused prompt was taken out of the box or the strip');
  expect(tray().hidden === true, 'the refused prompt was queued anyway');
  // Nothing fell out to make room: the first session still has its prompt, whole.
  goTo('ses_p0');
  await tick(10);
  same(trayTexts(), ['waiting in 0  +1'], 'the oldest session lost its queued prompt');
  // The user clears that queue: there is room for one more now.
  trayButton('Clear')._fire('click');
  for (const err of [...store.getState().errors]) store.dismissError(err.id);
  goTo('ses_a');
  await tick(10);
  store.setRunning(true);
  key('Enter');
  await tick(10);
  same([errors(), trayTexts(), input.value], [[], ['one too many  +1'], ''], 'the prompt could not be queued once there was room');
});

await step('W01 a prompt that fails for a session that was lost is named in a notice; for a tab the user closed it is not', async () => {
  await reset();
  type('in flight when it was lost'); key('Enter'); await tick(20);
  const [lostSend] = waiting('message:send');
  expect(lostSend, 'the prompt was not sent');
  same(composer.waitingFor('ses_a'), [], 'a prompt that is on its way is not "waiting"');
  goTo('ses_b'); await tick(10);
  same(composer.forgetSession('ses_a', { lost: true }), [], 'nothing was waiting');
  answer(lostSend, null, { status: 500, error: 'provider is down' });
  await tick(30);
  const notices = store.getState().errors.filter((err) => err.notice).map((err) => err.message);
  same(notices.length, 1, `one notice: ${errors()}`);
  expect(/^Not sent: “in flight when it was lost” was waiting for “.+”, and that session is gone\. It is kept here/.test(notices[0]), `the notice names the prompt: ${notices[0]}`);
  goTo('ses_a'); await tick(10);
  expect(tray().hidden === true, 'the prompt was parked for a session that is gone');

  // The session on screen is lost (a recovery found it gone), and a prompt is
  // queued in it before the replacement is bound: it is named, not parked.
  await reset();
  same(composer.forgetSession('ses_a', { lost: true }), [], 'nothing was waiting');
  store.setRunning(true);
  type('typed after it was lost'); key('Enter'); await tick(10);
  same(trayTexts(), ['typed after it was lost'], 'setup: queued in the lost session');
  goTo('ses_b'); await tick(10);
  const late = store.getState().errors.filter((err) => err.notice).map((err) => err.message);
  same(late.length, 1, `one notice for the queue of the lost session: ${errors()}`);
  expect(/^Not sent: “typed after it was lost” was waiting for /.test(late[0]), `the notice names the prompt: ${late[0]}`);
  for (const err of [...store.getState().errors]) store.dismissError(err.id);
  goTo('ses_a'); await tick(10);                   // (bound again: it exists)
  expect(tray().hidden === true, 'the queue was parked for a session that was gone');

  // The user closed the tab (they were asked about what was waiting): quiet.
  await reset();
  goTo('ses_c'); await tick(10);
  store.setRunning(true);
  type('queued in c'); key('Enter'); await tick(10);
  same(composer.waitingFor('ses_c').map((item) => item.text), ['queued in c'], 'the queue on screen is what is waiting');
  store.setRunning(false);
  goTo('ses_b'); await tick(10);
  same(composer.waitingFor('ses_c').map((item) => item.text), ['queued in c'], 'the parked queue is what is waiting');
  expect(tray().hidden === true, 'asking took the queue of another session on screen');
  same(composer.forgetSession('ses_c').map((item) => item.text), ['queued in c'], 'closing hands back what went');
  same(composer.waitingFor('ses_c'), [], 'gone after the close');
  same(errors(), [], 'the composer raised a notice for a tab the user closed');
});

// ═══ W02: the reason typed into a permission card ═══════════════════════════
await step('W02 a typed rejection reason is removed when its request is answered elsewhere, and kept while it is open', async () => {
  await reset();
  const PERM = { id: 'per_1', sessionID: 'ses_a', permission: 'bash', patterns: ['rm -rf build'], metadata: {}, always: [] };
  const reasonInput = () => find(messages, (n) => hasClass(n, 'ocpv2-permission-reason-input'));
  const show = async (perm) => { store.addPendingPermission(perm); await tick(40); };
  await show(PERM);
  expect(reasonInput(), 'no reason field on the card');
  reasonInput().value = 'use the staging database instead';
  reasonInput()._fire('input');
  // The card is rebuilt (another request arrives): the reason is still there.
  await show({ ...PERM, id: 'per_2', patterns: ['ls'] });
  same(reasonInput().value, 'use the staging database instead', 'the reason did not survive a rebuild');
  // The panel leaves and comes back; the request is still open.
  goTo('ses_b'); await tick(20);
  goTo('ses_a'); await tick(20);
  await show(PERM);
  same(reasonInput().value, 'use the staging database instead', 'the reason did not survive a switch and back');
  // Another window answers the request while the panel is on session B.
  goTo('ses_b'); await tick(20);
  emitEvent('permission.replied', { sessionID: 'ses_a', requestID: 'per_1', reply: 'reject' });
  await tick(10);
  goTo('ses_a'); await tick(20);
  await show(PERM);                                // (the same id again, only to look at the field)
  same(reasonInput().value, '', 'the reason of a request that was answered elsewhere is still kept');
  // The server's own list no longer has the request (it was answered during an outage).
  reasonInput().value = 'typed again';
  reasonInput()._fire('input');
  store.setPendingPermissions([], { listed: true });
  await tick(20);
  await show(PERM);
  same(reasonInput().value, '', 'a reason outlived the server\'s list of open requests');
  // A local edit of the queue is not a list: the reason stays.
  reasonInput().value = 'still typing';
  reasonInput()._fire('input');
  store.setPendingPermissions([]);
  await tick(20);
  await show(PERM);
  same(reasonInput().value, 'still typing', 'a local queue change dropped the reason of an open request');
  // The session is deleted.
  emitEvent('session.deleted', { info: { id: 'ses_a' } });
  store.setPendingPermissions([]);
  await tick(20);
  await show(PERM);
  same(reasonInput().value, '', 'the reason of a deleted session\'s request is still kept');
  store.setPendingPermissions([]);
});

// ═══ W04: two sessions signing in to a server of the same name ══════════════
await step('W04 with two sign-ins to the same server name out at once, the failed link of one is not shown in the other', async () => {
  await reset();
  const envBtn = { _fire: () => envCtl.toggle() };
  const pop = find(panel, (n) => hasClass(n, 'ocpv2-env-popover'));
  const ROWS = [{ name: 'linear', status: 'needs_auth' }, { name: 'github', status: 'needs_auth' }];
  const answerStatus = async (sessionId) => {
    await tick(10);
    for (const entry of waiting('mcp:status', (m) => m.sessionId === sessionId)) answer(entry, ROWS);
    for (const entry of waiting('env:status')) answer(entry, { lsp: [], formatter: [], references: [] });
    await tick(20);
  };
  // The stand-in does not empty a node on `textContent = ''`: wiped by hand.
  const wipe = () => { pop.children.length = 0; pop.childNodes.length = 0; };
  const signInOf = (name) => {
    const buttons = all(pop, (n) => n.tagName === 'BUTTON' && hasClass(n, 'ocpv2-permission-link') && !/server|Providers/.test(String(n.textContent)));
    return buttons[ROWS.findIndex((row) => row.name === name)];
  };
  const offered = () => /Open this page to sign in/.test(textOf(pop));
  envBtn._fire('click');
  await answerStatus('ses_a');
  expect(signInOf('linear'), `no sign-in action on the row: ${textOf(pop)}`);
  signInOf('linear')._fire('click');
  await tick(10);
  same(waiting('mcp:authenticate', (m) => m.sessionId === 'ses_a' && m.name === 'linear').length, 1, 'session A\'s sign-in did not go out');
  // Session B starts a sign-in to its own "linear" while A's is still out.
  wipe();
  goTo('ses_b');
  await answerStatus('ses_b');
  signInOf('linear')._fire('click');
  await tick(10);
  same(waiting('mcp:authenticate', (m) => m.sessionId === 'ses_b' && m.name === 'linear').length, 1, 'session B\'s sign-in did not go out');
  // A's browser page could not be opened. The event does not say whose it is.
  wipe();
  emitEvent('mcp.browser.open.failed', { mcpName: 'linear', url: 'https://linear.app/oauth?state=of-a' });
  store.setServerStatus({ status: 'ready' });      // (repaint)
  await answerStatus('ses_b');
  expect(/linear/.test(textOf(pop)), 'session B\'s popover was not painted');
  expect(!offered(), 'session A\'s sign-in link is offered in session B\'s popover');
  wipe();
  goTo('ses_a');
  await answerStatus('ses_a');
  expect(!offered(), 'a link nobody could attribute is offered in session A');

  // An attempt is retired when its request ends: A connects "github", the
  // request comes back, and a failure for that name seconds later is not A's.
  const github = signInOf('github');
  wipe();
  github._fire('click');
  await tick(10);
  const [connect] = [...waiting('mcp:authenticate', (m) => m.name === 'github'), ...waiting('mcp:connect', (m) => m.name === 'github')];
  expect(connect, 'the github request did not go out');
  answer(connect, ROWS);
  await answerStatus('ses_a');
  wipe();
  emitEvent('mcp.browser.open.failed', { mcpName: 'github', url: 'https://github.com/login/oauth?from=elsewhere' });
  store.setServerStatus({ status: 'ready' });
  await answerStatus('ses_a');
  expect(!offered(), 'a failure that arrived after the request had ended was attributed to it');

  // B's request ends: A's "linear" attempt is the only one open, and the next failure is A's.
  for (const entry of waiting('mcp:authenticate', (m) => m.sessionId === 'ses_b')) answer(entry, null, { status: 500, error: 'Authentication did not complete' });
  await tick(20);
  wipe();
  emitEvent('mcp.browser.open.failed', { mcpName: 'linear', url: 'https://linear.app/oauth?state=of-a-again' });
  await answerStatus('ses_a');
  expect(/Open this page to sign in to linear/.test(textOf(pop)), `session A does not get the link of its own, only open, attempt: ${textOf(pop)}`);
  wipe();
  goTo('ses_b');
  await answerStatus('ses_b');
  expect(!offered(), 'session A\'s link is offered in session B');
  envBtn._fire('click');
});

settle();
console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.join('\n') : '\nno problems');
process.exit(0);

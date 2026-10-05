// Final verification 6 of the OpenCode panel: the composer, the plan
// lifecycle, the env popover and the notices, run for real under the DOM
// stand-in of the smoke run. Started by opencode-review6.test.mjs in a child
// process. A socket stand-in holds every answer back until the step has done
// what the finding is about.
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
function goTo(sessionId, target = store) {
  target.clearMessages();
  target.setSession(sessionId, sessionId ? { id: sessionId, title: sessionId.toUpperCase(), directory: '/work/a' } : null);
  if (sessionId) target.setCwd('/work/a');
}
goTo('ses_a');

const panel = makeNode('div'); doc.body.appendChild(panel);
const messages = makeNode('div'); panel.appendChild(messages);
const composeEl = makeNode('div'); panel.appendChild(composeEl);
// The sessions that have a tab, as the panel tells its composer.
const tabs = new Set(['ses_a', 'ses_b', 'ses_c']);
const envCtl = status.mountEnvironmentPopover(panel, store, { onAttachPath: (path) => composer.appendPath(path) });
render.mountRenderer(messages, store, { onOpenSession() {}, onComposeText() {}, onSendText: async () => true, onOpenChild() {} });
const composer = send.mountCompose(composeEl, store, { pickers: false, hasTab: (sessionId) => tabs.has(sessionId) });

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
const trayTitle = () => String(find(tray(), (n) => hasClass(n, 'ocpv2-queue-head'))?.children?.[0]?.textContent || '');
const errors = () => store.getState().errors.map((err) => err.message);
const notices = () => store.getState().errors.filter((err) => err.notice);
const banners = () => all(messages, (n) => hasClass(n, 'ocpv2-error-banner'));
const bannerOf = (text) => banners().find((n) => textOf(n).includes(text));
const bannerButton = (banner, label) => find(banner, (n) => n.tagName === 'BUTTON' && String(n.textContent) === label);
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
const refuse = (entry, error = 'the serve is restarting') => answer(entry, { error }, { status: 500 });
const emitEvent = (eventType, event) => sock._emit('message', { data: JSON.stringify({ type: 'event', eventType, event }) });
sock.send = function sendRaw(raw) {
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  if (msg.id == null) return;
  const entry = { msg, done: false };
  requests.push(entry);
  if (msg.type in AUTO) setTimeout(() => answer(entry, AUTO[msg.type]), 1);
};
const waiting = (type, pred = () => true) => requests.filter((r) => !r.done && r.msg.type === type && pred(r.msg));
const sentOf = (type, pred = () => true) => requests.filter((r) => r.msg.type === type && pred(r.msg));
const settle = () => { for (const r of requests) r.done = true; };
async function reset() {
  for (const entry of [...waiting('message:send'), ...waiting('message:abort'), ...waiting('command:run'), ...waiting('mcp:authenticate'), ...waiting('mcp:connect')]) answer(entry, true);
  await tick(10);
  for (const entry of waiting('session:messages')) answer(entry, []);
  await tick(10);
  settle();
  store.setRunning(false);
  goTo(null);
  tabs.clear(); for (const id of ['ses_a', 'ses_b', 'ses_c']) tabs.add(id);
  for (const id of tabs) composer.forgetSession(id);
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
const RETRY = plan.PLAN_READ_RETRY_MS;
// The next transcript read of the plan lifecycle, once it is out.
async function nextRead(known, waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    const read = waiting('session:messages').find((r) => !known.includes(r));
    if (read) { known.push(read); return read; }
    if (Date.now() > until) return null;
    await tick(20);
  }
}

// ═══ N05: the last transcript read of a plan finalisation fails ═════════════
await step('N05 an idle plan turn whose transcript cannot be read is ended with a failure line after three reads, and the queue goes on Resume', async () => {
  await reset();
  expect(RETRY > 0 && plan.PLAN_READ_ATTEMPTS === 3, 'setup: three attempts with a pause');
  store.setAgent('plan');
  store.setRunning(true);
  const turn = store.beginPlanTurn({ sessionId: 'ses_a', startMessageCount: 0 });
  type('next one'); key('Enter'); await tick(10);
  same(trayTexts(), ['next one'], 'setup: a prompt is queued behind the plan turn');
  // The turn goes idle: the plan is read. Every read comes back as an error.
  const reads = [];
  store.setRunning(false);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const read = await nextRead(reads, RETRY + 600);
    expect(read, `read ${attempt} did not go out`);
    same(waiting('message:send').length, 0, 'the queue drained while the plan turn was being read');
    refuse(read);
  }
  await tick(60);
  expect(!(await nextRead(reads, RETRY + 300)), 'a fourth read went out: the retries are not bounded');
  const s = store.getState();
  same([s.planTurnActive, s.showPostPlanActions, s.planTurnId], [false, false, 0], 'the plan turn is still open (or has a card) after its reads failed');
  same(errors().length, 1, `one failure line: ${errors()}`);
  expect(/^Could not read the plan of this turn from OpenCode \(the serve is restarting\)\. The plan turn has ended without a plan card\./.test(errors()[0]), `the failure line: ${errors()[0]}`);
  expect(!store.getState().errors[0].notice, 'the line is an error: it holds the queue like any failed turn');
  // The queue is no longer behind the plan turn: held by the error, and Resume sends it.
  expect(/^Queue paused · 1 waiting$/.test(trayTitle()), `the tray: ${trayTitle()}`);
  same(waiting('message:send').length, 0, 'the queue went out by itself after a failed turn');
  trayButton('Resume')._fire('click');
  await tick(400);
  const [out] = waiting('message:send');
  expect(out && out.msg.parts?.[0]?.text === 'next one', 'Resume did not send the queued prompt: the queue is still blocked');
});

await step('N05 a read that fails once and then answers completes the plan: nothing is lost to the first failure', async () => {
  await reset();
  store.setAgent('plan');
  store.setRunning(true);
  store.beginPlanTurn({ sessionId: 'ses_a', startMessageCount: 0 });
  const reads = [];
  store.setRunning(false);
  refuse(await nextRead(reads, 400), 'request timeout: session:messages');
  const second = await nextRead(reads, RETRY + 600);
  expect(second, 'the failed read was not asked again');
  answer(second, planTranscript('ses_a', 'retry'));
  await tick(40);
  const s = store.getState();
  // (The stand-in has no plan-file route: that error is not this step's.)
  same([s.planTurnActive, s.showPostPlanActions, /Plan of retry/.test(s.planContent), errors().filter((m) => /read the plan/.test(m))], [false, true, true, []], 'the plan was not completed by the second read');
});

await step('N05 reads that fail while the turn is still running end nothing: the turn\'s own idle event reads again', async () => {
  await reset();
  store.setAgent('plan');
  store.setRunning(true);
  const turn = store.beginPlanTurn({ sessionId: 'ses_a', startMessageCount: 0 });
  // (A sub-agent finished: the parent is still running.)
  const early = plan.maybeFinalizePlanTurn('child:idle', store, { lenient: true, planTurn: turn });
  const reads = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) refuse(await nextRead(reads, RETRY + 600));
  same(await early, false, 'nothing was completed');
  same([store.getState().planTurnActive, store.getState().planTurnId, errors()], [true, turn, []], 'a running plan turn was ended by a failed read');
  store.setRunning(false);
  const late = await nextRead(reads, 400);
  expect(late, 'the idle event did not read the plan');
  answer(late, planTranscript('ses_a', 'late'));
  await tick(40);
  same([store.getState().planTurnActive, store.getState().showPostPlanActions], [false, true], 'the plan turn did not complete on its idle event');
});

await step('N05 a plan turn that was cleared while its reads were failing is not ended twice, and nothing is said', async () => {
  await reset();
  store.setAgent('plan');
  store.setRunning(true);
  store.beginPlanTurn({ sessionId: 'ses_a', startMessageCount: 0 });
  const reads = [];
  store.setRunning(false);
  refuse(await nextRead(reads, 400));
  await tick(100);                                 // (the failed read is in its pause now)
  same(store.getState().planTurnActive, true, 'setup: the plan turn is waiting for its second read');
  // The user starts another plan turn during the pause before the second read.
  store.setRunning(true);
  const two = store.beginPlanTurn({ sessionId: 'ses_a', startMessageCount: 0 });
  await tick(RETRY + 200);
  same(waiting('session:messages').length, 0, 'the older plan turn went on reading after it was over');
  same([store.getState().planTurnActive, store.getState().planTurnId, errors()], [true, two, []], 'the older turn\'s failure touched the newer plan turn');
});

// ═══ N02: a session that goes away by itself keeps its prompts ══════════════
await step('N02 the prompts of a lost session are kept whole, one notice each; Put back restores text, attachment, path and mention, and a send carries them', async () => {
  await reset();
  store.setRunning(true);
  store.addAttachedImage(IMAGE);
  composer.appendPath('/work/a/src');
  composer.restoreMentions([{ kind: 'file', token: 'README.md', path: 'README.md' }]);
  type('look at @README.md'); key('Enter'); await tick(10);
  type('second prompt'); key('Enter'); await tick(10);
  same(trayTexts(), ['look at @README.md  +2', 'second prompt'], 'setup: two prompts queued in A');
  const queuedMention = composer.waitingFor('ses_a')[0].mentions[0];
  expect(queuedMention?.source?.path === '/work/a/README.md', 'setup: the queued prompt carries its mention as a file part');
  store.setRunning(false);
  goTo('ses_b'); await tick(10);
  // OpenCode lost session A (or it was deleted in another window).
  tabs.delete('ses_a');
  composer.forgetSession('ses_a', { lost: true, label: 'Session A' });
  await tick(40);
  same(notices().length, 2, `one notice for each prompt: ${errors()}`);
  same(notices()[0].message, logic.keptPromptNotice({ item: { text: 'look at @README.md', images: [IMAGE], paths: ['/work/a/src'], mentions: [queuedMention] }, label: 'Session A' }), 'the notice');
  expect(/with 2 attachments and 1 mention was waiting for “Session A”/.test(notices()[0].message), `the notice says what it holds: ${notices()[0].message}`);
  same(notices()[0].kept, { text: 'look at @README.md', images: [IMAGE], paths: ['/work/a/src'], mentions: [queuedMention] }, 'the payload is not whole');
  // The notice offers exactly two things, and no anonymous ×.
  const first = bannerOf('look at @README.md');
  expect(first, `the notice is not on screen: ${textOf(messages)}`);
  same(all(first, (n) => n.tagName === 'BUTTON').map((n) => String(n.textContent)), ['Put back', 'Discard'], 'the notice\'s actions');
  // It survives a switch and a recovery's sweep, like every notice.
  store.clearMessages(); store.clearErrors();
  same(notices().length, 2, 'a kept prompt went with a switch or a recovery');
  // The user is writing something in B: the kept prompt goes under it.
  type('half a thought');
  bannerButton(bannerOf('look at @README.md'), 'Put back')._fire('click');
  await tick(40);
  same(input.value, 'half a thought\n\nlook at @README.md', 'the text was not put back under the draft');
  same([store.getState().attachedImages, store.getState().pendingPaths], [[IMAGE], ['/work/a/src']], 'the attachment or the path did not come back');
  same(notices().map((err) => err.kept.text), ['second prompt'], 'the notice of the prompt that was put back is still there');
  // Sent from B, it goes out with everything it had.
  key('Enter'); await tick(20);
  const [out] = waiting('message:send');
  expect(out && out.msg.sessionId === 'ses_b', 'the prompt was not sent in the session on screen');
  const parts = out.msg.parts;
  same(parts[0], { type: 'text', text: 'half a thought\n\nlook at @README.md' }, 'the text part');
  expect(parts.some((p) => p.type === 'file' && p.url === IMAGE.dataUrl), 'the attachment did not go out');
  expect(parts.some((p) => p.type === 'file' && /\/work\/a\/src$/.test(String(p.url)) && !p.source), 'the referenced path did not go out');
  const mention = parts.find((p) => p.source?.type === 'file');
  expect(mention && mention.url === queuedMention.url && mention.source.path === '/work/a/README.md', 'the mention did not go out as the file part it was');
  same(mention.source.text, { value: '@README.md', start: 24, end: 34 }, 'the mention does not say where its token stands now');
  // Discard: the other kept prompt goes, and nothing else changes.
  bannerButton(bannerOf('second prompt'), 'Discard')._fire('click');
  await tick(40);
  same([notices().length, input.value], [0, ''], 'Discard did not just discard');
});

await step('N02 a prompt on its way to a session that is then lost is kept too; with nothing typed, Put back fills the box', async () => {
  await reset();
  store.addAttachedImage(IMAGE);
  type('in flight when it was lost'); key('Enter'); await tick(20);
  const [lostSend] = waiting('message:send');
  expect(lostSend, 'the prompt was not sent');
  goTo('ses_b'); await tick(10);
  tabs.delete('ses_a');
  same(composer.forgetSession('ses_a', { lost: true }), [], 'nothing was waiting');
  same(notices().length, 0, 'a notice for nothing');
  answer(lostSend, null, { status: 500, error: 'provider is down' });
  await tick(40);
  same(notices().map((err) => err.kept), [{ text: 'in flight when it was lost', images: [IMAGE], paths: [], mentions: [] }], 'the failed prompt was not kept whole');
  expect(/^Not sent: “in flight when it was lost” with 1 attachment was waiting for “SES_A”, and that session is gone\./.test(notices()[0].message), `the notice: ${notices()[0].message}`);
  bannerButton(bannerOf('in flight when it was lost'), 'Put back')._fire('click');
  await tick(40);
  same([input.value, store.getState().attachedImages, notices().length], ['in flight when it was lost', [IMAGE], 0], 'Put back into an empty box');

  // A queue typed into the session on screen after it was lost: kept as well.
  await reset();
  tabs.delete('ses_a');
  same(composer.forgetSession('ses_a', { lost: true }), [], 'nothing was waiting');
  store.setRunning(true);
  type('typed after it was lost'); key('Enter'); await tick(10);
  goTo('ses_b'); await tick(10);
  same(notices().map((err) => err.kept.text), ['typed after it was lost'], 'the queue of the lost session was not kept');

  // A tab the user closed while its turn ran: they decided, and nothing is said (as before).
  await reset();
  type('running when its tab was closed'); key('Enter'); await tick(20);
  const [closedSend] = waiting('message:send');
  goTo('ses_b'); await tick(10);
  tabs.delete('ses_a');
  composer.forgetSession('ses_a');
  answer(closedSend, null, { status: 500, error: 'Aborted' });
  await tick(40);
  same(errors(), [], 'a closed tab\'s aborted turn left a notice');
});

// ═══ N06: no tab, no marker ═════════════════════════════════════════════════
await step('N06 a failure that arrives for a session with no tab and no gone marker is kept on a notice, not parked for nobody', async () => {
  await reset();
  type('sent very long ago'); key('Enter'); await tick(20);
  const [lateSend] = waiting('message:send');
  expect(lateSend, 'the prompt was not sent');
  goTo('ses_b'); await tick(10);
  // The tab went long ago and its marker aged out: nothing was "forgotten" here.
  tabs.delete('ses_a');
  answer(lateSend, null, { status: 500, error: 'request timeout' });
  await tick(40);
  same(composer.waitingFor('ses_a'), [], 'the prompt was parked for a session nobody can return to');
  same(notices().map((err) => err.kept.text), ['sent very long ago'], 'the prompt was not kept for the user');
  // With its tab, the same failure is parked for the session, as always.
  await reset();
  type('sent a moment ago'); key('Enter'); await tick(20);
  const [send2] = waiting('message:send');
  goTo('ses_b'); await tick(10);
  answer(send2, null, { status: 500, error: 'request timeout' });
  await tick(40);
  same([composer.waitingFor('ses_a').map((item) => item.text), notices().length], [['sent a moment ago'], 0], 'a session with a tab lost its parking');
});

// ═══ N04: a sign-in link lives as long as its attempt ═══════════════════════
await step('N04 the link goes from the popover when its sign-in request ends, and when another session starts signing in to a same-named server', async () => {
  await reset();
  const envBtn = { _fire: () => envCtl.toggle() };
  const pop = find(panel, (n) => hasClass(n, 'ocpv2-env-popover'));
  const ROWS = [{ name: 'linear', status: 'needs_auth' }, { name: 'github', status: 'needs_auth' }];
  const answerStatus = async (sessionId) => {
    await tick(10);
    const reads = waiting('mcp:status', (m) => m.sessionId === sessionId);
    for (const entry of reads) answer(entry, ROWS);
    for (const entry of waiting('env:status')) answer(entry, { lsp: [], formatter: [], references: [] });
    await tick(20);
    return reads.length;
  };
  // The stand-in does not empty a node on `textContent = ''`: wiped by hand.
  const wipe = (node) => { node.children.length = 0; node.childNodes.length = 0; };
  const signInOf = (root, name) => {
    const buttons = all(root, (n) => n.tagName === 'BUTTON' && hasClass(n, 'ocpv2-permission-link') && !/server|Providers/.test(String(n.textContent)));
    return buttons[ROWS.findIndex((row) => row.name === name)];
  };
  const offered = (root) => /Open this page to sign in/.test(textOf(root));
  envBtn._fire('click');
  await answerStatus('ses_a');
  signInOf(pop, 'linear')._fire('click');
  await tick(10);
  const [signIn] = waiting('mcp:authenticate', (m) => m.sessionId === 'ses_a' && m.name === 'linear');
  expect(signIn, 'session A\'s sign-in did not go out');
  wipe(pop);
  emitEvent('mcp.browser.open.failed', { mcpName: 'linear', url: 'https://linear.app/oauth?state=of-a' });
  await answerStatus('ses_a');
  expect(offered(pop), `setup: the link is offered while the request is out: ${textOf(pop)}`);
  // The request ends (the sign-in was given up): the link goes with it.
  wipe(pop);
  answer(signIn, null, { status: 500, error: 'Authentication did not complete' });
  expect(await answerStatus('ses_a') >= 1, 'the popover was not painted again when the request ended');
  expect(/linear/.test(textOf(pop)) && !offered(pop), `the link of a request that has ended is still offered: ${textOf(pop)}`);
  for (const err of [...store.getState().errors]) store.dismissError(err.id);

  // A second panel (a sub-agent's) on another session, with a server of the same name.
  const storeB = state.createPanelStore();
  goTo('ses_b', storeB);
  const panelB = makeNode('div'); doc.body.appendChild(panelB);
  const mounted = status.mountEnvironmentPopover(panelB, storeB, {});
  const popB = find(panelB, (n) => hasClass(n, 'ocpv2-env-popover'));
  // A signs in again and gets a link.
  wipe(pop);
  signInOf(pop, 'linear')?._fire('click');
  await tick(10);
  if (!waiting('mcp:authenticate', (m) => m.sessionId === 'ses_a').length) {
    // (The rows were wiped with the popover: paint them once more.)
    store.setServerStatus({ status: 'ready' });
    await answerStatus('ses_a');
    signInOf(pop, 'linear')._fire('click');
    await tick(10);
  }
  expect(waiting('mcp:authenticate', (m) => m.sessionId === 'ses_a').length === 1, 'session A\'s second sign-in did not go out');
  wipe(pop);
  emitEvent('mcp.browser.open.failed', { mcpName: 'linear', url: 'https://linear.app/oauth?state=of-a-2' });
  await answerStatus('ses_a');
  expect(offered(pop), 'setup: A has its link again');
  // B starts signing in to its own "linear": nothing says any more whose page a link is.
  mounted.toggle();
  await answerStatus('ses_b');
  wipe(pop);
  signInOf(popB, 'linear')._fire('click');
  await tick(10);
  expect(waiting('mcp:authenticate', (m) => m.sessionId === 'ses_b').length === 1, 'session B\'s sign-in did not go out');
  expect(await answerStatus('ses_a') >= 1, 'session A\'s open popover was not painted again when its link became ambiguous');
  expect(/linear/.test(textOf(pop)) && !offered(pop), `session A still offers a link that is ambiguous now: ${textOf(pop)}`);
  await answerStatus('ses_b');
  expect(!offered(popB), 'session B offers session A\'s link');
  mounted.destroy();
  envBtn._fire('click');
});

settle();
console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.join('\n') : '\nno problems');
process.exit(0);

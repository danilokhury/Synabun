// Code review 3 of the OpenCode panel: the DOM glue with the session switched
// while something is in flight. Run by opencode-review3-flows.test.mjs in a
// child process, under the DOM stand-in of the smoke run. The real modules are
// mounted (composer, plan lifecycle, env popover, changes viewer, @ picker,
// sub-agent manager) against a socket stand-in whose answers are held back
// until the test has moved the panel to another session.
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
const changes = await import(base + 'ocp-v2-changes.js');
const status = await import(base + 'ocp-v2-status.js');
const manager = await import(base + 'ocp-v2-manager.js');
const shared = await import(base + '../state.js');
const reqMod = await import(new URL('../lib/opencode-v2-ws-requests.js', import.meta.url).href);

// ── The panel under test ────────────────────────────────────────────────────
const store = state.createPanelStore();
const DIRS = { ses_a: '/work/a', ses_b: '/work/b' };
// What the panel's switchToSession does to the store.
function goTo(sessionId) {
  store.clearMessages();
  store.setSession(sessionId, sessionId ? { id: sessionId, title: sessionId.toUpperCase(), directory: DIRS[sessionId] } : null);
  if (sessionId) store.setCwd(DIRS[sessionId]);
}
const MOVES = [
  ['to B', () => goTo('ses_b')],
  ['A → B → A', () => { goTo('ses_b'); goTo('ses_a'); }],
];
goTo('ses_a');

const panel = makeNode('div'); doc.body.appendChild(panel);
const composeEl = makeNode('div'); panel.appendChild(composeEl);
const manualSends = [];
const aborts = [];
const envCtl = status.mountEnvironmentPopover(panel, store, { onAttachPath: (path) => composer.appendPath(path) });
changes.mountChangesBar(panel, store);
const composer = send.mountCompose(composeEl, store, {
  pickers: false,
  onManualSend: (session, phase) => manualSends.push([session.sessionId, phase]),
  onAbort: async (session) => { aborts.push(session.sessionId); return false; },
});

const walk = (n, fn) => { fn(n); for (const c of n.children || []) walk(c, fn); };
const find = (root, pred) => { let hit = null; walk(root, (n) => { if (!hit && pred(n)) hit = n; }); return hit; };
const all = (root, pred) => { const out = []; walk(root, (n) => { if (pred(n)) out.push(n); }); return out; };
const hasClass = (n, cls) => String(n.className || '').split(/\s+/).includes(cls);
const textOf = (root) => { const out = []; walk(root, (n) => { if (n.textContent) out.push(String(n.textContent)); }); return out.join(' | '); };
const input = find(panel, (n) => n.tagName === 'TEXTAREA');
const key = (k, extra = {}) => input._fire('keydown', { key: k, isTrusted: true, isComposing: false, shiftKey: false, ...extra });
const type = (text) => { input.value = text; input.selectionStart = input.selectionEnd = text.length; input._fire('input', { isTrusted: true }); };
// (The stand-in's classList rewrites className, so a node that toggles a
// class is looked up once, before it does.)
const mentionBrowser = find(panel, (n) => hasClass(n, 'ocpv2-mention-browser'));
const mentionOpen = () => String(mentionBrowser.className).split(/\s+/).includes('open');
const tray = () => find(panel, (n) => hasClass(n, 'ocpv2-queue-tray'));
const trayTexts = () => all(tray(), (n) => hasClass(n, 'ocpv2-queue-text')).map((n) => String(n.textContent));

// ── The socket stand-in: every request is held until the test answers it ────
const connecting = ws.connect();
const sock = FakeWS.last;
sock.readyState = 1; sock._emit('open');
await connecting;
sock._emit('message', { data: JSON.stringify({ type: 'capabilities', capabilities: reqMod.opencodeV2WsCapabilities() }) });
const requests = [];
// Lists nobody is testing here answer at once, so nothing waits on them.
const AUTO = {
  'agent:list': [{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }],
  'command:list': [], 'session:share:policy': { share: 'manual' }, 'resource:list': [], 'reference:list': [], 'find:symbols': [],
};
const answer = (entry, data, extra = {}) => {
  entry.done = true;
  sock._emit('message', { data: JSON.stringify({ type: `${entry.msg.type}:result`, id: entry.msg.id, status: 200, data, ...extra }) });
};
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
  // A send or a stop that is still out belongs to an earlier step: it ends.
  for (const entry of [...waiting('message:send'), ...waiting('message:abort')]) answer(entry, true);
  await tick(10);
  settle();
  store.setRunning(false);
  goTo(null);
  goTo('ses_a');
  store.clearAttachedImages(); store.clearPendingPaths();
  input.value = ''; input._fire('input', { isTrusted: true });
  for (const btn of all(tray(), (n) => n.tagName === 'BUTTON' && String(n.textContent) === 'Clear')) btn._fire('click');
  manualSends.length = 0; aborts.length = 0;
  await tick(10);
}
await tick(20);

// ── T03: the reply of a send, after the panel moved ─────────────────────────
for (const [name, move] of MOVES) {
  await step(`T03 the reply to session A's prompt does not enter the store after a move (${name})`, async () => {
    await reset();
    type('hello from A'); key('Enter'); await tick(20);
    const [sent] = waiting('message:send');
    expect(sent, 'the prompt was not sent');
    same([sent.msg.sessionId, sent.msg.cwd], ['ses_a', '/work/a'], 'the prompt went to session A');
    move();
    // The session on screen is running a turn of its own.
    store.setRunning(true);
    const binding = store.getBinding();
    answer(sent, { info: { id: 'msg_reply_a', role: 'assistant', sessionID: 'ses_a', time: { created: 1, completed: 2 } }, parts: [{ id: 'prt_reply_a', messageID: 'msg_reply_a', type: 'text', text: 'answer for A' }] });
    await tick(40);
    expect(!store.getState().messages.has('msg_reply_a'), 'session A\'s reply was put into the store of another binding');
    expect(store.getState().running === true, 'the end of session A\'s turn cleared the run state of the binding on screen');
    same(waiting('session:messages').length, 0, 'a transcript was read for a binding the panel left');
    expect(store.getBinding() === binding, 'the send rebound the panel');
    // The outcome still counts for the session the prompt went to.
    same(manualSends, [['ses_a', 'started'], ['ses_a', 'succeeded']], 'the send callbacks name session A in every phase');
    expect(store.getState().errors.length === 0, 'an error was reported');
  });
}

// ── T03 / T05: a send that fails after the panel moved ──────────────────────
await step('T03 T05 a failed send restores nothing into the session on screen, and waits for its own', async () => {
  await reset();
  store.addAttachedImage({ name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' });
  store.addPendingPath('/work/a/notes.md');
  type('prompt that will fail'); key('Enter'); await tick(20);
  const [sent] = waiting('message:send');
  expect(sent && sent.msg.sessionId === 'ses_a', 'the prompt was not sent to session A');
  goTo('ses_b');
  // Session B has a plan of its own on screen.
  store.completePlanTurn({ content: '# Plan of B\n\n- step' });
  answer(sent, null, { error: 'provider is down' });
  await tick(40);
  const s = store.getState();
  same(s.errors.map((e) => e.message), [], 'session A\'s failure is not a banner of session B');
  same([s.attachedImages.length, s.pendingPaths.length], [0, 0], 'session A\'s attachments were put into session B\'s strips');
  same(input.value, '', 'session A\'s text was put into session B\'s box');
  expect(tray().hidden === true, 'session B got a queue');
  same(s.planContent, '# Plan of B\n\n- step', 'session B\'s plan was cleared by session A\'s failure');
  same(manualSends, [['ses_a', 'started'], ['ses_a', 'failed']], 'the failure is booked for session A');

  // Back on A: the prompt is in the queue, held, with what it carried.
  goTo('ses_a');
  await tick(10);
  expect(tray().hidden === false, 'the prompt did not come back to its own session');
  same(trayTexts(), ['prompt that will fail  +2'], 'the queued prompt, with its two attachments');
  const head = find(tray(), (n) => String(n.textContent).startsWith('Queue paused'));
  expect(head, 'the queue is not paused');
  expect(/provider is down/.test(String(head.title || '')), 'the reason is not shown');
  await tick(400);
  same(waiting('message:send').length, 0, 'a parked prompt went out without the user resuming');
  // Resume sends it to session A, attachments included.
  find(tray(), (n) => n.tagName === 'BUTTON' && String(n.textContent) === 'Resume')._fire('click');
  await tick(400);
  const [again] = waiting('message:send');
  expect(again, 'Resume did not send the prompt');
  same([again.msg.sessionId, again.msg.parts.map((p) => p.type)], ['ses_a', ['text', 'file', 'file']], 'sent to session A with its parts');
});

await step('T05 a queued prompt that fails after a move goes back to its own session\'s queue, not the next one\'s', async () => {
  await reset();
  store.setRunning(true);
  type('queued for A'); key('Enter'); await tick(10);
  same(trayTexts(), ['queued for A'], 'the prompt was queued');
  store.setRunning(false);
  await tick(380);                       // the queue drains 300 ms after the turn ends
  const [sent] = waiting('message:send');
  expect(sent && sent.msg.sessionId === 'ses_a', 'the queued prompt was not sent to session A');
  goTo('ses_b');
  answer(sent, null, { error: 'rate limited' });
  await tick(40);
  expect(tray().hidden === true, 'session A\'s prompt is in session B\'s queue');
  same(store.getState().errors.length, 0, 'session A\'s failure is not session B\'s');
  await tick(380);
  same(waiting('message:send').length, 0, 'the old prompt was sent to session B');
  goTo('ses_a');
  await tick(10);
  same(trayTexts(), ['queued for A'], 'back in session A\'s queue');
  expect(find(tray(), (n) => String(n.textContent).startsWith('Queue paused')), 'paused');
});

await step('T05 a queued prompt of session A that is still out does not hold up session B\'s queue', async () => {
  await reset();
  store.setRunning(true);
  type('slow prompt for A'); key('Enter'); await tick(10);
  store.setRunning(false);
  await tick(380);
  const [slow] = waiting('message:send');
  expect(slow && slow.msg.sessionId === 'ses_a', 'the queued prompt was not sent to session A');
  // Session A's turn takes minutes. Meanwhile, on session B:
  goTo('ses_b');
  store.setRunning(true);
  type('queued for B'); key('Enter'); await tick(10);
  same(trayTexts(), ['queued for B'], 'the prompt was queued on session B');
  store.setRunning(false);
  await tick(380);
  const forB = waiting('message:send').find((r) => r.msg.sessionId === 'ses_b');
  expect(forB, 'session B\'s queue is waiting for session A\'s send to come back');
  same(forB.msg.parts.map((p) => p.text), ['queued for B'], 'session B\'s own prompt');
});

await step('T03 Stop pressed in session A does not clear the plan turn or the run state of the session on screen', async () => {
  await reset();
  store.setRunning(true);
  key('Escape'); key('Escape'); await tick(20);       // two presses stop
  same(aborts, ['ses_a'], 'the stop callback got session A');
  const [abort] = waiting('message:abort');
  expect(abort && abort.msg.sessionId === 'ses_a', 'the abort was not for session A');
  goTo('ses_b');
  store.setAgent('plan');
  store.beginPlanTurn({ sessionId: 'ses_b', startMessageCount: 0 });
  store.setRunning(true);
  answer(abort, true);
  await tick(40);
  expect(store.getState().planTurnActive === true, 'session B\'s plan turn was cleared by session A\'s stop');
  expect(store.getState().running === true, 'session B\'s run state was cleared by session A\'s stop');
  store.setAgent('build');
});

// ── T02: the plan lifecycle ─────────────────────────────────────────────────
const planTranscript = (sessionID) => [
  { info: { id: `msg_u_${sessionID}`, role: 'user', sessionID, time: { created: 1 } }, parts: [{ id: `p_u_${sessionID}`, messageID: `msg_u_${sessionID}`, sessionID, type: 'text', text: 'plan it' }] },
  { info: { id: `msg_p_${sessionID}`, role: 'assistant', sessionID, time: { created: 2, completed: 3 } }, parts: [
    { id: `p_t_${sessionID}`, messageID: `msg_p_${sessionID}`, sessionID, type: 'text', text: `# Plan of ${sessionID}\n\n- one\n- two\n- three\n\nThis is a long enough plan body to count as a real plan for the lifecycle.` },
    { id: `p_q_${sessionID}`, messageID: `msg_p_${sessionID}`, sessionID, callID: `call_${sessionID}`, type: 'tool', tool: 'question', state: { status: 'running', input: { questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }] } } },
  ] },
];
for (const [name, move] of MOVES) {
  await step(`T02 a plan finalization of session A applies nothing after a move (${name})`, async () => {
    await reset();
    store.setAgent('plan');
    store.beginPlanTurn({ sessionId: 'ses_a', startMessageCount: 0 });
    const finalizing = plan.maybeFinalizePlanTurn('test', store, { lenient: true });
    await tick(10);
    const [read] = waiting('session:messages');
    expect(read && read.msg.sessionId === 'ses_a', 'the transcript of session A was not read');
    move();
    answer(read, planTranscript('ses_a'));
    const outcome = await finalizing;
    const s = store.getState();
    expect(outcome === false, 'the finalization reported a plan');
    same(s.messageOrder, [], 'session A\'s transcript (with its open question part) is in the store of another binding');
    same([s.showPostPlanActions, s.planContent], [false, ''], 'session A\'s plan is on the card of another binding');
    store.setAgent('build');
  });
}
await step('T02 a finalization in flight for session A does not block the one for session B', async () => {
  await reset();
  store.setAgent('plan');
  store.beginPlanTurn({ sessionId: 'ses_a', startMessageCount: 0 });
  const first = plan.maybeFinalizePlanTurn('test', store, { lenient: true });
  await tick(10);
  goTo('ses_b');
  store.beginPlanTurn({ sessionId: 'ses_b', startMessageCount: 0 });
  const second = plan.maybeFinalizePlanTurn('test', store, { lenient: true });
  await tick(10);
  const reads = waiting('session:messages').map((r) => r.msg.sessionId);
  same(reads, ['ses_a', 'ses_b'], 'session B\'s finalization was skipped while session A\'s was out');
  answer(waiting('session:messages', (m) => m.sessionId === 'ses_b')[0], planTranscript('ses_b'));
  expect(await second === true, 'session B\'s plan did not complete');
  answer(waiting('session:messages', (m) => m.sessionId === 'ses_a')[0], planTranscript('ses_a'));
  expect(await first === false, 'session A\'s late answer completed a plan');
  expect(/Plan of ses_b/.test(store.getState().planContent), 'the plan on screen is not session B\'s');
  expect(!store.getState().messages.has('msg_p_ses_a'), 'session A\'s transcript entered session B\'s store');
  store.setAgent('build');
});
await step('T02 a plan file, the editor and Compact stay with the session whose plan it was', async () => {
  await reset();
  const opened = [];
  const off = shared.on('open-plan-editor', (ev) => opened.push(ev));
  const realFetch = globalThis.fetch;
  const created = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) !== '/api/create-plan') return realFetch(url, init);
    return new Promise((resolve) => created.push({ body: JSON.parse(init.body), resolve: (path) => resolve({ ok: true, status: 200, json: async () => ({ ok: true, path }) }) }));
  };
  try {
    // Edit on session A's plan: its file is being written.
    store.completePlanTurn({ content: '# Plan of A\n\n- a' });
    const editing = plan.handlePostPlanAction('edit', store);
    await tick(10);
    same(created.map((c) => c.body.cwd), ['/work/a'], 'the plan file is created in session A\'s project');
    goTo('ses_b');
    store.completePlanTurn({ content: '# Plan of B\n\n- b' });
    // Edit on session B while session A's file is still being written: B gets
    // a file of its own, not the materialization pending for A's plan.
    const editingB = plan.handlePostPlanAction('edit', store);
    await tick(10);
    same(created.length, 2, 'session B reused the materialization that was pending for session A');
    same(created[1].body.cwd, '/work/b', 'session B\'s plan file is created in session B\'s project');
    created[0].resolve('/plans/a.md');
    expect(await editing === false, 'Edit reported success after the move');
    await tick(10);
    same(store.getState().planFilePath, '', 'session A\'s plan file was attached to session B\'s plan');
    same(opened, [], 'the editor was opened (tagged with the session on screen)');
    expect(store.getState().planMaterializing === true, 'session A\'s file finishing ended session B\'s "creating plan file" state');
    created[1].resolve('/plans/b.md');
    expect(await editingB === true, 'Edit on session B failed');
    same(opened.map((ev) => [ev.filePath, ev.tabId]), [['/plans/b.md', 'ses_b']], 'the editor event of session B');

    // Compact from session A's plan card, answered after the move.
    goTo('ses_a');
    store.completePlanTurn({ content: '# Plan of A\n\n- a' });
    const compacting = plan.handlePostPlanAction('compact', store);
    await tick(10);
    const [compact] = waiting('session:compact');
    expect(compact && compact.msg.sessionId === 'ses_a', 'Compact was not for session A');
    goTo('ses_b');
    store.completePlanTurn({ content: '# Plan of B\n\n- b', header: 'PLAN COMPLETE' });
    answer(compact, true);
    expect(await compacting === false, 'Compact reported success after the move');
    same(store.getState().postPlanHeader, 'PLAN COMPLETE', 'session B\'s card says CONTEXT COMPACTED');
    // …and a failed one throws nothing at the session on screen.
    goTo('ses_a');
    store.completePlanTurn({ content: '# Plan of A\n\n- a' });
    const failing = plan.handlePostPlanAction('compact', store);
    await tick(10);
    const [bad] = waiting('session:compact');
    goTo('ses_b');
    answer(bad, null, { error: 'compaction failed' });
    expect(await failing === false, 'a failure of session A was thrown at session B');
  } finally {
    globalThis.fetch = realFetch;
    off?.();
  }
});

// ── T09: the env popover ────────────────────────────────────────────────────
for (const [name, move] of MOVES) {
  await step(`T09 the env popover paints nothing of the session the panel left (${name})`, async () => {
    await reset();
    const envBtn = { _fire: () => envCtl.toggle() };
    const pop = find(panel, (n) => hasClass(n, 'ocpv2-env-popover'));
    // (The stand-in does not empty a node when textContent is set, so what an
    // earlier step painted is still under the popover: links are counted.)
    const attachLinks = () => all(pop, (n) => n.tagName === 'BUTTON' && String(n.textContent) === 'Attach').length;
    const attachBefore = attachLinks();
    if (!pop.hidden) envBtn._fire('click');
    envBtn._fire('click');
    await tick(10);
    const oldStatus = waiting('mcp:status')[0];
    const oldEnv = waiting('env:status')[0];
    expect(oldStatus?.msg.sessionId === 'ses_a' && oldEnv?.msg.sessionId === 'ses_a', 'the popover did not read session A');
    move();
    await tick(10);
    const now = store.getState().sessionId;
    // One read per binding the panel went through; the last one is the one on screen.
    const laterStatus = waiting('mcp:status').filter((r) => r !== oldStatus);
    const laterEnv = waiting('env:status').filter((r) => r !== oldEnv);
    const newStatus = laterStatus.pop();
    const newEnv = laterEnv.pop();
    expect(newStatus?.msg.sessionId === now && newEnv?.msg.sessionId === now, 'the popover did not re-read for the binding on screen');
    // The answers of every earlier binding arrive late.
    for (const entry of [oldStatus, ...laterStatus]) answer(entry, [{ name: 'server-of-old-binding', status: 'connected' }]);
    for (const entry of [oldEnv, ...laterEnv]) answer(entry, { lsp: [{ name: 'lsp-of-old-binding', status: 'connected', root: '/work/a' }], formatter: [], references: [{ name: 'ref-of-old-binding', path: '/refs/old' }] });
    await tick(30);
    const stale = textOf(pop);
    expect(!/of-old-binding/.test(stale), `the earlier read was painted: ${stale}`);
    same(attachLinks(), attachBefore, 'an Attach link of the earlier read is in the popover');
    // The read of the binding on screen is what shows.
    answer(newStatus, [{ name: 'server-now', status: 'connected' }]);
    answer(newEnv, { lsp: [], formatter: [], references: [{ name: 'ref-now', path: '/refs/now' }] });
    await tick(30);
    const fresh = textOf(pop);
    expect(/server-now/.test(fresh) && /ref-now/.test(fresh), `the popover does not show the current read: ${fresh}`);
    same(attachLinks(), attachBefore + 1, 'one Attach link more, of the current read');
    envBtn._fire('click');
  });
}

// ── T10: the changes viewer ─────────────────────────────────────────────────
for (const [name, move] of MOVES) {
  await step(`T10 the changes viewer closes when the panel moves, and a late diff shows nowhere (${name})`, async () => {
    await reset();
    store.setSessionDiff([{ file: 'a.js', patch: '@@ -1 +1 @@\n-a\n+b', additions: 1, deletions: 1, status: 'modified' }]);
    const reviewBar = find(panel, (n) => hasClass(n, 'ocpv2-changes-bar'));
    expect(reviewBar && !reviewBar.hidden, 'no changes bar');
    reviewBar._fire('click');
    await tick(10);
    const overlay = () => find(panel, (n) => hasClass(n, 'ocpv2-changes-overlay'));
    expect(overlay(), 'the viewer did not open');
    const [diff] = waiting('session:diff');
    expect(diff?.msg.sessionId === 'ses_a', 'the viewer did not read session A\'s diff');
    const view = overlay();
    move();
    await tick(10);
    expect(!overlay(), 'session A\'s viewer is still over the panel');
    answer(diff, [{ file: 'file-of-old-binding.js', patch: '@@ -1 +1 @@\n-x\n+y', additions: 1, deletions: 1, status: 'modified' }]);
    await tick(30);
    expect(!/file-of-old-binding/.test(textOf(view)), 'the late diff was painted');
    expect(!/file-of-old-binding/.test(textOf(panel)), 'the late diff is on screen');
  });
}

// ── T15: the @ picker ───────────────────────────────────────────────────────
for (const [name, move] of MOVES) {
  await step(`T15 a pending @ search offers nothing after the panel moved (${name})`, async () => {
    await reset();
    type('@ru');
    await tick(200);                       // past the picker's debounce
    const [files] = waiting('find:files');
    expect(files?.msg.cwd === '/work/a', 'the search was not made in session A\'s project');
    move();
    answer(files, ['src/run-of-old-binding.js']);
    await tick(40);
    expect(mentionBrowser, 'no @ picker');
    expect(!mentionOpen(), 'the picker opened with another project\'s rows');
    expect(!/run-of-old-binding/.test(textOf(mentionBrowser)), 'another project\'s file is offered');
    key('Enter');                           // would pick the first row if one were offered
    await tick(20);
    expect(!/run-of-old-binding/.test(input.value), 'a stale row was picked into the prompt');
  });
}
await step('T15 the same search, with nothing moving, still opens the picker', async () => {
  await reset();
  type('@ru');
  await tick(200);
  const [files] = waiting('find:files');
  answer(files, ['src/run.js']);
  await tick(40);
  expect(mentionOpen() && /src\/run\.js/.test(textOf(mentionBrowser)), 'the picker did not open');
  key('Escape');
});

// ── T12: the orphan scan of the sub-agent manager ───────────────────────────
await step('T12 a late child scan of session A spawns nothing once the panel is on session B', async () => {
  await reset();
  manager.registerPrimaryPanel({ panelId: 'ocp-v2-panel', store, getSessionId: () => store.getState().sessionId });
  await tick(10);
  const scanA = waiting('session:children').find((r) => r.msg.sessionId === 'ses_a');
  expect(scanA, 'no child scan for session A');
  goTo('ses_b');
  manager.bindPrimarySession(store, 'ses_b');
  await tick(10);
  const scanB = waiting('session:children').find((r) => r.msg.sessionId === 'ses_b');
  expect(scanB, 'no child scan for session B');
  answer(scanA, [{ id: 'ses_child_of_a', parentID: 'ses_a', title: 'explore', time: { created: 5 } }]);
  await tick(30);
  same(manager.getChildPanels(), [], 'session A\'s child was materialized under session B');
  answer(scanB, []);
  await tick(30);
  same(manager.getChildPanels(), [], 'a child panel appeared');
  manager.bindPrimarySession(store, null);
});

settle();
console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.join('\n') : '\nno problems');
process.exit(0);

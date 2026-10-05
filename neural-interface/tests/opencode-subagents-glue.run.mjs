// A panel and a pill per sub-agent: the real manager (ocp-v2-manager.js), the
// real sub-agent panels with their composers and renderers, and the shared
// side panel controller (ui-sidepanel-windows.js), under the DOM stand-in of
// the smoke run. Started by opencode-subagents.test.mjs in a child process.
// The socket stand-in answers what a step does not care about and holds what
// it does. Prints one line per step and ends with "no problems" or the list.
import { installDom, makeNode } from './opencode-panel-dom.fixtures.mjs';
const { doc, FakeWS } = installDom();
const base = new URL('../public/shared/ocp-v2/', import.meta.url).href;
const problems = [];
process.on('unhandledRejection', (err) => problems.push(`unhandledRejection: ${err?.stack?.split('\n').slice(0, 3).join(' | ') || err}`));
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (err) { problems.push(`${name}: ${err?.stack?.split('\n').slice(0, 4).join(' | ')}`); console.log('FAIL', name, '-', err?.message); } };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 1500) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return v; await tick(15); } };
const expect = (cond, message) => { if (!cond) throw new Error(message); };
const same = (actual, expected, message) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); };

const trayEl = makeNode('div'); trayEl.id = 'term-minimized-tray'; doc.body.appendChild(trayEl);

// What the page before the "reload" left behind: sub-agent r2 of session R was
// the panel on screen, and the user had closed r3.
sessionStorage.setItem('ocp-v2-subagent-shown', JSON.stringify({ rootSessionId: 'ses_r', sessionId: 'ses_r2' }));
const { storage } = await import(base + '../storage.js');
storage.setItem('opencode-v2-subagents-closed', JSON.stringify({ ses_r3: 'ses_r' }));

const state = await import(base + 'ocp-v2-state.js');
const ws = await import(base + 'ocp-v2-ws.js');
const send = await import(base + 'ocp-v2-send.js');
const manager = await import(base + 'ocp-v2-manager.js');
const { MAIN_VIEW } = await import(base + 'ocp-v2-subagents-logic.js');
const ownership = await import(base + 'ocp-v2-automation-ownership.js');
const windows = await import(base + '../ui-sidepanel-windows.js');
const shared = await import(base + '../state.js');
const reqMod = await import(new URL('../lib/opencode-v2-ws-requests.js', import.meta.url).href);

// ── Finding things ──────────────────────────────────────────────────────────
const walk = (n, fn) => { fn(n); for (const c of n.children || []) walk(c, fn); };
const find = (root, pred) => { let hit = null; walk(root, (n) => { if (!hit && pred(n)) hit = n; }); return hit; };
const all = (root, pred) => { const out = []; walk(root, (n) => { if (pred(n)) out.push(n); }); return out; };
const hasClass = (n, cls) => String(n?.className || '').split(/\s+/).includes(cls);
const textOf = (root) => { const out = []; walk(root, (n) => { if (n.textContent) out.push(String(n.textContent)); }); return out.join(' | '); };
const childPills = () => all(trayEl, (n) => String(n.dataset?.owner || '').startsWith('ocp-v2-child-'));
const pillIds = () => childPills().map((n) => n.dataset.sessionId);
const pillOf = (sessionId) => childPills().find((n) => n.dataset.sessionId === sessionId) || null;
const partOf = (pill, cls) => find(pill, (n) => hasClass(n, cls));
const click = (node, extra = {}) => node._fire('click', { target: node, ...extra });
const panelOf = (sessionId) => manager.getChildPanel(sessionId);
const buttonIn = (root, pred) => find(root, (n) => n.tagName === 'BUTTON' && pred(n));
const titled = (root, title) => buttonIn(root, (n) => n.title === title);
const labelled = (root, text) => buttonIn(root, (n) => String(n.textContent) === text);
const inputOf = (root) => find(root, (n) => n.tagName === 'TEXTAREA');
const typeInto = (input, text) => { input.value = text; input.selectionStart = input.selectionEnd = text.length; input._fire('input', { isTrusted: true }); };
const enter = (input) => input._fire('keydown', { key: 'Enter', isTrusted: true, isComposing: false, shiftKey: false });
const visibleIds = () => manager.getChildPanels().filter((p) => p.visible).map((p) => p.sessionId);
const confirmRows = (root) => all(root, (n) => hasClass(n, 'ocpv2-confirm'));

// ── The sessions of this run ────────────────────────────────────────────────
const TITLES = { ses_r: 'RELOADED', ses_root: 'ROOT', ses_b: 'OTHER', ses_auto: 'AUTOMATION' };
const PARENTS = {};                     // child → parent, as the server would report it
const CHILDREN = {                      // session:children answers
  ses_r: [
    { id: 'ses_r2', parentID: 'ses_r', title: 'second', time: { created: 20 } },
    { id: 'ses_r1', parentID: 'ses_r', title: 'first', time: { created: 10 } },
    { id: 'ses_r3', parentID: 'ses_r', title: 'closed before the reload', time: { created: 30 } },
  ],
  ses_r2: [{ id: 'ses_r2a', parentID: 'ses_r2', title: 'nested', time: { created: 25 } }],
};
for (const [parent, list] of Object.entries(CHILDREN)) for (const s of list) { PARENTS[s.id] = parent; TITLES[s.id] = s.title; }
const tabs = new Set(['ses_r', 'ses_root', 'ses_b', 'ses_auto']);

// ── The socket stand-in ─────────────────────────────────────────────────────
// What the server would answer about a session agrees with what its events
// said (a sub-agent's session is read when its panel is first shown, which can
// be after such events): its run state and the requests that are open.
const STATUS = {};                      // sessionId → 'busy'
const OPEN = { permissions: [], questions: [] };
function serverSaw(eventType, event) {
  const sessionId = event?.sessionID || event?.info?.id || '';
  if (eventType === 'session.status' && event?.status?.type === 'busy') STATUS[sessionId] = 'busy';
  if (eventType === 'session.idle' || eventType === 'session.error') delete STATUS[sessionId];
  if (eventType === 'permission.asked') OPEN.permissions.push(event);
  if (eventType === 'permission.replied') OPEN.permissions = OPEN.permissions.filter((req) => req.id !== event.requestID);
  if (eventType === 'question.asked') OPEN.questions.push(event);
  if (eventType === 'question.replied' || eventType === 'question.rejected') OPEN.questions = OPEN.questions.filter((req) => req.id !== event.requestID);
}
const requests = [];
const holds = new Set();
const held = (msg) => [...holds].some((pred) => pred(msg));
const defaultAnswer = (msg) => {
  switch (msg.type) {
    case 'session:get': return { id: msg.sessionId, directory: '/work/a', title: TITLES[msg.sessionId] || msg.sessionId, ...(PARENTS[msg.sessionId] ? { parentID: PARENTS[msg.sessionId] } : {}) };
    case 'session:children': return CHILDREN[msg.sessionId] || [];
    case 'session:share:policy': return { share: 'manual' };
    case 'agent:list': return [{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }];
    case 'session:status': return STATUS[msg.sessionId] ? { status: { type: STATUS[msg.sessionId] } } : {};
    case 'permission:list': return OPEN.permissions;
    case 'question:list': return OPEN.questions;
    case 'message:send': case 'permission:reply': case 'message:abort': case 'session:delete': return true;
    default: return [];
  }
};
const answer = (entry, data, extra = {}) => {
  if (entry.done) return;
  entry.done = true;
  entry.sock._emit('message', { data: JSON.stringify({ type: `${entry.msg.type}:result`, id: entry.msg.id, status: 200, data, ...extra }) });
};
FakeWS.prototype.send = function sendRaw(raw) {
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  if (msg.id == null) return;
  const entry = { msg, done: false, sock: this };
  requests.push(entry);
  if (!held(msg)) setTimeout(() => answer(entry, defaultAnswer(msg)), 1);
};
const sentOf = (type, pred = () => true) => requests.filter((r) => r.msg.type === type && pred(r.msg));
const waiting = (type, pred = () => true) => requests.filter((r) => !r.done && r.msg.type === type && pred(r.msg));
const hold = (pred) => { holds.add(pred); return () => holds.delete(pred); };
const connecting = ws.connect();
const sock = FakeWS.last;
sock.readyState = 1; sock._emit('open');
await connecting;
sock._emit('message', { data: JSON.stringify({ type: 'capabilities', capabilities: reqMod.opencodeV2WsCapabilities() }) });
const emitEvent = (eventType, event) => { serverSaw(eventType, event); sock._emit('message', { data: JSON.stringify({ type: 'event', eventType, event }) }); };
const created = (id, parentID, title, at) => { PARENTS[id] = parentID; TITLES[id] = title; emitEvent('session.created', { info: { id, parentID, title, time: { created: at } } }); };
const busy = (sessionId) => emitEvent('session.status', { sessionID: sessionId, status: { type: 'busy' } });
const idle = (sessionId) => emitEvent('session.idle', { sessionID: sessionId });
const says = (sessionId, messageID, text) => {
  emitEvent('message.updated', { sessionID: sessionId, info: { id: messageID, role: 'assistant', sessionID: sessionId, time: { created: 1, completed: 2 } } });
  emitEvent('message.part.updated', { sessionID: sessionId, part: { id: `prt_${messageID}`, messageID, sessionID: sessionId, type: 'text', text, time: { start: 1, end: 2 } } });
};

// ── The main panel: its store, its composer, its view in the shared slot ────
const store = state.createPanelStore();
function goTo(sessionId) {
  store.clearMessages();
  store.setSession(sessionId, sessionId ? { id: sessionId, title: TITLES[sessionId], directory: '/work/a' } : null);
  manager.bindPrimarySession(store, sessionId);
}
store.setSession('ses_r', { id: 'ses_r', title: 'RELOADED', directory: '/work/a' });
const mainEl = makeNode('div'); doc.body.appendChild(mainEl);
const mainCompose = makeNode('div'); mainEl.appendChild(mainCompose);
send.mountCompose(mainCompose, store, { pickers: false });
const mainInput = inputOf(mainEl);

// A panel in the shared slot at the right edge, registered like the real ones.
function slotPanel(owner, provider, onApply = () => {}) {
  const element = makeNode('div'); const header = makeNode('div'); const actions = makeNode('div');
  header.appendChild(actions); element.appendChild(header); doc.body.appendChild(element);
  const view = { owner, visible: false };
  windows.registerSidepanel({ owner, provider, element, header, actions, buttonClass: 'x-btn', applyVisibility: (v) => { view.visible = !!v; onApply(view.visible); } });
  return view;
}
const main = slotPanel('ocp-v2-panel', 'opencode', (v) => shared.emit('opencode-panel:visibility', v));
const claude = slotPanel('claude-panel', 'claude');
const codex = slotPanel('codex-panel', 'codex');
manager.registerMainView({ owner: 'ocp-v2-panel', isVisible: () => main.visible });
shared.on('opencode-panel:request-show', () => manager.requestOpencodeView({ show: MAIN_VIEW }));
// The tab pill of a session the main panel has as a tab (ocp-v2-panel.js makes these).
function tabPill(sessionId) {
  const pill = makeNode('div');
  pill.classList.add('term-minimized-pill', 'ocpv2-session-pill');
  pill.dataset.owner = 'ocp-v2-panel'; pill.dataset.sessionId = sessionId;
  trayEl.appendChild(pill);
  return pill;
}
const rootPills = { ses_r: tabPill('ses_r'), ses_root: tabPill('ses_root'), ses_b: tabPill('ses_b') };
const kept = [];                        // prompts the manager hands back when a panel went away by itself
const mainUntouched = () => {
  const s = store.getState();
  return JSON.stringify([s.messageOrder.length, s.pendingPermissions.length, s.pendingQuestions.length, s.errors.length, s.running, mainInput.value]);
};

// ── S8 reload: the first thing the page does after a reload ─────────────────
await step('S8 reload: the pills of the session on screen are rebuilt from its children, and the panel that was visible is visible again', async () => {
  // The user opened OpenCode: the main panel is on screen, on session R.
  windows.setSidepanelVisible('ocp-v2-panel', true);
  expect(main.visible, 'the main panel did not open');
  manager.registerPrimaryPanel({
    panelId: 'ocp-v2-panel', store, getSessionId: () => store.getState().sessionId,
    ownsSession: (sid) => tabs.has(sid), keepPrompts: (items, label) => kept.push([label, items.map((i) => i.text)]),
  });
  await until(() => manager.getChildPanels().length >= 3);
  await tick(60);
  same(manager.getChildPanels().map((p) => [p.sessionId, p.parentSessionId, p.rootSessionId]),
    [['ses_r1', 'ses_r', 'ses_r'], ['ses_r2', 'ses_r', 'ses_r'], ['ses_r2a', 'ses_r2', 'ses_r']], 'a panel per child, in the order they were started; the closed one stays closed');
  same(pillIds(), ['ses_r1', 'ses_r2', 'ses_r2a'], 'a pill per child');
  expect(sentOf('session:children').some((r) => r.msg.sessionId === 'ses_r2'), 'the children of a child were not read');
  // The panel that was on screen before the reload is on screen again.
  same(visibleIds(), ['ses_r2'], 'the sub-agent panel that was visible is not visible again');
  expect(!main.visible, 'the main panel stayed on screen next to it');
  expect(pillOf('ses_r2').dataset.shown === '1' && pillOf('ses_r1').dataset.shown !== '1', 'the pill does not say which panel is on screen');
  // Its session is read whole, as for any panel that is shown; the others cost what their pills need.
  await until(() => sentOf('session:messages').length >= 1);
  await tick(60);
  same(sentOf('session:messages').map((r) => r.msg.sessionId), ['ses_r2'], 'whose transcript was read after the reload');
  // Once: a later scan of the same session restores nothing.
  manager.requestOpencodeView({ show: MAIN_VIEW });
  manager.bindPrimarySession(store, 'ses_r');
  await tick(80);
  same(visibleIds(), [], 'a second scan put the sub-agent panel back on screen');
  expect(main.visible, 'the main panel is not on screen');
});

await step('S4 a scan while nothing of OpenCode is on screen opens nothing (an automation that boots the panel)', async () => {
  manager.requestOpencodeView({ hideAll: true });
  goTo('ses_root');
  await tick(60);
  same([main.visible, visibleIds()], [false, []], 'something opened by itself');
  same(pillIds(), [], 'the pills of the session the panel left are still in the tray');
});

// ── S1 ──────────────────────────────────────────────────────────────────────
let c1 = null;
await step('S1 a second and a third sub-agent each get a panel and a pill, and the first is untouched', async () => {
  created('ses_c1', 'ses_root', 'one', 100);
  await tick(40);
  c1 = panelOf('ses_c1');
  expect(c1 && c1.store.getState().sessionId === 'ses_c1', 'no panel for the first sub-agent');
  says('ses_c1', 'msg_c1', 'first answer');
  const firstPill = pillOf('ses_c1');
  created('ses_c2', 'ses_root', 'two', 200);
  created('ses_c3', 'ses_root', 'three', 300);
  await tick(60);
  same(manager.getChildPanels().filter((p) => p.rootSessionId === 'ses_root').map((p) => p.sessionId), ['ses_c1', 'ses_c2', 'ses_c3'], 'three panels');
  same(pillIds(), ['ses_c1', 'ses_c2', 'ses_c3'], 'three pills, in the order they were started');
  expect(panelOf('ses_c1') === c1, 'the first panel was replaced');
  expect(pillOf('ses_c1') === firstPill, 'the first pill was replaced');
  expect(c1.store.getState().messages.has('msg_c1'), 'the first panel lost its transcript');
  expect(new Set([c1.store, panelOf('ses_c2').store, panelOf('ses_c3').store]).size === 3, 'two panels share a store');
  expect(new Set([c1.panelId, panelOf('ses_c2').panelId, panelOf('ses_c3').panelId]).size === 3, 'two panels share an id');
  // The same session announced again (session.updated, the task tool's part) makes no second panel.
  emitEvent('session.updated', { info: { id: 'ses_c2', parentID: 'ses_root', title: 'two' } });
  emitEvent('message.part.updated', { sessionID: 'ses_root', part: { id: 'prt_task', messageID: 'msg_root', sessionID: 'ses_root', type: 'tool', tool: 'task', state: { status: 'running', input: { description: 'do three', subagent_type: 'explore' }, metadata: { sessionId: 'ses_c3' } } } });
  await tick(40);
  same(pillIds(), ['ses_c1', 'ses_c2', 'ses_c3'], 'an announcement of a known sub-agent made another pill');
});

await step('S4 nothing opens by itself: a new sub-agent is a pill; an automation\'s sub-agents get neither pill nor panel', async () => {
  same([main.visible, visibleIds(), manager.isChildPanelOpen()], [false, [], false], 'a spawn showed a panel');
  // Also while the main panel is on screen: it stays, and no sub-agent panel shows.
  manager.requestOpencodeView({ show: MAIN_VIEW });
  created('ses_c4', 'ses_root', 'four', 400);
  await tick(40);
  same([main.visible, visibleIds()], [true, []], 'a spawn took the screen from the main panel');
  expect(pillOf('ses_c4'), 'no pill for the new sub-agent');
  // A scheduled automation's session creates sub-agents too.
  ownership.registerAutomationSession('ses_auto', 'run_1');
  created('ses_auto_child', 'ses_auto', 'automation task', 500);
  created('ses_auto_grand', 'ses_auto_child', 'automation sub-task', 510);
  await tick(40);
  expect(!panelOf('ses_auto_child') && !panelOf('ses_auto_grand'), 'an automation\'s sub-agent got a panel');
  expect(!pillOf('ses_auto_child'), 'an automation\'s sub-agent got a pill');
  // A session of another window (not a tab here) is nobody's parent in this panel.
  created('ses_foreign_child', 'ses_foreign', 'elsewhere', 520);
  await tick(40);
  expect(!panelOf('ses_foreign_child'), 'a sub-agent of a session that is no tab here got a panel');
  manager.requestOpencodeView({ hideAll: true });
});

// ── S5 ──────────────────────────────────────────────────────────────────────
await step('S5 one panel at a time: a click on a pill shows that sub-agent and hides the one that was visible; Claude and Codex share the slot', async () => {
  manager.requestOpencodeView({ show: MAIN_VIEW });
  click(pillOf('ses_c1'));
  same([main.visible, visibleIds()], [false, ['ses_c1']], 'pill one');
  expect(panelOf('ses_c1').isVisible(), 'the panel does not say it is visible');
  click(pillOf('ses_c2'));
  same([main.visible, visibleIds()], [false, ['ses_c2']], 'pill two');
  // Every pill stays in the tray; the one on screen is marked.
  same(pillIds(), ['ses_c1', 'ses_c2', 'ses_c3', 'ses_c4'], 'a pill left the tray');
  same(childPills().map((p) => p.dataset.shown === '1'), [false, true, false, false], 'which one is on screen');
  // Claude takes the slot: no OpenCode panel is on screen, and none comes back by itself.
  windows.setSidepanelVisible('claude-panel', true);
  same([claude.visible, main.visible, visibleIds()], [true, false, []], 'Claude and a sub-agent panel are both on screen');
  same(childPills().map((p) => p.dataset.shown === '1'), [false, false, false, false], 'a pill still says it is on screen');
  // A sub-agent pill takes it back from Claude, then Codex takes it.
  click(pillOf('ses_c3'));
  same([claude.visible, visibleIds()], [false, ['ses_c3']], 'the sub-agent panel did not take the slot from Claude');
  windows.setSidepanelVisible('codex-panel', true);
  same([codex.visible, visibleIds()], [true, []], 'Codex and a sub-agent panel are both on screen');
  click(pillOf('ses_c3'));
  same([codex.visible, visibleIds()], [false, ['ses_c3']], 'the sub-agent panel did not take the slot from Codex');
  // The pill of the panel on screen minimizes it.
  click(pillOf('ses_c3'));
  same(visibleIds(), [], 'a second click on the pill did not minimize');
  // The main panel and a sub-agent panel swap the same way.
  click(pillOf('ses_c1'));
  manager.requestOpencodeView({ show: MAIN_VIEW });
  same([main.visible, visibleIds()], [true, []], 'the main panel did not replace the sub-agent panel');
  expect(manager.isChildPanelOpen() === false && manager.getVisibleChildPanel() === null, 'a sub-agent panel is reported open');
  manager.requestOpencodeView({ hideAll: true });
  same([main.visible, visibleIds()], [false, []], 'hide all');
});

// ── S2 ──────────────────────────────────────────────────────────────────────
await step('S2 event: an event for sub-agent A changes A alone, also after A was closed', async () => {
  const [a, b] = [panelOf('ses_c1'), panelOf('ses_c2')];
  const before = { b: b.store.getState().messageOrder.length, main: mainUntouched() };
  says('ses_c1', 'msg_only_a', 'for A');
  emitEvent('question.asked', { id: 'que_a', sessionID: 'ses_c1', questions: [] });
  emitEvent('session.error', { sessionID: 'ses_c1', error: { name: 'APIError', data: { message: 'A failed' } } });
  await tick(30);
  expect(a.store.getState().messages.has('msg_only_a') && a.store.getState().pendingQuestions.length === 1 && a.store.getState().errors.length === 1, 'A did not take its own events');
  same([b.store.getState().messageOrder.length, b.store.getState().pendingQuestions.length, b.store.getState().errors.length], [before.b, 0, 0], 'B changed');
  same(mainUntouched(), before.main, 'the main panel changed');
  emitEvent('question.replied', { requestID: 'que_a', sessionID: 'ses_c1' });
  // Late: A's panel is closed, then more of A arrives.
  created('ses_late', 'ses_root', 'late', 450);
  await tick(40);
  const late = panelOf('ses_late');
  click(partOf(pillOf('ses_late'), 'term-minimized-pill-close'));
  await tick(30);
  expect(!panelOf('ses_late') && !pillOf('ses_late'), 'the panel was not closed');
  says('ses_late', 'msg_late', 'after the close');
  busy('ses_late');
  emitEvent('session.error', { sessionID: 'ses_late', error: { name: 'APIError', data: { message: 'late failure' } } });
  emitEvent('session.updated', { info: { id: 'ses_late', parentID: 'ses_root', title: 'late again' } });
  await tick(40);
  expect(!panelOf('ses_late') && !pillOf('ses_late'), 'a late event brought the closed panel back');
  expect(!late.store.getState().messages.has('msg_late'), 'the closed panel\'s store still follows the session');
  same([b.store.getState().messageOrder.length, b.store.getState().errors.length], [before.b, 0], 'B took A\'s late events');
  same(mainUntouched(), before.main, 'the main panel changed');
  // One thing of a sub-agent without a panel is not dropped: a request that
  // waits for an answer goes to its nearest ancestor that has a panel (the
  // main panel here), so that it can still be answered. Never to a sibling.
  emitEvent('permission.asked', { id: 'per_late', sessionID: 'ses_late', permission: 'bash' });
  await tick(30);
  same([store.getState().pendingPermissions.map((p) => p.id), b.store.getState().pendingPermissions.length, a.store.getState().pendingPermissions.length],
    [['per_late'], 0, 0], 'where the request of a closed sub-agent goes');
  emitEvent('permission.replied', { requestID: 'per_late', sessionID: 'ses_late' });
  await tick(20);
  same(mainUntouched(), before.main, 'the main panel did not get back to where it was');
});

await step('S2 queue: a prompt queued in sub-agent A goes to A\'s session, also when A is not the panel on screen and when its answer is late', async () => {
  created('ses_q1', 'ses_root', 'queue one', 600);
  created('ses_q2', 'ses_root', 'queue two', 610);
  await tick(60);
  const [a, b] = [panelOf('ses_q1'), panelOf('ses_q2')];
  click(pillOf('ses_q1'));
  click(pillOf('ses_q2'));              // both panels were on screen once: both have a compose box
  click(pillOf('ses_q1'));
  const [inA, inB] = [inputOf(a.panel), inputOf(b.panel)];
  expect(inA && inB && inA !== inB && inA !== mainInput, 'the panels share a compose box');
  typeInto(inB, 'draft of B');
  typeInto(mainInput, 'draft of main');
  busy('ses_q1');
  await tick(20);
  typeInto(inA, 'queued for A'); enter(inA);
  await tick(30);
  same([inA.value, inB.value, mainInput.value], ['', 'draft of B', 'draft of main'], 'the prompt was not queued in A alone');
  same(a.waiting().map((i) => i.text), ['queued for A'], 'A\'s queue');
  same([b.waiting().map((i) => i.text), manager.subagentPromptsWaiting('ses_root').map((i) => i.text)], [['draft of B'], ['queued for A', 'draft of B']], 'what is waiting in the sub-agent panels');
  const before = mainUntouched();
  // A is no longer the panel on screen when its turn ends.
  click(pillOf('ses_q2'));
  const release = hold((msg) => msg.type === 'message:send');
  idle('ses_q1');
  const sent = await until(() => waiting('message:send')[0]);
  expect(sent, 'the queued prompt was not sent');
  same([sentOf('message:send').length, sent.msg.sessionId, sent.msg.parts?.[0]?.text], [1, 'ses_q1', 'queued for A'], 'the queued prompt went somewhere else');
  same([inB.value, b.store.getState().messageOrder.length, b.store.getState().running], ['draft of B', 0, false], 'B changed');
  same(mainUntouched(), before, 'the main panel changed');
  // Late: A is closed while its prompt is out, and the send then fails. (A
  // prompt that is being sent counts as unsent: the close asks first, F1.)
  click(titled(a.panel, 'Close sub-agent panel'));
  await tick(20);
  same(confirmRows(a.panel).length, 1, 'closing A while its prompt is being sent did not ask');
  await tick(400);
  click(find(confirmRows(a.panel)[0], (n) => hasClass(n, 'ocpv2-confirm-yes')));
  await tick(30);
  expect(!panelOf('ses_q1'), 'A was not closed');
  release();
  answer(sent, null, { ok: false, status: 500, error: 'the send failed late' });
  await tick(60);
  same([inB.value, b.store.getState().messageOrder.length, b.store.getState().errors.length, b.waiting().map((i) => i.text)], ['draft of B', 0, 0, ['draft of B']], 'A\'s late failure reached B');
  // The main panel says, once, that A's prompt was not sent; nothing else of it changed.
  const said = store.getState().errors.filter((err) => err.notice);
  same([said.length, /queued for A/.test(String(said[0]?.message))], [1, true], 'what the main panel says about A\'s prompt');
  store.dismissError(said[0].id);
  same(mainUntouched(), before, 'A\'s late failure reached the main panel beyond that notice');
  typeInto(inB, ''); typeInto(mainInput, '');
});

await step('S2 permission: an answer given in sub-agent A answers A\'s request alone, also when the reply is late', async () => {
  created('ses_p1', 'ses_root', 'perm one', 700);
  created('ses_p2', 'ses_root', 'perm two', 710);
  await tick(60);
  const [a, b] = [panelOf('ses_p1'), panelOf('ses_p2')];
  emitEvent('permission.asked', { id: 'per_p1', sessionID: 'ses_p1', permission: 'bash', patterns: ['ls'] });
  emitEvent('permission.asked', { id: 'per_p2', sessionID: 'ses_p2', permission: 'bash', patterns: ['rm'] });
  await tick(30);
  same([a.store.getState().pendingPermissions.map((p) => p.id), b.store.getState().pendingPermissions.map((p) => p.id), store.getState().pendingPermissions.length],
    [['per_p1'], ['per_p2'], 0], 'each request is in its own panel');
  click(pillOf('ses_p1'));
  await tick(30);
  const release = hold((msg) => msg.type === 'permission:reply');
  const allow = labelled(a.panel, 'Allow once');
  expect(allow, 'no permission card in A');
  click(allow);
  const reply = await until(() => waiting('permission:reply')[0]);
  expect(reply, 'no reply was sent');
  same([sentOf('permission:reply').length, reply.msg.sessionId, reply.msg.permissionId, reply.msg.response], [1, 'ses_p1', 'per_p1', 'once'], 'the reply');
  // Late: B is on screen when A's reply comes back, and when OpenCode says A's request was answered.
  click(pillOf('ses_p2'));
  release();
  answer(reply, true);
  emitEvent('permission.replied', { requestID: 'per_p1', sessionID: 'ses_p1' });
  await tick(40);
  same([a.store.getState().pendingPermissions.length, b.store.getState().pendingPermissions.map((p) => p.id), store.getState().pendingPermissions.length],
    [0, ['per_p2'], 0], 'A\'s answer changed another panel');
  expect(labelled(b.panel, 'Allow once'), 'B lost its card');
  emitEvent('permission.replied', { requestID: 'per_p2', sessionID: 'ses_p2' });
});

await step('S2 confirmation: a question asked in sub-agent A is A\'s: its answer closes A alone, also when it comes late', async () => {
  created('ses_k1', 'ses_root', 'confirm one', 800);
  created('ses_k2', 'ses_root', 'confirm two', 810);
  await tick(60);
  const [a, b] = [panelOf('ses_k1'), panelOf('ses_k2')];
  click(pillOf('ses_k2')); click(pillOf('ses_k1'));
  busy('ses_k1'); busy('ses_k2');
  await tick(20);
  typeInto(inputOf(a.panel), 'waiting in A'); enter(inputOf(a.panel));
  typeInto(inputOf(b.panel), 'waiting in B'); enter(inputOf(b.panel));
  await tick(30);
  // Close asks first, in A's own panel, naming what would be discarded.
  click(titled(a.panel, 'Close sub-agent panel'));
  await tick(20);
  expect(panelOf('ses_k1'), 'A was closed without the question');
  same([confirmRows(a.panel).length, confirmRows(b.panel).length, confirmRows(mainEl).length], [1, 0, 0], 'where the question shows');
  expect(/waiting in A/.test(textOf(confirmRows(a.panel)[0])) && !/waiting in B/.test(textOf(confirmRows(a.panel)[0])), 'the question does not name A\'s prompt alone');
  // B asks its own question: A's stays armed (one question per panel, not per page).
  click(pillOf('ses_k2'));
  click(titled(b.panel, 'Close sub-agent panel'));
  await tick(20);
  same([confirmRows(a.panel).length, confirmRows(b.panel).length], [1, 1], 'B\'s question replaced A\'s');
  // B is cancelled; A's question, answered late (B is the panel on screen), closes A only.
  click(find(confirmRows(b.panel)[0], (n) => hasClass(n, 'ocpv2-confirm-no')));
  await tick(400);
  click(find(confirmRows(a.panel)[0], (n) => hasClass(n, 'ocpv2-confirm-yes')));
  await tick(40);
  expect(!panelOf('ses_k1') && !pillOf('ses_k1'), 'A was not closed by its own question');
  expect(panelOf('ses_k2') === b && pillOf('ses_k2') && b.isVisible(), 'A\'s answer closed or hid B');
  same(b.waiting().map((i) => i.text), ['waiting in B'], 'B lost its queue');
  same(confirmRows(b.panel).length, 0, 'B still shows a question');
  // A double click confirms nothing: the question stays, and nothing is closed.
  click(titled(b.panel, 'Close sub-agent panel'));
  await tick(20);
  click(find(confirmRows(b.panel)[0], (n) => hasClass(n, 'ocpv2-confirm-yes')));
  await tick(20);
  expect(panelOf('ses_k2') === b, 'one gesture closed B');
  click(find(confirmRows(b.panel)[0], (n) => hasClass(n, 'ocpv2-confirm-no')));
  idle('ses_k2');
  manager.requestOpencodeView({ hideAll: true });
});

await step('S2 late answers: a transcript read for a panel that was closed meanwhile, and a close question whose panel went with its session', async () => {
  // The transcript of a sub-agent is read when its panel is first shown. It
  // is still out when the user closes that panel.
  const release = hold((msg) => msg.type === 'session:messages' && msg.sessionId === 'ses_h1');
  created('ses_h1', 'ses_root', 'hydrating', 850);
  await tick(40);
  same(sentOf('session:messages', (msg) => msg.sessionId === 'ses_h1').length, 0, 'the transcript of a sub-agent whose panel was never shown was read');
  click(pillOf('ses_h1'));
  const read = await until(() => waiting('session:messages', (msg) => msg.sessionId === 'ses_h1')[0]);
  expect(read, 'the transcript of the sub-agent that was shown was not read');
  const h = panelOf('ses_h1');
  click(partOf(pillOf('ses_h1'), 'term-minimized-pill-close'));
  await tick(30);
  release();
  answer(read, [{ info: { id: 'msg_h1', role: 'assistant', sessionID: 'ses_h1', time: { created: 1, completed: 2 } }, parts: [] }]);
  await tick(40);
  expect(!panelOf('ses_h1') && !h.store.getState().messages.has('msg_h1'), 'a transcript was applied to a closed panel');
  // A close question is armed in a panel whose session OpenCode then deletes.
  created('ses_h2', 'ses_root', 'asked then gone', 860);
  created('ses_h3', 'ses_root', 'bystander', 870);
  await tick(60);
  const [gone, other] = [panelOf('ses_h2'), panelOf('ses_h3')];
  click(pillOf('ses_h2'));
  typeInto(inputOf(gone.panel), 'typed before the session went');
  const closing = gone.requestClose();
  await tick(20);
  same(confirmRows(gone.panel).length, 1, 'the close question');
  kept.length = 0;
  emitEvent('session.deleted', { info: { id: 'ses_h2', parentID: 'ses_root' } });
  same(await closing, false, 'the question of a panel that is gone was answered yes');
  await tick(30);
  expect(!panelOf('ses_h2') && panelOf('ses_h3') === other && pillOf('ses_h3'), 'the bystander went with it');
  // Nobody agreed to lose the draft: it is kept for the user.
  same(kept, [['asked then gone', ['typed before the session went']]], 'the draft of the panel that went');
  kept.length = 0;
});

// ── S3 ──────────────────────────────────────────────────────────────────────
await step('S3 a pill shows running, waiting for an answer, done and failed; a waiting sub-agent is noticeable on its parent too', async () => {
  created('ses_s1', 'ses_root', 'states', 900);
  await tick(60);
  const pill = pillOf('ses_s1');
  const badge = partOf(pill, 'ocpv2-pill-badge');
  expect(badge, 'the pill has no badge');
  const read = () => [pill.dataset.state, badge.dataset.kind, String(badge.textContent)];
  same(read(), ['idle', '', ''], 'a new sub-agent');
  busy('ses_s1'); await tick(20);
  same(read(), ['running', '', ''], 'running');
  expect(hasClass(pill, 'ocpv2-pill-running'), 'no running class');
  emitEvent('question.asked', { id: 'que_s1', sessionID: 'ses_s1', questions: [] }); await tick(20);
  same(read(), ['waiting', 'question', '?'], 'waiting for an answer');
  expect(hasClass(pill, 'ocpv2-pill-waiting'), 'no waiting class');
  expect(hasClass(rootPills.ses_root, 'ocpv2-pill-child-waiting') && hasClass(rootPills.ses_root, 'ocpv2-pill-has-child'), 'the parent pill does not say a sub-agent is waiting');
  emitEvent('question.replied', { requestID: 'que_s1', sessionID: 'ses_s1' });
  emitEvent('permission.asked', { id: 'per_s1', sessionID: 'ses_s1', permission: 'bash' }); await tick(20);
  same(read(), ['waiting', 'permission', '!'], 'waiting for a permission');
  emitEvent('permission.replied', { requestID: 'per_s1', sessionID: 'ses_s1' });
  says('ses_s1', 'msg_s1', 'the result');
  idle('ses_s1'); await tick(20);
  same(read(), ['done', 'done', '✓'], 'done');
  expect(!hasClass(pill, 'ocpv2-pill-running') && !hasClass(pill, 'ocpv2-pill-waiting'), 'a finished pill still looks busy');
  expect(pillOf('ses_s1') === pill, 'a finished sub-agent lost its pill');
  emitEvent('session.error', { sessionID: 'ses_s1', error: { name: 'APIError', data: { message: 'boom' } } }); await tick(20);
  same(read(), ['failed', 'error', '!'], 'failed');
  expect(!hasClass(rootPills.ses_root, 'ocpv2-pill-child-waiting'), 'the parent pill still says waiting');
});

await step('S3 many pills stay in one bounded group under the parent\'s pill', async () => {
  const before = trayEl.children.length;
  for (let i = 0; i < 30; i += 1) created(`ses_many_${i}`, 'ses_root', `many ${i}`, 1000 + i);
  await until(() => pillIds().filter((id) => id.startsWith('ses_many_')).length === 30);
  same(pillIds().filter((id) => id.startsWith('ses_many_')).length, 30, 'not every sub-agent has a pill');
  same(trayEl.children.length, before, 'the pills were added to the tray itself, one by one');
  const group = find(trayEl, (n) => hasClass(n, 'ocpv2-subagent-pills'));
  expect(group && group.parentNode === trayEl, 'no group in the tray');
  expect(trayEl.children[trayEl.children.indexOf(rootPills.ses_root) + 1] === group, 'the group is not docked under its parent\'s pill');
  const summary = find(group, (n) => hasClass(n, 'ocpv2-subagent-summary'));
  expect(summary && /^\d+ sub-agents/.test(String(summary.textContent)) && summary.hidden === false, `no count on the group: ${summary?.textContent}`);
  // One of the many waits for an answer: the count says so.
  emitEvent('question.asked', { id: 'que_many', sessionID: 'ses_many_27', questions: [] }); await tick(20);
  expect(/1 waiting/.test(String(summary.textContent)), `the count does not say one is waiting: ${summary.textContent}`);
  emitEvent('question.replied', { requestID: 'que_many', sessionID: 'ses_many_27' });
  same([main.visible, visibleIds()], [false, []], 'something opened by itself');
});

// ── S6 ──────────────────────────────────────────────────────────────────────
await step('S6 a sub-agent of a sub-agent has its own pill and panel, and its breadcrumb shows the chain of parents', async () => {
  created('ses_g1', 'ses_c2', 'grandchild', 2000);
  created('ses_gg1', 'ses_g1', 'great-grandchild', 2010);
  await tick(60);
  const [g, gg] = [panelOf('ses_g1'), panelOf('ses_gg1')];
  expect(g && gg, 'no panel for the nested sub-agents');
  same(manager.getChildPanels().filter((p) => p.sessionId.startsWith('ses_g')).map((p) => [p.sessionId, p.parentSessionId, p.rootSessionId]),
    [['ses_g1', 'ses_c2', 'ses_root'], ['ses_gg1', 'ses_g1', 'ses_root']], 'the nested panels');
  expect(pillOf('ses_g1') && pillOf('ses_gg1'), 'no pill for the nested sub-agents');
  same([pillOf('ses_g1').dataset.depth, pillOf('ses_gg1').dataset.depth], ['1', '2'], 'the depth on the pill');
  click(pillOf('ses_gg1'));
  same(visibleIds(), ['ses_gg1'], 'the nested panel did not show');
  const crumbs = all(gg.panel, (n) => hasClass(n, 'ocpv2-child-crumb'));
  same(crumbs.map((n) => n.dataset.sessionId), ['ses_root', 'ses_c2', 'ses_g1'], 'the breadcrumb');
  expect(/ROOT/.test(textOf(crumbs[0])) && /two/.test(textOf(crumbs[1])) && /grandchild/.test(textOf(crumbs[2])), `the breadcrumb does not name the parents: ${crumbs.map(textOf).join(' › ')}`);
  // A crumb of a sub-agent shows that sub-agent's panel; the first one goes back to the main panel.
  click(crumbs[1]);
  same(visibleIds(), ['ses_c2'], 'the crumb of a parent sub-agent');
  click(pillOf('ses_gg1'));
  click(crumbs[0]);
  same([main.visible, visibleIds()], [true, []], 'the crumb of the session in the main panel');
  // The main session's auto-accept reaches a nested sub-agent's request through the chain.
  store.setAutoAccept(true);
  const stop = ws.subscribeSession('ses_root', store);
  emitEvent('permission.asked', { id: 'per_gg', sessionID: 'ses_gg1', permission: 'bash', patterns: ['ls'] });
  const auto = await until(() => sentOf('permission:reply', (m) => m.permissionId === 'per_gg')[0]);
  expect(auto && auto.msg.sessionId === 'ses_gg1' && auto.msg.response === 'once', 'the nested request was not auto-accepted');
  emitEvent('permission.replied', { requestID: 'per_gg', sessionID: 'ses_gg1' });
  store.setAutoAccept(false); stop();
  manager.requestOpencodeView({ hideAll: true });
});

// ── S7 ──────────────────────────────────────────────────────────────────────
await step('S7 minimize hides the panel and keeps the pill; close removes both; neither touches the child session; a closed one comes back only when asked for', async () => {
  created('ses_m1', 'ses_root', 'closing', 3000);
  await tick(60);
  const before = requests.length;
  const m = panelOf('ses_m1');
  click(pillOf('ses_m1'));
  busy('ses_m1'); await tick(20);
  click(titled(m.panel, 'Minimize'));
  same([visibleIds(), !!pillOf('ses_m1'), panelOf('ses_m1') === m], [[], true, true], 'minimize');
  says('ses_m1', 'msg_m1', 'still followed'); await tick(20);
  expect(m.store.getState().messages.has('msg_m1'), 'a minimized panel stopped following its session');
  click(pillOf('ses_m1'));
  click(titled(m.panel, 'Close sub-agent panel'));
  await tick(30);
  same([visibleIds(), !!pillOf('ses_m1'), !!panelOf('ses_m1'), main.visible], [[], false, false, false], 'close');
  const touched = requests.slice(before).filter((r) => ['session:delete', 'message:abort', 'session:update'].includes(r.msg.type));
  same(touched.map((r) => r.msg.type), [], 'closing or minimizing touched the child session');
  // The child session goes on; nothing of it brings the panel back.
  emitEvent('session.updated', { info: { id: 'ses_m1', parentID: 'ses_root', title: 'closing' } });
  manager.bindPrimarySession(store, 'ses_root');
  await tick(60);
  expect(!panelOf('ses_m1'), 'a closed sub-agent came back by itself');
  // "Open sub-agent" on the task card does.
  expect(manager.openChildSession('ses_root', 'ses_m1') === true, 'the task card could not open the sub-agent');
  await tick(40);
  same([visibleIds(), !!pillOf('ses_m1')], [['ses_m1'], true], 'opened again');
  manager.requestOpencodeView({ hideAll: true });
});

// ── S8 ──────────────────────────────────────────────────────────────────────
await step('S8 switch: another session in the main panel swaps the set, and switching back brings the previous one back as it was', async () => {
  const setA = pillIds();
  const elementsA = childPills();
  const statesA = childPills().map((p) => [p.dataset.sessionId, p.dataset.state]);
  const panelsA = manager.getChildPanels().filter((p) => p.rootSessionId === 'ses_root').length;
  expect(setA.length > 30 && panelsA === setA.length, 'the set of session A');
  goTo('ses_b');
  await tick(40);
  same(pillIds(), [], 'the pills of the session the panel left are in the tray');
  expect(manager.getChildPanels().filter((p) => p.rootSessionId === 'ses_root').length === panelsA, 'the panels of the session the panel left were destroyed');
  // They stay live while they are away.
  busy('ses_c3'); await tick(20);
  expect(panelOf('ses_c3').store.getState().running === true, 'a panel of the other session stopped following its session');
  // Session B has a sub-agent of its own.
  created('ses_b1', 'ses_b', 'of B', 4000);
  await tick(40);
  same(pillIds(), ['ses_b1'], 'the set of session B');
  expect(hasClass(rootPills.ses_b, 'ocpv2-pill-has-child'), 'B\'s pill does not say it has a sub-agent');
  goTo('ses_root');
  await tick(40);
  same(pillIds(), setA, 'the set of session A is not back as it was');
  expect(childPills().every((p, i) => p === elementsA[i]), 'the pills were rebuilt instead of kept');
  // As it was, and current: the one sub-agent that went on while the panel was away says so.
  same(childPills().map((p) => [p.dataset.sessionId, p.dataset.state]), statesA.map(([id, was]) => [id, id === 'ses_c3' ? 'running' : was]), 'the pill states');
  idle('ses_c3');
  same([main.visible, visibleIds()], [false, []], 'a switch showed a panel');
});

await step('S7 the parent session goes: its sub-agents\' panels and pills go with it, and what was waiting there is kept when nobody was asked', async () => {
  goTo('ses_b');
  await tick(40);
  const b1 = panelOf('ses_b1');
  click(pillOf('ses_b1'));
  busy('ses_b1'); await tick(20);
  typeInto(inputOf(b1.panel), 'queued when the parent went'); enter(inputOf(b1.panel));
  typeInto(inputOf(b1.panel), 'and a draft');
  await tick(30);
  same(manager.subagentPromptsWaiting('ses_b').map((i) => i.text), ['queued when the parent went', 'and a draft'], 'what the tab\'s close question would list');
  // Deleted somewhere else: nobody could be asked.
  tabs.delete('ses_b');
  manager.releaseSubagentPanels('ses_b', { lost: true });
  await tick(30);
  same([!!panelOf('ses_b1'), pillIds(), visibleIds()], [false, [], []], 'the set of a session that is gone');
  same(kept, [['of B', ['queued when the parent went', 'and a draft']]], 'the prompts that were waiting in the sub-agent panel');
  // The set of the other session is untouched.
  goTo('ses_root');
  await tick(40);
  expect(pillIds().length > 30 && panelOf('ses_c1') === c1, 'the other session\'s set was touched');
  // A child session deleted by OpenCode takes its own panel with it.
  emitEvent('session.deleted', { info: { id: 'ses_c4', parentID: 'ses_root' } });
  await tick(30);
  expect(!panelOf('ses_c4') && !pillOf('ses_c4') && panelOf('ses_c1') === c1, 'the panel of a deleted child session');
  // Closed by the user (they were asked): everything of the set goes, nothing is kept.
  kept.length = 0;
  manager.releaseSubagentPanels('ses_root', { lost: false });
  await tick(30);
  same([manager.getChildPanels().filter((p) => p.rootSessionId === 'ses_root').length, pillIds(), kept], [0, [], []], 'the set of a tab the user closed');
  same(JSON.parse(storage.getItem('opencode-v2-subagents-closed') || '{}'), { ses_r3: 'ses_r' }, 'what is remembered as closed for sessions that are gone');
});

for (const r of requests) r.done = true;
console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.join('\n') : '\nno problems');
process.exit(0);

// The rules the review of the sub-agent panels established (docs/opencode-sidepanel.md,
// "Sub-agent panels", F1 to F10), each as the sequence the rule is about: the
// real manager, sub-agent panels, composers and socket layer under the DOM
// stand-in. Started by opencode-subagents-review.test.mjs in a child process:
// the start of this file is the page right after a reload. Prints one line per
// step and ends with "no problems" or the list.
import { installDom, makeNode } from './opencode-panel-dom.fixtures.mjs';
const { doc, FakeWS } = installDom();
// Every interval that is still running (F6: what a composer starts, it stops).
const liveIntervals = new Set();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (...args) => { const id = realSetInterval(...args); liveIntervals.add(id); return id; };
globalThis.clearInterval = (id) => { liveIntervals.delete(id); return realClearInterval(id); };

const base = new URL('../public/shared/ocp-v2/', import.meta.url).href;
const problems = [];
process.on('unhandledRejection', (err) => problems.push(`unhandledRejection: ${err?.stack?.split('\n').slice(0, 3).join(' | ') || err}`));
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (err) { problems.push(`${name}: ${err?.stack?.split('\n').slice(0, 4).join(' | ')}`); console.log('FAIL', name, '-', err?.message); } };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 1500) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return v; await tick(15); } };
const expect = (cond, message) => { if (!cond) throw new Error(message); };
const same = (actual, expected, message) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); };

const trayEl = makeNode('div'); trayEl.id = 'term-minimized-tray'; doc.body.appendChild(trayEl);

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
// The pill's ×. With nothing unsent in the panel there is no question: the
// panel is gone a moment later (the click's own continuation).
const closePill = async (sessionId) => { click(partOf(pillOf(sessionId), 'term-minimized-pill-close')); await tick(5); };
const panelOf = (sessionId) => manager.getChildPanel(sessionId);
const buttonIn = (root, pred) => find(root, (n) => n.tagName === 'BUTTON' && pred(n));
const titled = (root, title) => buttonIn(root, (n) => n.title === title);
const inputOf = (root) => find(root, (n) => n.tagName === 'TEXTAREA');
const typeInto = (input, text) => { input.value = text; input.selectionStart = input.selectionEnd = text.length; input._fire('input', { isTrusted: true }); };
const enter = (input) => input._fire('keydown', { key: 'Enter', isTrusted: true, isComposing: false, shiftKey: false });
const visibleIds = () => manager.getChildPanels().filter((p) => p.visible).map((p) => p.sessionId);
const confirmRows = (root) => all(root, (n) => hasClass(n, 'ocpv2-confirm'));
const confirmYes = (root) => find(confirmRows(root)[0], (n) => hasClass(n, 'ocpv2-confirm-yes'));
// The state readout of a sub-agent panel, in its footer toolbar (its class says the state).
const headerStatus = (panel) => find(panel, (n) => /(^| )ocpv2-status-(ready|running|awaiting|error|healing|reconnecting)( |$)/.test(String(n.className || '')));
const pillSays = (sessionId) => { const pill = pillOf(sessionId); return pill ? [pill.dataset.state, partOf(pill, 'ocpv2-pill-badge').dataset.kind] : null; };

// ── The sessions of this run ────────────────────────────────────────────────
// Session R is the one the main panel comes up on after the reload. It has
// fifteen sub-agents: twelve of its own, and three below those.
const pad = (n) => String(n).padStart(2, '0');
const TITLES = { ses_r: 'RELOADED', ses_root: 'ROOT', ses_b: 'OTHER' };
const PARENTS = {};                     // child → parent, as the server would report it
const CHILDREN = {
  ses_r: Array.from({ length: 12 }, (_, i) => ({ id: `ses_k${pad(i + 1)}`, parentID: 'ses_r', title: `kid ${pad(i + 1)}`, directory: '/work/a', time: { created: 100 + i * 10 } })),
  ses_k01: [{ id: 'ses_k01a', parentID: 'ses_k01', title: 'nested', directory: '/work/a', time: { created: 105 } }],
  ses_k01a: [{ id: 'ses_k01b', parentID: 'ses_k01a', title: 'nested twice', directory: '/work/a', time: { created: 106 } }],
  ses_k02: [{ id: 'ses_k02a', parentID: 'ses_k02', title: 'nested elsewhere', directory: '/work/a', time: { created: 115 } }],
};
for (const [parent, list] of Object.entries(CHILDREN)) for (const s of list) { PARENTS[s.id] = parent; TITLES[s.id] = s.title; }
const KIDS = Object.values(CHILDREN).flat().map((s) => s.id);
const tabs = new Set(['ses_r', 'ses_root', 'ses_b']);
// What the server would answer about them.
// (Its lists of open requests go on agreeing with the events of this run: emitEvent.)
const STATUS = { ses_k03: 'busy', ses_k04: 'busy', ses_k05: 'busy' };
let PERMISSIONS = [{ id: 'per_k04', sessionID: 'ses_k04', permission: 'bash', patterns: ['ls'] }];
let QUESTIONS = [{ id: 'que_k05', sessionID: 'ses_k05', questions: [] }];
const taskCard = (sessionId, messageID, childId, description, agent) => ({
  info: { id: messageID, role: 'assistant', sessionID: sessionId, time: { created: 1, completed: 2 } },
  parts: [{ id: `prt_${messageID}`, messageID, sessionID: sessionId, type: 'tool', tool: 'task', state: { status: 'completed', input: { description, subagent_type: agent }, metadata: { sessionId: childId } } }],
});
const TRANSCRIPTS = {
  ses_k01: [taskCard('ses_k01', 'msg_k01', 'ses_k01a', 'map the routes', 'explore')],
  ses_k01a: [taskCard('ses_k01a', 'msg_k01a', 'ses_k01b', 'read the handlers', 'general')],
  ses_k06: [{ info: { id: 'msg_k06', role: 'assistant', sessionID: 'ses_k06', time: { created: 1, completed: 2 } }, parts: [] }],
};

// ── The socket stand-in ─────────────────────────────────────────────────────
const requests = [];
const holds = new Set();
const held = (msg) => [...holds].some((pred) => pred(msg));
const defaultAnswer = (msg) => {
  switch (msg.type) {
    case 'session:get': return { id: msg.sessionId, directory: '/work/a', title: TITLES[msg.sessionId] || msg.sessionId, ...(PARENTS[msg.sessionId] ? { parentID: PARENTS[msg.sessionId] } : {}) };
    case 'session:children': return CHILDREN[msg.sessionId] || [];
    case 'session:messages': return TRANSCRIPTS[msg.sessionId] || [];
    case 'session:status': return { status: { type: STATUS[msg.sessionId] || 'idle' } };
    case 'permission:list': return PERMISSIONS;
    case 'question:list': return QUESTIONS;
    case 'session:share:policy': return { share: 'manual' };
    case 'agent:list': return [{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }];
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
const holdSend = (sessionId) => hold((msg) => msg.type === 'message:send' && msg.sessionId === sessionId);
const sendTo = (sessionId) => until(() => waiting('message:send', (m) => m.sessionId === sessionId)[0]);
const failed = (entry, error) => answer(entry, null, { ok: false, status: 500, error });
const capabilities = () => ({ data: JSON.stringify({ type: 'capabilities', capabilities: reqMod.opencodeV2WsCapabilities() }) });
const connecting = ws.connect();
let sock = FakeWS.last;
sock.readyState = 1; sock._emit('open');
await connecting;
sock._emit('message', capabilities());
const emitEvent = (eventType, event) => {
  if (eventType === 'permission.asked') PERMISSIONS = [...PERMISSIONS, event];
  if (eventType === 'permission.replied') PERMISSIONS = PERMISSIONS.filter((req) => req.id !== event.requestID);
  if (eventType === 'question.asked') QUESTIONS = [...QUESTIONS, event];
  if (eventType === 'question.replied' || eventType === 'question.rejected') QUESTIONS = QUESTIONS.filter((req) => req.id !== event.requestID);
  sock._emit('message', { data: JSON.stringify({ type: 'event', eventType, event }) });
};
const created = (id, parentID, title, at) => { PARENTS[id] = parentID; TITLES[id] = title; emitEvent('session.created', { info: { id, parentID, title, directory: '/work/a', time: { created: at } } }); };
// (The server's own answer about a session agrees with what its events said.)
const busy = (sessionId) => { STATUS[sessionId] = 'busy'; emitEvent('session.status', { sessionID: sessionId, status: { type: 'busy' } }); };
const idle = (sessionId) => { delete STATUS[sessionId]; emitEvent('session.idle', { sessionID: sessionId }); };
const asksPermission = (id, sessionId, permission = 'bash') => emitEvent('permission.asked', { id, sessionID: sessionId, permission, patterns: ['ls'] });
const asksQuestion = (id, sessionId) => emitEvent('question.asked', { id, sessionID: sessionId, questions: [] });
const taskPart = (parentId, childId, description = 'do it', agent = 'explore') => emitEvent('message.part.updated', {
  sessionID: parentId,
  part: { id: `prt_task_${childId}`, messageID: `msg_task_${childId}`, sessionID: parentId, type: 'tool', tool: 'task', state: { status: 'running', input: { description, subagent_type: agent }, metadata: { sessionId: childId } } },
});

// ── The main panel: its store, its composer, its view in the shared slot ────
const store = state.createPanelStore();
function goTo(sessionId) {
  store.clearMessages();
  store.setSession(sessionId, sessionId ? { id: sessionId, title: TITLES[sessionId], directory: '/work/a' } : null);
  manager.bindPrimarySession(store, sessionId);
}
// Each step says which session the main panel is on (a step that failed half-way
// leaves no state behind for the next one).
async function onSession(sessionId) {
  store.setAutoAccept(false);
  if (store.getState().sessionId !== sessionId) { goTo(sessionId); await tick(40); }
}
store.setSession('ses_r', { id: 'ses_r', title: 'RELOADED', directory: '/work/a' });
const mainEl = makeNode('div'); doc.body.appendChild(mainEl);
const mainCompose = makeNode('div'); mainEl.appendChild(mainCompose);
send.mountCompose(mainCompose, store, { pickers: false });
function slotPanel(owner, provider, onApply = () => {}) {
  const element = makeNode('div'); const header = makeNode('div'); const actions = makeNode('div');
  header.appendChild(actions); element.appendChild(header); doc.body.appendChild(element);
  const view = { owner, visible: false };
  windows.registerSidepanel({ owner, provider, element, header, actions, buttonClass: 'x-btn', applyVisibility: (v) => { view.visible = !!v; onApply(view.visible); } });
  return view;
}
const main = slotPanel('ocp-v2-panel', 'opencode', (v) => shared.emit('opencode-panel:visibility', v));
manager.registerMainView({ owner: 'ocp-v2-panel', isVisible: () => main.visible });
shared.on('opencode-panel:request-show', () => manager.requestOpencodeView({ show: MAIN_VIEW }));
function tabPill(sessionId) {
  const pill = makeNode('div');
  pill.classList.add('term-minimized-pill', 'ocpv2-session-pill');
  pill.dataset.owner = 'ocp-v2-panel'; pill.dataset.sessionId = sessionId;
  trayEl.appendChild(pill);
  return pill;
}
for (const id of tabs) tabPill(id);
const kept = [];                        // prompts the manager hands back when a panel went away by itself
// What the main panel says and keeps saying until it is dismissed.
const notices = () => store.getState().errors.filter((err) => err.notice).map((err) => String(err.message));
const attachmentsOf = (panel) => panel.store.getState().attachedImages.map((img) => img.name);
const image = (name) => ({ name, mime: 'image/png', dataUrl: `data:image/png;base64,${Buffer.from(name).toString('base64')}` });

// ── F10: the first thing the page does after a reload ───────────────────────
await step('F10 reload: fifteen sub-agents cost what their pills need, and a transcript is read when its panel is first shown', async () => {
  // The user opened OpenCode: the main panel is on screen, on session R.
  windows.setSidepanelVisible('ocp-v2-panel', true);
  manager.bindPrimarySession(store, 'ses_r');
  manager.registerPrimaryPanel({
    panelId: 'ocp-v2-panel', store, getSessionId: () => store.getState().sessionId,
    ownsSession: (sid) => tabs.has(sid), keepPrompts: (items, label) => kept.push([label, items.map((i) => i.text)]),
  });
  await until(() => manager.getChildPanels().length >= 15);
  await until(() => sentOf('question:list', (m) => KIDS.includes(m.sessionId)).length >= 15, 2500);
  await tick(200);
  same(manager.getChildPanels().length, 15, 'a panel per sub-agent');
  same([main.visible, visibleIds()], [true, []], 'nothing is shown but the main panel');
  const of = (type) => sentOf(type, (m) => KIDS.includes(m.sessionId)).length;
  same({ tree: sentOf('session:children').length, status: of('session:status'), permissions: of('permission:list'), questions: of('question:list'), info: of('session:get'), transcripts: of('session:messages'), todos: of('session:todo') },
    { tree: 16, status: 15, permissions: 15, questions: 15, info: 0, transcripts: 0, todos: 0 }, 'the requests for fifteen sub-agents before any panel is shown');
  // The pills say what there is to say without a transcript.
  same(['ses_k03', 'ses_k04', 'ses_k05', 'ses_k06'].map(pillSays), [['running', ''], ['waiting', 'permission'], ['waiting', 'question'], ['done', 'done']], 'what the pills say');
  expect(/kid 06/.test(textOf(pillOf('ses_k06'))), 'the pill is not named from what the server listed');
  // The first time a panel is shown, its session is read: info, transcript, todos.
  click(pillOf('ses_k06'));
  await until(() => panelOf('ses_k06').store.getState().messages.has('msg_k06'));
  expect(panelOf('ses_k06').store.getState().messages.has('msg_k06'), 'the transcript of the panel that was shown was not read');
  same(sentOf('session:messages').map((r) => r.msg.sessionId), ['ses_k06'], 'whose transcript was read');
  same([of('session:get'), of('session:todo')], [1, 1], 'what else was read for it');
  // Once: showing it again reads nothing.
  click(pillOf('ses_k06')); click(pillOf('ses_k06'));
  await tick(60);
  same(sentOf('session:messages').length, 1, 'a panel that was shown before was read again');
  manager.requestOpencodeView({ show: MAIN_VIEW });
});

// ── F9 ──────────────────────────────────────────────────────────────────────
await step('F9 a sub-agent of a sub-agent shows its task brief, which is in its parent\'s transcript', async () => {
  // Its parent (k01) has a pill and was never shown: its transcript holds the task card.
  click(pillOf('ses_k01a'));
  const nested = panelOf('ses_k01a');
  await until(() => /map the routes/.test(String(headerStatus(nested.panel)?.textContent)));
  same(String(headerStatus(nested.panel)?.textContent), 'explore · map the routes', 'the header of a nested sub-agent');
  expect(/map the routes/.test(String(pillOf('ses_k01a').getAttribute('data-tooltip'))), 'the pill does not say what the sub-agent is for');
  // One more level down: the brief is in the transcript of the sub-agent that was just shown.
  click(pillOf('ses_k01b'));
  const deeper = panelOf('ses_k01b');
  await until(() => /read the handlers/.test(String(headerStatus(deeper.panel)?.textContent)));
  same(String(headerStatus(deeper.panel)?.textContent), 'general · read the handlers', 'the header of a sub-agent two levels down');
  manager.requestOpencodeView({ show: MAIN_VIEW });
});

// ── F4 ──────────────────────────────────────────────────────────────────────
await step('F4 reload: auto-accept reaches a sub-agent through a parent that has no panel, by the links the server listed', async () => {
  await onSession('ses_r');
  // R → k01 → k01a → k01b: the user closes the panel in the middle.
  await closePill('ses_k01a');
  await tick(30);
  expect(!panelOf('ses_k01a') && panelOf('ses_k01b'), 'the panel in the middle was not closed alone');
  store.setAutoAccept(true);
  asksPermission('per_k01b', 'ses_k01b');
  const auto = await until(() => sentOf('permission:reply', (m) => m.permissionId === 'per_k01b')[0]);
  expect(auto && auto.msg.sessionId === 'ses_k01b' && auto.msg.response === 'once', 'the request of a sub-agent below a closed panel was not answered by the standing auto-accept');
  emitEvent('permission.replied', { requestID: 'per_k01b', sessionID: 'ses_k01b' });
  store.setAutoAccept(false);
});

await step('F4 live: closing the panel between a sub-agent and the main session does not end the inherited auto-accept', async () => {
  await onSession('ses_root');
  store.setAutoAccept(true);
  created('ses_6a', 'ses_root', 'A', 6000);
  created('ses_6b', 'ses_6a', 'B', 6010);
  await tick(60);
  await closePill('ses_6a');
  await tick(30);
  expect(!panelOf('ses_6a') && panelOf('ses_6b'), 'A was not closed alone');
  asksPermission('per_6b', 'ses_6b');
  const auto = await until(() => sentOf('permission:reply', (m) => m.permissionId === 'per_6b')[0]);
  expect(auto && auto.msg.sessionId === 'ses_6b' && auto.msg.response === 'once', 'B asks by hand although the main session auto-accepts');
  emitEvent('permission.replied', { requestID: 'per_6b', sessionID: 'ses_6b' });
  // What never is answered automatically still asks.
  asksPermission('per_6b_loop', 'ses_6b', 'doom_loop');
  await tick(60);
  same([sentOf('permission:reply', (m) => m.permissionId === 'per_6b_loop').length, panelOf('ses_6b').store.getState().pendingPermissions.map((p) => p.id)], [0, ['per_6b_loop']], 'a doom_loop request');
  emitEvent('permission.replied', { requestID: 'per_6b_loop', sessionID: 'ses_6b' });
  // The switch off again: nothing is inherited.
  store.setAutoAccept(false);
  asksPermission('per_6b_off', 'ses_6b');
  await tick(80);
  same(sentOf('permission:reply', (m) => m.permissionId === 'per_6b_off').length, 0, 'answered automatically with the switch off');
  emitEvent('permission.replied', { requestID: 'per_6b_off', sessionID: 'ses_6b' });
});

// ── F5 ──────────────────────────────────────────────────────────────────────
const pendingIn = (s) => [s.getState().pendingPermissions.map((p) => p.id), s.getState().pendingQuestions.map((q) => q.id)];
await step('F5 a request that waits in a sub-agent\'s panel shows in the main panel the moment that panel is closed', async () => {
  await onSession('ses_root');
  created('ses_5a', 'ses_root', 'asks', 5000);
  await tick(40);
  asksPermission('per_5a', 'ses_5a');
  asksQuestion('que_5a', 'ses_5a');
  await tick(30);
  same([pendingIn(panelOf('ses_5a').store), pendingIn(store)], [[['per_5a'], ['que_5a']], [[], []]], 'the requests are in the sub-agent\'s own panel');
  await closePill('ses_5a');
  // At once: no reload, reconnect or tab switch in between.
  same(pendingIn(store), [['per_5a'], ['que_5a']], 'the requests of the closed panel are out of sight');
  expect(!panelOf('ses_5a'), 'the panel was not closed');
  // Answered there, they leave it like any request of a sub-agent without a panel.
  emitEvent('permission.replied', { requestID: 'per_5a', sessionID: 'ses_5a' });
  emitEvent('question.replied', { requestID: 'que_5a', sessionID: 'ses_5a' });
  await tick(20);
  same(pendingIn(store), [[], []], 'the answered requests stayed');
});

await step('F5 nested: the request goes to the nearest parent that has a panel, and on to the next when that one is closed too', async () => {
  await onSession('ses_root');
  created('ses_5p', 'ses_root', 'parent', 5100);
  created('ses_5q', 'ses_5p', 'child', 5110);
  await tick(60);
  asksPermission('per_5q', 'ses_5q');
  await tick(30);
  await closePill('ses_5q');
  same([pendingIn(panelOf('ses_5p').store)[0], pendingIn(store)[0]], [['per_5q'], []], 'where the request of the closed child went');
  await closePill('ses_5p');
  same(pendingIn(store)[0], ['per_5q'], 'the request was lost with the second panel');
  emitEvent('permission.replied', { requestID: 'per_5q', sessionID: 'ses_5q' });
});

await step('F5 link: a sub-agent the socket layer has no parent link for is looked up, and its request shows after that', async () => {
  await onSession('ses_root');
  // Announced by the task tool's part only: no session event carried its parent.
  PARENTS.ses_5t = 'ses_root'; TITLES.ses_5t = 'by its task card';
  taskPart('ses_root', 'ses_5t');
  await tick(40);
  expect(panelOf('ses_5t'), 'no panel for the sub-agent the task card named');
  asksPermission('per_5t', 'ses_5t');
  await tick(30);
  same(pendingIn(panelOf('ses_5t').store)[0], ['per_5t'], 'the request is in its panel');
  await closePill('ses_5t');
  await until(() => pendingIn(store)[0].includes('per_5t'));
  same(pendingIn(store)[0], ['per_5t'], 'the request of the closed panel never showed');
  emitEvent('permission.replied', { requestID: 'per_5t', sessionID: 'ses_5t' });
  await tick(20);
  same(pendingIn(store)[0], [], 'the answered request stayed');
  // Late: a request that is answered while its chain of parents is being read is not shown.
  PARENTS.ses_5v = 'ses_root'; TITLES.ses_5v = 'answered meanwhile';
  taskPart('ses_root', 'ses_5v');
  await tick(40);
  asksPermission('per_5v', 'ses_5v');
  await tick(30);
  const release = hold((msg) => msg.type === 'session:get' && msg.sessionId === 'ses_5v');
  await closePill('ses_5v');
  const lookup = await until(() => waiting('session:get', (m) => m.sessionId === 'ses_5v')[0]);
  expect(lookup, 'the chain of parents was not read');
  emitEvent('permission.replied', { requestID: 'per_5v', sessionID: 'ses_5v' });
  release();
  answer(lookup, defaultAnswer(lookup.msg));
  await tick(60);
  same(pendingIn(store)[0], [], 'a request that was answered meanwhile showed as a card');
});

// ── F7 ──────────────────────────────────────────────────────────────────────
await step('F7 a parent link that arrives late places the sub-agents that were waiting for it', async () => {
  await onSession('ses_root');
  PARENTS.ses_7a = 'ses_root'; TITLES.ses_7a = 'late parent';
  // A is announced without its parent; B names A, C names B: neither can be placed yet.
  emitEvent('session.created', { info: { id: 'ses_7a', title: 'late parent', directory: '/work/a', time: { created: 7000 } } });
  created('ses_7b', 'ses_7a', 'waited', 7010);
  created('ses_7c', 'ses_7b', 'waited below', 7020);
  await tick(40);
  same(['ses_7a', 'ses_7b', 'ses_7c'].map((id) => !!panelOf(id)), [false, false, false], 'placed without a parent');
  // The missing link arrives. Neither B nor C says anything again.
  emitEvent('session.updated', { info: { id: 'ses_7a', parentID: 'ses_root', title: 'late parent', time: { created: 7000 } } });
  await tick(60);
  same(manager.getChildPanels().filter((p) => p.sessionId.startsWith('ses_7')).map((p) => [p.sessionId, p.parentSessionId, p.rootSessionId]),
    [['ses_7a', 'ses_root', 'ses_root'], ['ses_7b', 'ses_7a', 'ses_root'], ['ses_7c', 'ses_7b', 'ses_root']], 'the sub-agents that were waiting for the link');
  same(pillIds().filter((id) => id.startsWith('ses_7')), ['ses_7a', 'ses_7b', 'ses_7c'], 'their pills, in the order they were started');
  expect(/waited below/.test(textOf(pillOf('ses_7c'))), 'the pill of a sub-agent that waited lost its name');
});

// ── F3 ──────────────────────────────────────────────────────────────────────
const exists3 = (...ids) => ids.map((id) => !!panelOf(id) || !!pillOf(id));
await step('F3 after: a session that becomes an automation\'s takes every panel and pill below it, at any depth', async () => {
  await onSession('ses_root');
  created('ses_3a', 'ses_root', 'A', 3000);
  created('ses_3b', 'ses_3a', 'B', 3010);
  created('ses_3c', 'ses_3b', 'C', 3020);
  await tick(60);
  same(exists3('ses_3a', 'ses_3b', 'ses_3c'), [true, true, true], 'R, A, B, C');
  click(pillOf('ses_3c'));
  same(visibleIds(), ['ses_3c'], 'C is on screen');
  ownership.registerAutomationSession('ses_3a', 'run_3');
  await tick(40);
  same([exists3('ses_3a', 'ses_3b', 'ses_3c'), visibleIds()], [[false, false, false], []], 'what is left of the automation\'s session and the sub-agents below it');
  // Nothing brings one back: an event, the task tool's part, a deeper sub-agent, a task card.
  emitEvent('session.updated', { info: { id: 'ses_3c', parentID: 'ses_3b', title: 'C' } });
  taskPart('ses_3b', 'ses_3c');
  created('ses_3d', 'ses_3c', 'D', 3030);
  same([manager.openChildSession('ses_3b', 'ses_3c'), manager.openChildSession('ses_3a', 'ses_3b'), manager.openChildSession('ses_root', 'ses_3a')], [false, false, false], 'a task card opened an automation\'s sub-agent');
  await tick(40);
  same([exists3('ses_3a', 'ses_3b', 'ses_3c', 'ses_3d'), visibleIds()], [[false, false, false, false], []], 'something came back');
  // Nor does a link that is only claimed: a tool part or a task card of the
  // main session that names C as its own sub-agent. The server said whose it is.
  taskPart('ses_root', 'ses_3c');
  emitEvent('message.part.updated', { sessionID: 'ses_root', part: { id: 'prt_forged', messageID: 'msg_forged', sessionID: 'ses_root', type: 'tool', tool: 'anything', state: { status: 'running', input: { sessionId: 'ses_3d' } } } });
  same(manager.openChildSession('ses_root', 'ses_3c'), false, 'a claimed link opened an automation\'s sub-agent');
  await tick(40);
  same([exists3('ses_3a', 'ses_3b', 'ses_3c', 'ses_3d'), visibleIds()], [[false, false, false, false], []], 'a claimed parent link brought an automation\'s sub-agent back');
});

await step('F3 before: a session that already is an automation\'s gets nothing, and neither does anything that starts below it', async () => {
  await onSession('ses_root');
  ownership.registerAutomationSession('ses_4a', 'run_4');
  created('ses_4a', 'ses_root', 'A', 4000);
  created('ses_4b', 'ses_4a', 'B', 4010);
  created('ses_4c', 'ses_4b', 'C', 4020);
  taskPart('ses_4b', 'ses_4c');
  await tick(60);
  same(exists3('ses_4a', 'ses_4b', 'ses_4c'), [false, false, false], 'an automation\'s session and its sub-agents');
  same(manager.openChildSession('ses_4b', 'ses_4c'), false, 'a task card opened an automation\'s sub-agent');
});

await step('F3 between: sub-agents that start after their ancestor became an automation\'s get nothing either', async () => {
  await onSession('ses_root');
  created('ses_8a', 'ses_root', 'A', 8000);
  created('ses_8b', 'ses_8a', 'B', 8010);
  await tick(60);
  ownership.registerAutomationSession('ses_8a', 'run_8');
  created('ses_8c', 'ses_8b', 'C', 8020);
  created('ses_8d', 'ses_8c', 'D', 8030);
  await tick(60);
  same(exists3('ses_8a', 'ses_8b', 'ses_8c', 'ses_8d'), [false, false, false, false], 'an automation\'s session and its sub-agents');
  // The sub-agents of the other sessions are untouched.
  expect(panelOf('ses_6b') && pillOf('ses_7c'), 'the panels of other sessions went with them');
});

// ── F1 ──────────────────────────────────────────────────────────────────────
await step('F1 close: a prompt that is being sent counts as unsent; closed after the question, it is kept when the send fails', async () => {
  await onSession('ses_root');
  created('ses_u1', 'ses_root', 'unsent one', 9000);
  await tick(40);
  const u1 = panelOf('ses_u1');
  click(pillOf('ses_u1'));
  busy('ses_u1'); await tick(20);
  u1.store.addAttachedImage(image('shot.png'));
  typeInto(inputOf(u1.panel), 'queued with a file'); enter(inputOf(u1.panel));
  await tick(30);
  const release = holdSend('ses_u1');
  idle('ses_u1');
  const sent = await sendTo('ses_u1');
  expect(sent, 'the queued prompt was not sent');
  // On its way, not accepted yet: it is still this panel's.
  same(u1.waiting().map((i) => i.text), ['queued with a file'], 'what is unsent in the panel while its prompt is being sent');
  click(titled(u1.panel, 'Close sub-agent panel'));
  await tick(20);
  expect(panelOf('ses_u1') === u1 && confirmRows(u1.panel).length === 1, 'the panel closed without asking');
  expect(/queued with a file/.test(textOf(confirmRows(u1.panel)[0])), 'the question does not name the prompt');
  await tick(400);
  click(confirmYes(u1.panel));
  await tick(40);
  expect(!panelOf('ses_u1'), 'the owner confirmed the close');
  const before = notices().length;
  release();
  failed(sent, 'the model is gone');
  await tick(60);
  same(notices().length - before, 1, 'the main panel says that a prompt to that sub-agent was not sent');
  expect(/unsent one/.test(notices().at(-1)) && /queued with a file/.test(notices().at(-1)), `the notice does not name the sub-agent and the prompt: ${notices().at(-1)}`);
  // "Open sub-agent" on its task card: the prompt and its attachment are back in the box.
  same(manager.openChildSession('ses_root', 'ses_u1'), true, 'the sub-agent could not be opened again');
  await tick(40);
  const again = panelOf('ses_u1');
  expect(again && again !== u1, 'no new panel');
  same([inputOf(again.panel).value, attachmentsOf(again)], ['queued with a file', ['shot.png']], 'what is back in the compose box');
  same(notices().length - before, 1, 'the main panel said it more than once');
  // It is that panel's draft now: closing it asks.
  same(again.waiting().map((i) => i.text), ['queued with a file'], 'the draft that came back');
  manager.requestOpencodeView({ hideAll: true });
});

await step('F1 tab: the parent\'s tab is closed while a sub-agent\'s prompt is being sent, and the send fails', async () => {
  await onSession('ses_b');
  created('ses_u2', 'ses_b', 'unsent two', 9100);
  await tick(40);
  const u2 = panelOf('ses_u2');
  click(pillOf('ses_u2'));
  u2.store.addAttachedImage(image('log.png'));
  const release = holdSend('ses_u2');
  typeInto(inputOf(u2.panel), 'sent by hand'); enter(inputOf(u2.panel));
  const sent = await sendTo('ses_u2');
  expect(sent, 'the prompt was not sent');
  // The tab's close question lists what is unsent in its sub-agents' panels.
  same(manager.subagentPromptsWaiting('ses_b').map((i) => i.text), ['sent by hand'], 'what the tab\'s close question lists');
  kept.length = 0;
  const before = notices().length;
  manager.releaseSubagentPanels('ses_b', { lost: false });
  await tick(30);
  expect(!panelOf('ses_u2'), 'the panel did not go with its parent\'s tab');
  release();
  failed(sent, 'gone with its tab');
  await tick(60);
  same([notices().length - before, kept], [1, []], 'what the main panel says');
  // The tab is opened again, and the sub-agent from its task card.
  same(manager.openChildSession('ses_b', 'ses_u2'), true, 'the sub-agent could not be opened again');
  await tick(40);
  same([inputOf(panelOf('ses_u2').panel).value, attachmentsOf(panelOf('ses_u2'))], ['sent by hand', ['log.png']], 'what is back in the compose box');
  same(notices().length - before, 1, 'the main panel said it more than once');
  manager.requestOpencodeView({ hideAll: true });
});

await step('F1 deleted: the sub-agent\'s session is deleted elsewhere while its prompt is being sent, and the send fails', async () => {
  await onSession('ses_root');
  created('ses_u3', 'ses_root', 'unsent three', 9200);
  await tick(40);
  const u3 = panelOf('ses_u3');
  click(pillOf('ses_u3'));
  busy('ses_u3'); await tick(20);
  u3.store.addAttachedImage(image('trace.png'));
  typeInto(inputOf(u3.panel), 'queued then deleted'); enter(inputOf(u3.panel));
  typeInto(inputOf(u3.panel), 'still a draft');
  await tick(30);
  const release = holdSend('ses_u3');
  idle('ses_u3');
  const sent = await sendTo('ses_u3');
  expect(sent, 'the queued prompt was not sent');
  kept.length = 0;
  const before = notices().length;
  emitEvent('session.deleted', { info: { id: 'ses_u3', parentID: 'ses_root' } });
  await tick(30);
  expect(!panelOf('ses_u3'), 'the panel did not go with its session');
  // What was waiting is kept at once (nobody was asked); what is on its way has no outcome yet.
  same(kept, [['unsent three', ['still a draft']]], 'what is kept when the panel goes');
  release();
  failed(sent, 'no such session');
  await tick(60);
  same(notices().length - before, 1, 'the main panel says that a prompt to that sub-agent was not sent');
  same(manager.openChildSession('ses_root', 'ses_u3'), true, 'the sub-agent could not be opened again');
  await tick(40);
  same([inputOf(panelOf('ses_u3').panel).value, attachmentsOf(panelOf('ses_u3'))], ['queued then deleted', ['trace.png']], 'what is back in the compose box');
  same(notices().length - before, 1, 'the main panel said it more than once');
  manager.requestOpencodeView({ hideAll: true });
});

await step('F1 accepted: once OpenCode has the prompt it is no longer unsent, and nothing is kept for a send that went through', async () => {
  await onSession('ses_root');
  created('ses_u4', 'ses_root', 'accepted', 9300);
  await tick(40);
  const u4 = panelOf('ses_u4');
  click(pillOf('ses_u4'));
  const release = holdSend('ses_u4');
  typeInto(inputOf(u4.panel), 'goes through'); enter(inputOf(u4.panel));
  const sent = await sendTo('ses_u4');
  same(u4.waiting().map((i) => i.text), ['goes through'], 'what is unsent while the prompt is on its way');
  // OpenCode's own copy of the prompt arrives before the reply to the send does.
  emitEvent('message.updated', { sessionID: 'ses_u4', info: { id: 'msg_u4', role: 'user', sessionID: 'ses_u4', time: { created: Date.now() } } });
  emitEvent('message.part.updated', { sessionID: 'ses_u4', part: { id: 'prt_u4', messageID: 'msg_u4', sessionID: 'ses_u4', type: 'text', text: 'goes through' } });
  await tick(30);
  same(u4.waiting().map((i) => i.text), [], 'a prompt OpenCode has accepted is still counted as unsent');
  const before = notices().length;
  click(titled(u4.panel, 'Close sub-agent panel'));
  await tick(30);
  expect(!panelOf('ses_u4'), 'closing asked about a prompt that was accepted');
  release();
  answer(sent, true);
  await tick(60);
  same(notices().length - before, 0, 'the main panel reported a prompt that was sent');
  same(manager.openChildSession('ses_root', 'ses_u4'), true, 'the sub-agent could not be opened again');
  await tick(40);
  same(inputOf(panelOf('ses_u4').panel).value, '', 'a prompt that was sent came back into the box');
  manager.requestOpencodeView({ hideAll: true });
});

await step('F1 answer: a close that was confirmed for a prompt on its way is asked again when that send has failed meanwhile', async () => {
  await onSession('ses_root');
  created('ses_u5', 'ses_root', 'failed before the answer', 9350);
  await tick(40);
  const u5 = panelOf('ses_u5');
  click(pillOf('ses_u5'));
  const release = holdSend('ses_u5');
  typeInto(inputOf(u5.panel), 'failed while asked'); enter(inputOf(u5.panel));
  const sent = await sendTo('ses_u5');
  click(titled(u5.panel, 'Close sub-agent panel'));
  await tick(20);
  expect(/being sent/.test(textOf(confirmRows(u5.panel)[0])), 'the question does not say that the prompt is on its way');
  // The send fails while the question is up: the prompt is back in the box, unsent.
  release();
  failed(sent, 'failed while the question was up');
  await tick(420);
  same(inputOf(u5.panel).value, 'failed while asked', 'the prompt that failed in place');
  // The answer was given for a prompt that would go on being sent. It is not that any more.
  click(confirmYes(u5.panel));
  await tick(40);
  expect(panelOf('ses_u5') === u5, 'the panel closed, and the prompt that had failed went with it');
  expect(confirmRows(u5.panel).length === 1 && !/being sent/.test(textOf(confirmRows(u5.panel)[0])), 'the question was not asked again for what is unsent now');
  click(find(confirmRows(u5.panel)[0], (n) => hasClass(n, 'ocpv2-confirm-no')));
  await tick(20);
  same([panelOf('ses_u5') === u5, inputOf(u5.panel).value], [true, 'failed while asked'], 'after Cancel');
  typeInto(inputOf(u5.panel), '');
  manager.requestOpencodeView({ hideAll: true });
});

await step('F1 reach: the notice opens the sub-agent, and a prompt whose sub-agent cannot be opened any more is kept in the main panel', async () => {
  await onSession('ses_root');
  const said = () => store.getState().errors.filter((err) => err.notice && /was on its way/.test(String(err.message)));
  for (const err of said()) store.dismissError(err.id);
  // One whose parent is still a tab: the notice's own button opens it.
  created('ses_u6', 'ses_root', 'reachable', 9360);
  await tick(40);
  click(pillOf('ses_u6'));
  let release = holdSend('ses_u6');
  typeInto(inputOf(panelOf('ses_u6').panel), 'open me again'); enter(inputOf(panelOf('ses_u6').panel));
  let sent = await sendTo('ses_u6');
  emitEvent('session.deleted', { info: { id: 'ses_u6', parentID: 'ses_root' } });
  release(); failed(sent, 'gone');
  await tick(60);
  same(said().map((err) => (err.actions || []).map((a) => a.label)), [['Open sub-agent']], 'what the notice offers');
  said()[0].actions[0].run(said()[0]);
  await tick(40);
  same([inputOf(panelOf('ses_u6')?.panel)?.value, visibleIds(), said().length], ['open me again', ['ses_u6'], 0], 'after "Open sub-agent"');
  manager.requestOpencodeView({ hideAll: true });
  // One whose parent's tab was closed and is no tab any more: it cannot be opened.
  tabs.add('ses_c'); TITLES.ses_c = 'CLOSED TAB';
  created('ses_u7', 'ses_c', 'unreachable', 9370);
  await tick(40);
  expect(panelOf('ses_u7'), 'no panel for the sub-agent of another tab');
  manager.requestOpencodeView({ show: panelOf('ses_u7').panelId });
  release = holdSend('ses_u7');
  typeInto(inputOf(panelOf('ses_u7').panel), 'nowhere to go back to'); enter(inputOf(panelOf('ses_u7').panel));
  sent = await sendTo('ses_u7');
  tabs.delete('ses_c');
  manager.releaseSubagentPanels('ses_c', { lost: false });
  kept.length = 0;
  release(); failed(sent, 'gone with its tab');
  await tick(60);
  same(said().length, 1, 'the main panel says that the prompt was not sent');
  said()[0].actions[0].run(said()[0]);
  await tick(40);
  // Kept on a notice of the main panel instead (Put back / Discard), not left where nobody can get it.
  same([kept, said().length, !!panelOf('ses_u7')], [[['unreachable', ['nowhere to go back to']]], 0, false], 'a prompt whose sub-agent cannot be opened');
  manager.requestOpencodeView({ hideAll: true });
});

// ── F6 ──────────────────────────────────────────────────────────────────────
await step('F6 plan: a closed panel\'s composer is no longer registered with the plan lifecycle', async () => {
  await onSession('ses_root');
  created('ses_p1', 'ses_root', 'planned', 9400);
  created('ses_p2', 'ses_root', 'still open', 9410);
  await tick(60);
  const [gone, open] = [panelOf('ses_p1'), panelOf('ses_p2')];
  click(pillOf('ses_p1')); click(pillOf('ses_p2'));        // both were shown: both have a composer
  await closePill('ses_p1');
  await tick(30);
  expect(!panelOf('ses_p1'), 'the panel was not closed');
  // The plan editor saves a plan for each of the two sessions.
  shared.emit('plan-saved', { filePath: '/tmp/p1.md', content: 'A PLAN FOR A CLOSED PANEL', source: 'opencode', tabId: 'ses_p1' });
  shared.emit('plan-saved', { filePath: '/tmp/p2.md', content: 'A PLAN FOR AN OPEN PANEL', source: 'opencode', tabId: 'ses_p2' });
  await tick(20);
  same([open.store.getState().editedPlanContent, open.store.getState().showPostPlanActions], ['A PLAN FOR AN OPEN PANEL', true], 'the open panel\'s plan');
  same([gone.store.getState().editedPlanContent || '', !!gone.store.getState().showPostPlanActions], ['', false], 'the plan lifecycle still visits the closed panel');
  open.store.clearPlanState?.();
  manager.requestOpencodeView({ hideAll: true });
});

await step('F6 timers: what a composer started for a turn stops when its panel is closed', async () => {
  await onSession('ses_root');
  created('ses_p3', 'ses_root', 'running turn', 9500);
  await tick(40);
  const p3 = panelOf('ses_p3');
  click(pillOf('ses_p3'));
  await tick(30);
  const before = liveIntervals.size;
  const release = holdSend('ses_p3');
  typeInto(inputOf(p3.panel), 'a turn that goes on'); enter(inputOf(p3.panel));
  const sent = await sendTo('ses_p3');
  release();
  answer(sent, true, { async: true });     // accepted; the turn runs on
  await tick(40);
  expect(liveIntervals.size > before, 'the composer does not watch its running turn');
  await closePill('ses_p3');
  await tick(40);
  expect(!panelOf('ses_p3'), 'the panel was not closed');
  same(liveIntervals.size, before, 'the transcript poll of the closed panel still runs');
});

// ── F8 ──────────────────────────────────────────────────────────────────────
await step('F8 the group of pills takes the room the other pills leave, however little, and never more', async () => {
  await onSession('ses_root');
  const group = find(trayEl, (n) => hasClass(n, 'ocpv2-subagent-pills'));
  expect(group && group.parentNode === trayEl && pillIds().length >= 3, 'no group of pills in the tray');
  const summary = find(group, (n) => hasClass(n, 'ocpv2-subagent-summary'));
  const layout = async ({ top, trayHeight, groupHeight }) => {
    trayEl.getBoundingClientRect = () => ({ top, left: 0, right: 0, bottom: top + trayHeight, width: 200, height: trayHeight });
    group.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 200, height: groupHeight });
    window.dispatchEvent(new Event('resize'));
    await tick(40);
    return group.style.maxHeight;
  };
  // A 900 px window; the tray starts at 60 px; the other pills take 720 px: 108 px are left.
  same(await layout({ top: 60, trayHeight: 820, groupHeight: 100 }), '108px', 'the height of the group when less than three rows are left');
  expect(summary.hidden === false, 'a group that cannot show its pills does not say how many there are');
  // The other pills fill the window: nothing is left, and the group takes nothing.
  same(await layout({ top: 60, trayHeight: 940, groupHeight: 100 }), '0px', 'the height of the group when nothing is left');
  // Room again: eight rows at most.
  same(await layout({ top: 60, trayHeight: 200, groupHeight: 100 }), '310px', 'the height of the group with room to spare');
});

// ── F10, again: the socket comes back ───────────────────────────────────────
await step('F10 reconnect: a panel that was shown is read again, a pill reads what a pill needs', async () => {
  await onSession('ses_r');
  await tick(60);
  const before = requests.length;
  const old = sock;
  old._emit('close');
  await until(() => FakeWS.last !== old, 3000);
  expect(FakeWS.last !== old, 'the socket did not reconnect');
  sock = FakeWS.last;
  sock.readyState = 1; sock._emit('open');
  sock._emit('message', capabilities());
  const since = (type, sessionId) => requests.slice(before).filter((r) => r.msg.type === type && r.msg.sessionId === sessionId).length;
  await until(() => since('session:status', 'ses_k12') >= 1 && since('session:messages', 'ses_k06') >= 1, 2500);
  await tick(100);
  // k06 was shown: its transcript is read again. k07 never was: its pill needs its status and its requests.
  same([since('session:messages', 'ses_k06'), since('session:get', 'ses_k06')], [1, 1], 'the panel that was shown');
  same([since('session:messages', 'ses_k07'), since('session:get', 'ses_k07'), since('session:todo', 'ses_k07'), since('session:status', 'ses_k07'), since('permission:list', 'ses_k07'), since('question:list', 'ses_k07')],
    [0, 0, 0, 1, 1, 1], 'a pill whose panel was never shown');
});

for (const r of requests) r.done = true;
console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.join('\n') : '\nno problems');
process.exit(0);

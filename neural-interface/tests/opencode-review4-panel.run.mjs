// Code review 4 of the OpenCode panel: the panel itself (ocp-v2-panel.js),
// booted and driven under the DOM stand-in of the smoke run. Started by
// opencode-review4.test.mjs in a child process. The socket stand-in answers
// what a step does not care about and holds what it does, so a second gesture
// can be made while the first one is still waiting.
// Prints one line per step and ends with "no problems" or the list of them.
import { installDom, makeNode } from './opencode-panel-dom.fixtures.mjs';
const { doc, FakeWS } = installDom();
const base = new URL('../public/shared/ocp-v2/', import.meta.url).href;
const problems = [];
// A request cut off by the socket the V06 step closes is that step's doing.
process.on('unhandledRejection', (err) => { if (!/websocket closed|not connected|websocket failed/i.test(String(err?.message || err))) problems.push(`unhandledRejection: ${err?.stack?.split('\n').slice(0, 3).join(' | ') || err}`); });
const step = async (name, fn) => { try { await fn(); console.log('ok  ', name); } catch (err) { problems.push(`${name}: ${err?.stack?.split('\n').slice(0, 4).join(' | ')}`); console.log('FAIL', name, '-', err?.message); } };
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const expect = (cond, message) => { if (!cond) throw new Error(message); };
const same = (actual, expected, message) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); };

// ── A little more of a browser than the stand-in has ────────────────────────
// Two things the panel relies on and the stand-in leaves out: `textContent = x`
// empties a node (the rename box is taken out that way), and markup set through
// innerHTML has elements (the tab's close button, the naming dialog's fields).
// Only for this run: elements with a class or a data-role become flat children.
function enhance(node) {
  let text = '';
  Object.defineProperty(node, 'textContent', {
    configurable: true,
    get: () => text,
    set: (value) => { text = String(value ?? ''); for (const c of node.children) c.parentNode = null; node.children.length = 0; node.childNodes.length = 0; },
  });
  const html = Object.getOwnPropertyDescriptor(node, 'innerHTML');
  Object.defineProperty(node, 'innerHTML', {
    configurable: true,
    get: () => html.get.call(node),
    set: (value) => {
      html.set.call(node, value);
      for (const m of String(value).matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
        const cls = /class="([^"]*)"/.exec(m[2]);
        const role = /data-role="([^"]*)"/.exec(m[2]);
        if (!cls && !role) continue;
        const child = enhance(makeNode(m[1]));
        if (cls) child.className = cls[1];
        if (role) child.dataset.role = role[1];
        node.appendChild(child);
      }
    },
  });
  return node;
}
doc.createElement = (tag) => enhance(makeNode(tag));
const trayEl = makeNode('div'); trayEl.id = 'term-minimized-tray'; doc.body.appendChild(trayEl);

// The project list is read after every New session: held, so a step can act
// while it is out. (It fails each time, so it is read again the next time.)
const projectReads = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (String(url).split('?')[0] === '/api/projects') return new Promise((resolve, reject) => projectReads.push({ resolve, reject, done: false }));
  return realFetch(url, init);
};
const releaseProjects = async () => { for (const read of projectReads) { if (!read.done) { read.done = true; read.reject(new Error('held by the test')); } } await tick(30); };

const { storage } = await import(base + '../storage.js');
storage.setItem('opencode-v2-project', '/work/a');
const state = await import(base + 'ocp-v2-state.js');
const reqMod = await import(new URL('../lib/opencode-v2-ws-requests.js', import.meta.url).href);
const panelMod = await import(base + 'ocp-v2-panel.js');
const store = state.getDefaultStore();

// ── The socket stand-in ─────────────────────────────────────────────────────
const requests = [];
const holds = new Set();               // predicates: a matching request waits for the step
const held = (msg) => [...holds].some((pred) => pred(msg));
const defaultAnswer = (msg) => {
  switch (msg.type) {
    case 'init': return [null, { ready: true, port: 4096, version: '1.18.34', managed: true, capabilities: reqMod.opencodeV2WsCapabilities() }];
    case 'session:get': return [{ id: msg.sessionId, directory: '/work/a', title: `title of ${msg.sessionId}` }, {}];
    case 'session:share:policy': return [{ share: 'manual' }, {}];
    case 'mcp:profile:get': return [{ profile: 'full' }, {}];
    case 'agent:list': return [[{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }], {}];
    case 'session:update': case 'session:delete': case 'message:abort': return [true, {}];
    default: return [[], {}];
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
  if (!held(msg)) setTimeout(() => { const [data, extra] = defaultAnswer(msg); answer(entry, data, extra); }, 1);
};
const waiting = (type, pred = () => true) => requests.filter((r) => !r.done && r.msg.type === type && pred(r.msg));
const sentOf = (type, pred = () => true) => requests.filter((r) => r.msg.type === type && pred(r.msg));
const hold = (pred) => { holds.add(pred); return () => holds.delete(pred); };
const openSocket = () => { const sock = FakeWS.last; sock.readyState = 1; sock._emit('open'); return sock; };
const emitEvent = (eventType, event) => FakeWS.last._emit('message', { data: JSON.stringify({ type: 'event', eventType, event }) });

// ── Finding things ──────────────────────────────────────────────────────────
const walk = (n, fn) => { fn(n); for (const c of n.children || []) walk(c, fn); };
const find = (root, pred) => { let hit = null; walk(root, (n) => { if (!hit && pred(n)) hit = n; }); return hit; };
const all = (root, pred) => { const out = []; walk(root, (n) => { if (pred(n)) out.push(n); }); return out; };
const hasClass = (n, cls) => String(n.className || '').split(/\s+/).includes(cls);
let panelEl = null;
const button = (title) => find(panelEl, (n) => n.tagName === 'BUTTON' && n.title === title);
const overlay = () => find(panelEl, (n) => hasClass(n, 'ocpv2-name-modal-overlay'));
const pill = (sessionId) => find(trayEl, (n) => n.dataset?.sessionId === sessionId);
const errors = () => store.getState().errors.map((err) => err.message);
const clearBanners = () => { for (const err of [...store.getState().errors]) store.dismissError(err.id); };

// ═══ V05: boot, and a choice the user makes while it is still starting ══════
let releaseCreate = hold((msg) => msg.type === 'session:create');
let releaseList = hold((msg) => msg.type === 'session:list');
const opening = panelMod.toggleOpencodePanel();
await tick(10);
openSocket();
await tick(40);
panelEl = find(doc.body, (n) => n.id === 'ocp-v2-panel');

await step('V05 boot neither adopts nor creates a session over the New session the user asked for while it was starting', async () => {
  expect(panelEl, 'the panel was not built');
  const [lookup] = waiting('session:list');
  expect(lookup, 'boot is not looking for a session to adopt');
  // The user clicks "+" while boot is still reading the session list.
  button('New session')._fire('click');
  await tick(20);
  same(waiting('session:create').length, 1, 'New session did not ask for a session');
  // The lookup comes back with an untouched session of the project.
  answer(lookup, [{ id: 'ses_empty', title: '', directory: '/work/a', messageCount: 0, time: { created: 1, updated: 1 } }]);
  await tick(40);
  same(store.getState().sessionId, null, 'boot adopted a session over the user\'s pending choice');
  same(sentOf('session:create').length, 1, 'boot created a session of its own on top');
  // The user's session arrives and takes the panel.
  answer(waiting('session:create')[0], { id: 'ses_1', title: '', directory: '/work/a' });
  await tick(40);
  same(store.getState().sessionId, 'ses_1', 'the session the user asked for is not on screen');
  await opening;
  // Nobody navigated after it: the naming dialog opens, as it always did.
  await releaseProjects();
  expect(overlay(), 'no naming dialog after New session');
  find(overlay(), (n) => hasClass(n, 'skip'))._fire('click');
  expect(!overlay(), 'Skip did not close the dialog');
});
releaseList();

// Two more tabs for the steps below.
async function newSession(id) {
  button('New session')._fire('click');
  await tick(20);
  answer(waiting('session:create')[0], { id, title: '', directory: '/work/a' });
  await tick(40);
  await releaseProjects();
  find(overlay(), (n) => hasClass(n, 'skip'))?._fire('click');
  await tick(10);
}

// ═══ V04: the naming dialog after New session ═══════════════════════════════
await step('V04 no naming dialog over the session the user went to while the project list was loading', async () => {
  await newSession('ses_2');
  same(store.getState().sessionId, 'ses_2', 'setup: on the second session');
  button('New session')._fire('click');
  await tick(20);
  answer(waiting('session:create')[0], { id: 'ses_3', title: '', directory: '/work/a' });
  await tick(40);
  same(store.getState().sessionId, 'ses_3', 'the new session did not take the panel');
  // The project list is still out; the user clicks another tab.
  pill('ses_1')._fire('click');
  await tick(40);
  same(store.getState().sessionId, 'ses_1', 'the tab click did not switch');
  await releaseProjects();
  expect(!overlay(), 'the naming dialog opened over the session the user went to');
});

await step('V04 no naming dialog when the creation failed after the user went elsewhere (the null target)', async () => {
  button('New session')._fire('click');
  await tick(20);
  const [creating] = waiting('session:create');
  expect(creating, 'no session was asked for');
  pill('ses_2')._fire('click');
  await tick(40);
  same(store.getState().sessionId, 'ses_2', 'the tab click did not switch');
  answer(creating, null);                        // OpenCode returns no session
  await tick(40);
  await releaseProjects();
  expect(!overlay(), 'a naming dialog opened for a session that was never created');
  same(store.getState().sessionId, 'ses_2', 'the failed creation moved the panel');
  expect(errors().some((m) => /session create returned no id/.test(m)), 'the failure was not reported');
  clearBanners();
});

// ═══ V08: rename, twice ═════════════════════════════════════════════════════
await step('V08 after a rename that worked, Rename opens a fresh box and the second rename goes out', async () => {
  const label = find(panelEl, (n) => hasClass(n, 'ocpv2-session-label'));
  const renameInput = () => find(label, (n) => hasClass(n, 'ocpv2-rename-input'));
  const release = hold((msg) => msg.type === 'session:update' && msg.body?.title === 'First name' && !msg._seen);
  button('Rename')._fire('click');
  const first = renameInput();
  expect(first, 'Rename did not open a box');
  first.value = 'First name';
  first._fire('keydown', { key: 'Enter' });
  await tick(10);
  const [update] = waiting('session:update', (m) => m.body?.title === 'First name');
  expect(update && update.msg.sessionId === 'ses_2', 'the rename did not go out for the session on screen');
  release();
  answer(update, true);
  await tick(30);
  expect(!renameInput(), 'the box is still in the header after a rename that worked');
  same(store.getState().sessionInfo.title, 'First name', 'the store did not take the new title');
  same(label.textContent, 'First name', 'the header does not show the new title');
  // Second rename.
  button('Rename')._fire('click');
  const second = renameInput();
  expect(second && second !== first, 'Rename focused the finished box instead of opening a new one');
  second.value = 'Second name';
  second._fire('keydown', { key: 'Enter' });
  await tick(30);
  expect(sentOf('session:update', (m) => m.sessionId === 'ses_2' && m.body?.title === 'Second name').length >= 1, 'the second rename did nothing');
  expect(!renameInput(), 'the second box stayed');
  same(label.textContent, 'Second name', 'the header does not show the second title');
  // Escape and an unchanged name close the box too.
  button('Rename')._fire('click');
  renameInput()._fire('keydown', { key: 'Escape' });
  expect(!renameInput(), 'Escape left the box');
});

// ═══ V12: the session menu ══════════════════════════════════════════════════
await step('V12 an older live-list answer does not replace the archived list the menu shows now', async () => {
  const release = hold((msg) => msg.type === 'session:list');
  const sessionBtn = find(panelEl, (n) => hasClass(n, 'ocpv2-session-btn'));
  sessionBtn._fire('click');
  await tick(20);
  const rowsOf = () => all(panelEl, (n) => hasClass(n, 'ocpv2-session-item-label')).map((n) => String(n.textContent));
  const item = (label) => { const node = find(panelEl, (n) => hasClass(n, 'ocpv2-session-item-label') && String(n.textContent) === label); return node?.parentNode; };
  // (Opening the menu reads the list, and once more when the share policy is known.)
  for (const entry of waiting('session:list')) answer(entry, [{ id: 'ses_live_0', title: 'Live zero', directory: '/work/a', time: { updated: 5 } }]);
  await tick(20);
  expect(rowsOf().includes('Live zero') && item('Show archived'), `the menu was not painted: ${rowsOf()}`);
  // A session event asks for the live list again...
  emitEvent('session.updated', { info: { id: 'ses_live_0', title: 'Live zero' } });
  await tick(300);
  const [live] = waiting('session:list');
  expect(live && live.msg.options?.archived === false, 'no live read is out');
  // ...and the user switches to the archived list before it answers.
  item('Show archived')._fire('click');
  await tick(30);
  const archived = waiting('session:list').find((r) => r.msg.options?.archived === true);
  expect(archived, 'the archived list was not asked for');
  answer(archived, [{ id: 'ses_arch', title: 'Archived one', directory: '/work/a', time: { updated: 2, archived: 3 } }]);
  await tick(20);
  expect(rowsOf().includes('Archived one') && item('Back to sessions'), `the archived list was not painted: ${rowsOf()}`);
  answer(live, [{ id: 'ses_live_1', title: 'Live late', directory: '/work/a', time: { updated: 9 } }]);
  await tick(20);
  expect(!rowsOf().includes('Live late'), 'the older live list was painted over the archived one');
  expect(rowsOf().includes('Archived one') && item('Back to sessions'), `the archived list is gone: ${rowsOf()}`);
  release();
  for (const entry of waiting('session:list')) answer(entry, []);
  doc._fire?.('mousedown', { target: doc.body });
  sessionBtn._fire('click');                     // close
  await tick(20);
});

// ═══ V03: a recovery, and a switch while it is out ══════════════════════════
await step('V03 a recovery that was overtaken by a switch leaves the errors of the session on screen alone', async () => {
  same(store.getState().sessionId, 'ses_2', 'setup: on ses_2');
  clearBanners();
  const release = hold((msg) => msg.type === 'session:get' && msg.sessionId === 'ses_2');
  store.pushError({ message: 'websocket closed' });      // recoverable: the panel heals itself
  await tick(950);
  expect(store.getState().healing === true, 'no recovery started');
  expect(waiting('session:get', (m) => m.sessionId === 'ses_2').length >= 1, 'the recovery is not re-reading its session');
  // The user switches to another tab, where something of its own fails.
  pill('ses_3')._fire('click');
  await tick(40);
  same(store.getState().sessionId, 'ses_3', 'the tab click did not switch');
  store.pushError({ message: 'Rename failed' });
  release();
  for (const entry of waiting('session:get', (m) => m.sessionId === 'ses_2')) answer(entry, { id: 'ses_2', directory: '/work/a', title: 'Second name' });
  await tick(80);
  expect(store.getState().healing === false, 'the recovery did not finish');
  same(errors(), ['Rename failed'], 'the recovery of the session that was left cleared the errors of the one on screen');
  same(store.getState().sessionId, 'ses_3', 'the recovery put its session back on screen');
  clearBanners();
});

// ═══ The dropped-prompt notice ══════════════════════════════════════════════
// (Review 5: a tab the user closes asks first, see opencode-review5-panel.run.mjs.
// The notice is for a session that goes away by itself, here deleted elsewhere.)
await step('V01 a session that is deleted elsewhere while its queue is parked tells the user which prompts went with it', async () => {
  const input = find(panelEl, (n) => n.tagName === 'TEXTAREA');
  store.setRunning(true);
  input.value = 'left behind in three'; input._fire('input', { isTrusted: true });
  input._fire('keydown', { key: 'Enter', isTrusted: true, isComposing: false, shiftKey: false });
  await tick(10);
  pill('ses_1')._fire('click');
  await tick(40);
  same(store.getState().sessionId, 'ses_1', 'the tab click did not switch');
  same(errors(), [], 'setup: no banner yet');
  emitEvent('session.deleted', { info: { id: 'ses_3' } });
  await tick(40);
  expect(!pill('ses_3'), 'the tab was not closed');
  const notices = store.getState().errors.filter((err) => err.notice);
  same(notices.length, 1, `one notice: ${errors()}`);
  expect(/^Not sent: “left behind in three” was waiting for “.+”, and that session is gone\. It is kept here until you put it back/.test(notices[0].message), `the notice names the prompt: ${notices[0].message}`);
  expect(store.getState().healing === false, 'a notice started a recovery');
  // It is still there after the next switch, until it is dismissed.
  pill('ses_2')._fire('click');
  await tick(40);
  same(store.getState().sessionId, 'ses_2', 'the tab click did not switch');
  same(store.getState().errors.filter((err) => err.notice).length, 1, 'the notice went with the switch');
  await tick(900);
  same(store.getState().errors.filter((err) => err.notice).length, 1, 'the notice was cleared by a recovery');
  clearBanners();
});

// ═══ V06: two tab clicks, the first one still waiting for the panel ═════════
await step('V06 a tab click that is still waiting for the panel to open does not override the click made after it', async () => {
  await newSession('ses_4');
  same(store.getState().sessionId, 'ses_4', 'setup: on ses_4');
  button('Minimize')._fire('click');
  expect(panelMod.isOpencodePanelOpen() === false, 'the panel did not hide');
  // The socket drops: opening the panel has to wait for the connection.
  const dead = FakeWS.last;
  dead.readyState = 3; dead._emit('close');
  await tick(10);
  pill('ses_1')._fire('click');                  // older click: waits for connect()
  await tick(10);
  expect(panelMod.isOpencodePanelOpen() === true, 'the panel is not opening');
  same(store.getState().sessionId, 'ses_4', 'the older click switched before the panel was ready');
  pill('ses_2')._fire('click');                  // newer click: the panel is visible, it switches at once
  await tick(20);
  same(store.getState().sessionId, 'ses_2', 'the newer click did not switch');
  // The connection comes back; the older click resumes.
  expect(FakeWS.last !== dead, 'no reconnect was started');
  openSocket();
  await tick(120);
  same(store.getState().sessionId, 'ses_2', 'the older click overrode the newer one');
  await tick(1000);                              // (the recovery after the outage)
  same(store.getState().sessionId, 'ses_2', 'the recovery moved the panel');
});

for (const r of requests) r.done = true;
console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.join('\n') : '\nno problems');
process.exit(0);

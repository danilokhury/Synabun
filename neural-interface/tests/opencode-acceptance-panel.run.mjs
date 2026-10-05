// Live acceptance fixes of the OpenCode panel (2026-10-04): the panel itself
// (ocp-v2-panel.js), booted and driven under the DOM stand-in of the smoke
// run. Started by opencode-acceptance-fixes.test.mjs in a child process.
//   1. what publishes or destroys is asked in the panel, in two steps
//   2. the "shared" badge goes when sharing stops
//   3. /help is a card under the transcript
// (The scaffolding below is the one of opencode-review6-panel.run.mjs.)
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

// ── Boot, and three sessions ────────────────────────────────────────────────
// Every question is asked in the panel, in two steps (ocp-v2-confirm-logic.js):
// the click that starts something only puts the question up, and a click on
// one of its two buttons answers it. A native dialog is never reached (an
// automated browser accepts those by itself): this one would say yes.
const confirms = [];                   // every question the panel asked: the text of its row
let confirmAnswer = true;
let nativeDialogs = 0;
window.confirm = () => { nativeDialogs += 1; return true; };
const questionRow = () => find(doc.body, (n) => hasClass(n, 'ocpv2-confirm'));
// Reads the question on screen and answers it with `confirmAnswer`, once a
// second click counts (CONFIRM_MIN_DELAY_MS). False when nothing is asked.
async function settleQuestion() {
  const row = questionRow();
  if (!row) return false;
  confirms.push(String(find(row, (n) => hasClass(n, 'ocpv2-confirm-text')).textContent));
  await tick(380);
  find(row, (n) => hasClass(n, confirmAnswer ? 'ocpv2-confirm-yes' : 'ocpv2-confirm-no'))._fire('click');
  await tick(40);
  return true;
}
hold((msg) => msg.type === 'session:create');   // every creation waits for its step
const opening = panelMod.toggleOpencodePanel();
await tick(10);
openSocket();
await tick(60);
panelEl = find(doc.body, (n) => n.id === 'ocp-v2-panel');
// (The stand-in's classList rewrites className on its first use: the session
// menu is found here, before anything opens or closes it.)
const menuEl = find(panelEl, (n) => hasClass(n, 'ocpv2-session-menu'));
async function newSession(id) {
  button('New session')._fire('click');
  await tick(20);
  answer(waiting('session:create')[0], { id, title: '', directory: '/work/a' });
  await tick(40);
  await releaseProjects();
  find(overlay(), (n) => hasClass(n, 'skip'))?._fire('click');
  await tick(10);
}
// (Boot creates the first session itself when there is none to adopt.)
for (const entry of waiting('session:create')) answer(entry, { id: 'ses_1', title: '', directory: '/work/a' });
await tick(40);
await releaseProjects();
find(overlay() || panelEl, (n) => hasClass(n, 'skip'))?._fire('click');
await opening;
if (store.getState().sessionId !== 'ses_1') await newSession('ses_1');
await newSession('ses_2');
await newSession('ses_3');
const label = () => find(panelEl, (n) => hasClass(n, 'ocpv2-session-label'));
const renameInput = () => find(label(), (n) => hasClass(n, 'ocpv2-rename-input'));
const input = () => find(panelEl, (n) => n.tagName === 'TEXTAREA');
const queued = () => all(panelEl, (n) => hasClass(n, 'ocpv2-queue-text')).map((n) => String(n.textContent));
const queueTray = () => find(panelEl, (n) => hasClass(n, 'ocpv2-queue-tray'));
const queuePrompt = async (text) => {
  store.setRunning(true);
  input().value = text; input()._fire('input', { isTrusted: true });
  input()._fire('keydown', { key: 'Enter', isTrusted: true, isComposing: false, shiftKey: false });
  await tick(10);
  store.setRunning(false);
};
const refuse = (entry, error = 'Rename failed upstream') => answer(entry, { error }, { status: 500 });

const pillLabel = (sessionId) => String(find(pill(sessionId), (n) => hasClass(n, 'term-minimized-pill-label'))?.textContent);
const titlePushes = (title) => sentOf('session:update', (m) => m.body?.title === title).length;
const notices = () => store.getState().errors.filter((err) => err.notice);
const banners = () => all(panelEl, (n) => hasClass(n, 'ocpv2-error-banner'));
const bannerButton = (text, label) => find(banners().find((n) => all(n, () => true).some((c) => String(c.textContent).includes(text))), (n) => n.tagName === 'BUTTON' && String(n.textContent) === label);
const rename = async (title) => {
  button('Rename')._fire('click');
  const box = renameInput();
  expect(box, 'Rename did not open a box');
  box.value = title;
  box._fire('keydown', { key: 'Enter' });
  await tick(10);
};
const IMAGE = { name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA' };

// ── OpenCode 1.18.34 as it behaves ──────────────────────────────────────────
// Unshare removes the share, but the link stays in the session row: the reply
// to the unshare, the session list, session:get and every later
// session.updated report it again.
const SHARE_URL = 'https://opncd.ai/share/abc12345';
let rowShared = false;                 // what the row of ses_3 says (unshare never clears it)
const TITLES = { ses_3: 'Three', ses_2: 'Two', ses_1: 'One' };
const rowOf = (id) => ({ id, title: TITLES[id] || id, directory: '/work/a', time: { updated: Number(id.slice(-1)) }, ...(id === 'ses_3' && rowShared ? { share: { url: SHARE_URL } } : {}) });
const SERVED = ['session:list', 'session:get', 'session:share', 'session:unshare'];
hold((msg) => SERVED.includes(msg.type));
const deleted = new Set();
setInterval(() => {
  for (const e of waiting('session:list')) answer(e, Object.keys(TITLES).filter((id) => !deleted.has(id)).map(rowOf));
  for (const e of waiting('session:get')) answer(e, { ...rowOf(e.msg.sessionId), version: '1.18.34' });
  for (const e of waiting('session:share')) { rowShared = true; answer(e, { ...rowOf(e.msg.sessionId), version: '1.18.34' }); }
  for (const e of waiting('session:unshare')) answer(e, { ...rowOf(e.msg.sessionId), version: '1.18.34' });
}, 5).unref();
const settle = () => tick(90);

const sessionBtn = () => find(panelEl, (n) => hasClass(n, 'ocpv2-session-btn'));
const menuRow = (title) => find(menuEl, (n) => hasClass(n, 'ocpv2-session-item-label') && String(n.textContent).startsWith(title))?.parentNode;
const menuOpen = () => !!menuEl?.classList.contains('open');
expect(menuEl, 'setup: the session menu element was not found');
async function openMenu() {
  if (menuOpen()) { sessionBtn()._fire('click'); await tick(20); }
  sessionBtn()._fire('click');
  await settle();
  await settle();
  expect(menuOpen(), 'the session menu did not open');
}
const questionText = () => String(find(questionRow(), (n) => hasClass(n, 'ocpv2-confirm-text'))?.textContent);
const yesButton = () => find(questionRow(), (n) => hasClass(n, 'ocpv2-confirm-yes'));
const badge = (title) => String(find(menuRow(title), (n) => hasClass(n, 'ocpv2-session-item-meta'))?.textContent || '');

// ═══ 1. Share ═══════════════════════════════════════════════════════════════
await step('1 Share: the menu item only asks, in the menu, and says the transcript becomes public; a double click and Cancel publish nothing; the button of the question publishes', async () => {
  same(store.getState().sessionId, 'ses_3', 'setup: on ses_3');
  await openMenu();
  expect(menuRow('Share session…'), 'the menu does not offer Share');
  menuRow('Share session…')._fire('click');
  await settle();
  expect(menuOpen(), 'the menu closed on the question');
  expect(questionRow() && find(menuEl, (n) => n === questionRow()), 'the question is not in the session menu');
  expect(/published at a public URL/.test(questionText()) && /Anyone with the link can read it/.test(questionText()), `the question does not say the transcript becomes public: ${questionText()}`);
  same(String(yesButton().textContent), 'Share publicly', 'the button does not say what it does');
  same(sentOf('session:share').length, 0, 'one click published the session');
  // The list is read again while the question is up (sessions change all the time): it stays.
  emitEvent('session.updated', { info: { id: 'ses_1', title: 'One', directory: '/work/a' } });
  await tick(400);
  expect(questionRow() && find(menuEl, (n) => n === questionRow()), 'a refill of the menu took the question away');
  // Cancel.
  confirmAnswer = false;
  await settleQuestion();
  await settle();
  same([sentOf('session:share').length, !!questionRow(), !!store.getState().sessionInfo?.share], [0, false, false], 'Cancel published, or left the question up');
  // Asked again. A second click that comes with the first (a double click) publishes nothing.
  menuRow('Share session…')._fire('click');
  await tick(20);
  yesButton()._fire('click');
  await settle();
  same([sentOf('session:share').length, !!questionRow()], [0, true], 'a double click published the session');
  // The button of the question publishes.
  confirmAnswer = true;
  await settleQuestion();
  await settle();
  same(sentOf('session:share', (m) => m.sessionId === 'ses_3').length, 1, 'the button of the question did not share');
  same(store.getState().sessionInfo?.share?.url, SHARE_URL, 'the store does not show the session as shared');
  // Closing the menu takes a question with it: nothing invisible stays armed.
  await openMenu();
  const del = find(menuRow('One'), (n) => hasClass(n, 'ocpv2-session-item-delete'));
  del._fire('click');
  await tick(20);
  expect(questionRow(), 'setup: Delete did not ask');
  sessionBtn()._fire('click');                       // closes the menu
  await tick(450);
  same([menuOpen(), !!questionRow(), sentOf('session:delete').length, !!pill('ses_1')], [false, false, 0, true], 'a question outlived its menu, or something was deleted');
});

// ═══ 2. The "shared" badge ══════════════════════════════════════════════════
await step('2 Stop sharing: the badge and the link go from the menu, the store and the tab, although OpenCode reports the link with every later read', async () => {
  await openMenu();
  same(badge('Three'), 'shared', 'setup: the shared session has no badge');
  expect(menuRow('Stop sharing') && menuRow('Copy share link'), 'setup: the menu does not offer Stop sharing and the link');
  menuRow('Stop sharing')._fire('click');
  await settle();
  await settle();
  same(sentOf('session:unshare', (m) => m.sessionId === 'ses_3').length, 1, 'the unshare did not go out');
  // (The reply was the stale row, link included, and so is every list since.)
  same(store.getState().sessionInfo?.share, undefined, 'the store still holds the link');
  same(badge('Three'), '', 'the badge stayed in the menu');
  expect(!menuRow('Copy share link') && !menuRow('Stop sharing') && menuRow('Share session…'), 'the menu still shows the link, or does not offer Share again');
  // A session.updated built from the stored row.
  emitEvent('session.updated', { info: { ...rowOf('ses_3'), version: '1.18.34' } });
  await tick(400);
  same(store.getState().sessionInfo?.share, undefined, 'a session.updated put the stopped link back');
  same(badge('Three'), '', 'the badge came back with the next list');
  // Leaving and coming back reads the session again (its tab's row, then session:get).
  pill('ses_1')._fire('click');
  await settle();
  pill('ses_3')._fire('click');
  await settle();
  await settle();
  same([store.getState().sessionId, store.getState().sessionInfo?.share], ['ses_3', undefined], 'the link came back when the session was read again');
  same(JSON.parse(storage.getItem('opencode-v2-stopped-shares') || '{}'), { ses_3: SHARE_URL }, 'the stopped link is not kept for the next page load');
  // Shared again from the panel: the same link is a share once more.
  await openMenu();
  menuRow('Share session…')._fire('click');
  await tick(20);
  confirmAnswer = true;
  await settleQuestion();
  await settle();
  await settle();
  same([store.getState().sessionInfo?.share?.url, badge('Three')], [SHARE_URL, 'shared'], 'a session shared again is not shown as shared');
  same(JSON.parse(storage.getItem('opencode-v2-stopped-shares') || '{}'), {}, 'the link is still remembered as stopped');
});

// ═══ 1. Delete in the session menu ══════════════════════════════════════════
await step('1 Delete in the session menu: the × only asks, under its row, naming the session; a move to another session takes the question away; its button deletes', async () => {
  same(store.getState().sessionId, 'ses_3', 'setup: on ses_3');
  await openMenu();
  const del = (title) => find(menuRow(title), (n) => hasClass(n, 'ocpv2-session-item-delete'));
  const before = sentOf('session:delete').length;
  del('Two')._fire('click');
  await tick(20);
  expect(questionRow() && find(menuEl, (n) => n === questionRow()), 'the question is not in the session menu');
  same(questionText(), 'Delete "Two"? The session and its history are removed from OpenCode.', 'the question does not say what happens');
  same([sentOf('session:delete').length - before, !!pill('ses_2')], [0, true], 'one click deleted the session');
  // The panel moves to another session while the question is up: it is off, and its button is gone.
  pill('ses_1')._fire('click');
  await settle();
  same([store.getState().sessionId, !!questionRow(), sentOf('session:delete').length - before, !!pill('ses_2')], ['ses_1', false, 0, true], 'the question outlived the session it was asked on');
  pill('ses_3')._fire('click');
  await settle();
  // Asked again, and agreed with the second click.
  await openMenu();
  del('Two')._fire('click');
  await tick(20);
  confirmAnswer = true;
  await settleQuestion();
  deleted.add('ses_2');
  await settle();
  same([sentOf('session:delete', (m) => m.sessionId === 'ses_2').length, !!pill('ses_2')], [1, false], 'the button of the question did not delete the session');
  if (menuOpen()) { sessionBtn()._fire('click'); await tick(20); }
});

// ═══ 1. Delete on a message ═════════════════════════════════════════════════
await step('1 Delete on a message: the click only asks, above the compose box, naming the message; Cancel deletes nothing; its button deletes', async () => {
  same(store.getState().sessionId, 'ses_3', 'setup: on ses_3');
  store.hydrateMessages([
    { info: { id: 'msg_u1', role: 'user', sessionID: 'ses_3', time: { created: 1 } }, parts: [{ id: 'prt_u1', messageID: 'msg_u1', sessionID: 'ses_3', type: 'text', text: 'please refactor the parser' }] },
    { info: { id: 'msg_a1', role: 'assistant', sessionID: 'ses_3', parentID: 'msg_u1', modelID: 'big-pickle', cost: 0, tokens: { input: 900, output: 300, reasoning: 0 }, time: { created: 2, completed: 4002 } }, parts: [{ id: 'prt_a1', messageID: 'msg_a1', sessionID: 'ses_3', type: 'text', text: 'done', time: { end: 4002 } }] },
  ]);
  await tick(80);
  const deleteAction = () => find(panelEl, (n) => n.tagName === 'BUTTON' && n.dataset?.action === 'delete');
  expect(deleteAction(), 'the prompt has no Delete action');
  deleteAction()._fire('click');
  await tick(40);
  const slot = find(panelEl, (n) => hasClass(n, 'ocpv2-confirm-slot'));
  expect(questionRow() && slot.children.includes(questionRow()), 'the question is not above the compose box');
  same(questionText(), 'Delete the message “please refactor the parser” from the session? This cannot be undone.', 'the question does not name the message');
  same(sentOf('message:delete').length, 0, 'one click deleted the message');
  confirmAnswer = false;
  await settleQuestion();
  same([sentOf('message:delete').length, store.getState().messages.has('msg_u1'), !!questionRow()], [0, true, false], 'Cancel deleted the message');
  deleteAction()._fire('click');
  await tick(40);
  confirmAnswer = true;
  await settleQuestion();
  await tick(60);
  same([sentOf('message:delete', (m) => m.sessionId === 'ses_3' && m.messageID === 'msg_u1').length, store.getState().messages.has('msg_u1')], [1, false], 'the button of the question did not delete the message');
  // (4. The footer of the free model's answer says what it cost: nothing.)
  const meta = find(panelEl, (n) => hasClass(n, 'ocpv2-msg-meta'));
  same(String(meta?.textContent), 'big-pickle · 1.2k tok · $0.00 · 4.0s', 'the footer of a free answer');
});

// ═══ 1. /share ══════════════════════════════════════════════════════════════
await step('1 /share: typing it opens the session menu with the question up; nothing is published until its button is clicked', async () => {
  same(store.getState().sessionId, 'ses_3', 'setup: on ses_3');
  // (The session was shared again above: stopped first, so that there is something to share.)
  await openMenu();
  menuRow('Stop sharing')._fire('click');
  await settle();
  await settle();
  sessionBtn()._fire('click');
  await tick(20);
  same([menuOpen(), store.getState().sessionInfo?.share], [false, undefined], 'setup: the menu is closed and the session is not shared');
  const before = sentOf('session:share').length;
  input().value = '/share'; input()._fire('input', { isTrusted: true });
  input()._fire('keydown', { key: 'Enter', isTrusted: true, isComposing: false, shiftKey: false });
  await settle();
  await settle();
  expect(menuOpen(), '/share did not open the session menu');
  expect(questionRow() && find(menuEl, (n) => n === questionRow()), 'the question of /share is not in the session menu');
  expect(/published at a public URL/.test(questionText()), `the question: ${questionText()}`);
  same(sentOf('session:share').length - before, 0, '/share published the session by itself');
  confirmAnswer = true;
  await settleQuestion();
  await settle();
  await settle();
  same([sentOf('session:share').length - before, store.getState().sessionInfo?.share?.url], [1, SHARE_URL], 'the button of the question did not share');
  if (menuOpen()) { sessionBtn()._fire('click'); await tick(20); }
});

// ═══ 3. /help ═══════════════════════════════════════════════════════════════
await step('3 /help shows a card under the transcript from the slash catalog; the box stays empty, nothing is sent, and Close takes the card away', async () => {
  const sends = () => sentOf('message:send').length + sentOf('command:run').length + sentOf('session:shell').length + sentOf('session:command').length;
  const before = sends();
  input().value = '/help'; input()._fire('input', { isTrusted: true });
  input()._fire('keydown', { key: 'Enter', isTrusted: true, isComposing: false, shiftKey: false });
  await tick(80);
  same(input().value, '', '/help put text into the box');
  const card = () => find(panelEl, (n) => hasClass(n, 'ocpv2-help-card'));
  expect(card(), 'no help card under the transcript');
  const names = all(card(), (n) => hasClass(n, 'ocpv2-help-name')).map((n) => String(n.textContent));
  for (const name of ['/new, /clear', '/share', '/help', '@', '!', 'Enter', 'Your prompts', 'Replies']) expect(names.includes(name), `the card does not list ${name}: ${names.join(' | ')}`);
  const sources = all(card(), (n) => hasClass(n, 'ocpv2-session-item-meta')).map((n) => String(n.textContent));
  expect(sources.includes('panel') && sources.includes('opens the terminal'), `the commands do not say where they come from: ${[...new Set(sources)].join(' | ')}`);
  same([sends() - before, store.getState().messageOrder.includes('msg_help'), queued().length], [0, false, 0], 'something was sent or queued for /help');
  find(card(), (n) => n.tagName === 'BUTTON' && String(n.textContent) === 'Close')._fire('click');
  await tick(60);
  expect(!card(), 'Close left the card');
});

if (nativeDialogs) problems.push(`a native dialog was used ${nativeDialogs} time(s): every question belongs in the panel`);
for (const r of requests) r.done = true;
console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.join('\n') : '\nno problems');
process.exit(0);

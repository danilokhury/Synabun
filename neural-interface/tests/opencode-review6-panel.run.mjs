// Final verification 6 of the OpenCode panel: the panel itself
// (ocp-v2-panel.js), booted and driven under the DOM stand-in of the smoke
// run. Started by opencode-review6.test.mjs in a child process. The socket stand-in answers
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

// ═══ N03: events while a rename is waiting for its answer ═══════════════════
await step('N03 a session.updated and an idle event during a pending rename re-assert nothing, and the refusal leaves the title the session had', async () => {
  same(store.getState().sessionId, 'ses_3', 'setup: on ses_3');
  // The session has a title the panel holds as its own (a rename that worked).
  await rename('Own title');
  await tick(40);
  same([store.getState().sessionInfo.title, errors()], ['Own title', []], 'setup: the first rename');
  const release = hold((msg) => msg.type === 'session:update' && msg.body?.title === 'Refused name');
  await rename('Refused name');
  const [update] = waiting('session:update', (m) => m.body?.title === 'Refused name');
  expect(update && update.msg.sessionId === 'ses_3', 'the rename did not go out');
  // While it is out OpenCode reports the session (any change does that), and a turn ends.
  emitEvent('session.updated', { info: { id: 'ses_3', title: 'As OpenCode has it', directory: '/work/a' } });
  store.setRunning(true); store.setRunning(false);
  await tick(20);
  same(store.getState().sessionInfo.title, 'As OpenCode has it', 'the attempted title was written into the live session before the server answered');
  expect(!/Refused name/.test(pillLabel('ses_3')), 'the tab shows a title the session does not have');
  await tick(300);                                 // (longer than the title push-back timer)
  same(titlePushes('Refused name'), 1, 'the title of a pending rename was sent a second time');
  refuse(update);
  release();
  await tick(40);
  same(errors(), ['Rename failed upstream'], 'the refusal was not reported');
  same([store.getState().sessionInfo.title, label().textContent, pillLabel('ses_3')], ['Own title', 'Own title', 'Own title'], 'the title the panel held before the rename is not back on screen everywhere');
  // OpenCode reports the session again: the panel's own title is the old one, not the refused one.
  emitEvent('session.updated', { info: { id: 'ses_3', title: 'Something OpenCode made up', directory: '/work/a' } });
  await tick(300);
  same(store.getState().sessionInfo.title, 'Own title', 'the title the panel held before the refused rename was not put back');
  same(titlePushes('Refused name'), 1, 'the refused title was pushed after the refusal');
  clearBanners();
});

await step('N03 a rename that is accepted is sent once, whatever arrives while it is out, and is the panel\'s own title afterwards', async () => {
  const release = hold((msg) => msg.type === 'session:update' && msg.body?.title === 'Accepted name');
  await rename('Accepted name');
  emitEvent('session.updated', { info: { id: 'ses_3', title: 'Own title', directory: '/work/a' } });
  store.setRunning(true); store.setRunning(false);
  await tick(300);
  same(titlePushes('Accepted name'), 1, 'the rename was sent twice');
  const [update] = waiting('session:update', (m) => m.body?.title === 'Accepted name');
  answer(update, { id: 'ses_3', title: 'Accepted name', directory: '/work/a' });
  release();
  await tick(40);
  same([store.getState().sessionInfo.title, label().textContent, errors()], ['Accepted name', 'Accepted name', []], 'the accepted rename did not rename');
  // Nothing is left pending: the panel keeps its own title against a stale report, as it always did.
  emitEvent('session.updated', { info: { id: 'ses_3', title: 'Own title', directory: '/work/a' } });
  await tick(300);
  same(store.getState().sessionInfo.title, 'Accepted name', 'the pending marker was left behind: the panel no longer keeps its title');
  expect(titlePushes('Accepted name') >= 2, 'the panel no longer pushes its own title back after a rename was answered');
});

await step('N03 two renames of one session out at once, both refused: neither title comes back', async () => {
  const release = hold((msg) => msg.type === 'session:update' && (msg.body?.title === 'Dialog name' || msg.body?.title === 'Header name'));
  button('New session')._fire('click');
  await tick(20);
  answer(waiting('session:create')[0], { id: 'ses_4', title: '', directory: '/work/a' });
  await tick(40);
  await releaseProjects();
  expect(overlay(), 'no naming dialog');
  const field = find(overlay(), (n) => n.tagName === 'INPUT' && hasClass(n, 'ocpv2-name-modal-input')) || find(overlay(), (n) => n.tagName === 'INPUT');
  field.value = 'Dialog name';
  (find(overlay(), (n) => hasClass(n, 'save')) || find(overlay(), (n) => n.tagName === 'BUTTON' && /save|create|start/i.test(String(n.textContent))))._fire('click');
  await tick(20);
  const [first] = waiting('session:update', (m) => m.body?.title === 'Dialog name');
  expect(first && first.msg.sessionId === 'ses_4', 'the dialog\'s rename did not go out');
  same(store.getState().sessionId, 'ses_4', 'setup: on the new session');
  // The header's rename leaves while the dialog's is still waiting.
  await rename('Header name');
  const [second] = waiting('session:update', (m) => m.body?.title === 'Header name');
  expect(second && second.msg.sessionId === 'ses_4', 'the header\'s rename did not go out');
  refuse(first, 'Session is locked');
  await tick(30);
  refuse(second, 'Session is locked');
  release();
  await tick(40);
  same(errors(), ['Rename failed for “Dialog name”: Session is locked', 'Session is locked'], 'the two refusals');
  emitEvent('session.updated', { info: { id: 'ses_4', title: 'Untitled by OpenCode', directory: '/work/a' } });
  await tick(300);
  same(store.getState().sessionInfo.title, 'Untitled by OpenCode', 'a refused title came back as the panel\'s own through the other rename');
  same([titlePushes('Dialog name'), titlePushes('Header name')], [1, 1], 'a refused title was pushed again');
  clearBanners();
});

// ═══ N01: Archive, and the prompts that change while it waits ═══════════════
const sessionBtn = () => find(panelEl, (n) => hasClass(n, 'ocpv2-session-btn'));
const menuRow = (title) => find(panelEl, (n) => hasClass(n, 'ocpv2-session-item-label') && String(n.textContent).startsWith(title))?.parentNode;
const LIST = [
  { id: 'ses_1', title: 'One', directory: '/work/a', time: { updated: 5 } },
  { id: 'ses_2', title: 'Two', directory: '/work/a', time: { updated: 4 } },
];
const menuOpen = () => !!menuEl?.classList.contains('open');
// The menu, open and freshly painted with LIST (closed first when it was open:
// its rows may be an older list's).
expect(menuEl, 'setup: the session menu element was not found');
async function openMenu() {
  if (menuOpen()) { sessionBtn()._fire('click'); await tick(20); }
  const releaseList = hold((msg) => msg.type === 'session:list');
  sessionBtn()._fire('click');
  await tick(20);
  for (let i = 0; i < 3; i += 1) { for (const entry of waiting('session:list')) answer(entry, LIST); await tick(20); }
  releaseList();
  expect(menuOpen(), 'the session menu did not open');
}
const archiveOf = (title) => { const row = menuRow(title); return row ? find(row, (n) => n.tagName === 'BUTTON' && String(n.textContent) === 'Archive') : null; };

await step('N01 Archive asks again when the prompts waiting are not the ones the user agreed to lose, although there are as many', async () => {
  // Session two holds prompt P; the panel is on session one.
  pill('ses_2')._fire('click'); await tick(40);
  await queuePrompt('prompt P');
  pill('ses_1')._fire('click'); await tick(40);
  same(store.getState().sessionId, 'ses_1', 'setup: on ses_1');
  await openMenu();
  expect(archiveOf('Two'), 'the menu has no Archive for session two');
  const release = hold((msg) => msg.type === 'session:update' && msg.sessionId === 'ses_2' && msg.body?.time);
  confirms.length = 0;
  confirmAnswer = true;
  archiveOf('Two')._fire('click');
  await tick(20);
  // The click put the question up, under its row of the menu, and archived nothing.
  expect(questionRow() && find(menuEl, (n) => n === questionRow()), 'the question is not in the session menu');
  same(sentOf('session:update', (m) => m.sessionId === 'ses_2' && m.body?.time).length, 0, 'one click on Archive archived the session');
  await settleQuestion();
  same(confirms.length, 1, 'Archive did not ask about prompt P');
  expect(/“prompt P”/.test(confirms[0]), `the question: ${confirms[0]}`);
  const [archive] = waiting('session:update', (m) => m.sessionId === 'ses_2' && m.body?.time);
  expect(archive, 'the archive did not go out');
  // While it is out the user opens that tab, removes P and queues Q: one prompt waiting, as before.
  pill('ses_2')._fire('click'); await tick(40);
  same(queued(), ['prompt P'], 'setup: P is back in its queue');
  find(queueTray(), (n) => n.tagName === 'BUTTON' && String(n.textContent) === '×')._fire('click');
  await tick(10);
  await queuePrompt('prompt Q');
  same(queued(), ['prompt Q'], 'setup: Q is queued');
  // The archive is back. The user never agreed to lose Q.
  confirms.length = 0;
  confirmAnswer = false;
  answer(archive, { id: 'ses_2' });
  release();
  await tick(60);
  await settleQuestion();
  same(confirms.length, 1, 'the tab was closed without asking about the prompt that is waiting now');
  expect(/“prompt Q”/.test(confirms[0]) && !/prompt P/.test(confirms[0]), `the second question names Q: ${confirms[0]}`);
  same([!!pill('ses_2'), store.getState().sessionId, queued()], [true, 'ses_2', ['prompt Q']], 'declined, and the tab or its prompt went');
  same(notices().length, 0, 'a notice although nothing was dropped');
});

await step('N01 with the same prompts waiting when the archive is back, the one question was enough', async () => {
  pill('ses_1')._fire('click'); await tick(40);
  same(store.getState().sessionId, 'ses_1', 'setup: on ses_1');
  await openMenu();
  expect(archiveOf('Two'), 'the menu has no Archive for session two');
  const release = hold((msg) => msg.type === 'session:update' && msg.sessionId === 'ses_2' && msg.body?.time);
  confirms.length = 0;
  confirmAnswer = true;
  archiveOf('Two')._fire('click');
  await tick(20);
  await settleQuestion();
  same(confirms.length, 1, 'Archive did not ask about prompt Q');
  const [archive] = waiting('session:update', (m) => m.sessionId === 'ses_2' && m.body?.time);
  answer(archive, { id: 'ses_2' });
  release();
  await tick(60);
  same([confirms.length, !!questionRow(), !!pill('ses_2'), notices().length], [1, false, false, 0], 'asked twice about the same prompts, or the tab stayed, or a notice repeated the question');
  for (const entry of waiting('session:list')) answer(entry, LIST.slice(0, 1));
  if (menuOpen()) sessionBtn()._fire('click');
  await tick(20);
});

// ═══ N02: a session that goes away by itself ════════════════════════════════
await step('N02 a session deleted elsewhere keeps its waiting prompts on notices; Put back puts one, with its attachment, into the box of the session on screen', async () => {
  pill('ses_4')._fire('click'); await tick(40);
  same(store.getState().sessionId, 'ses_4', 'setup: on ses_4');
  store.addAttachedImage(IMAGE);
  await queuePrompt('typed for four');
  await queuePrompt('also for four');
  pill('ses_1')._fire('click'); await tick(40);
  same(store.getState().sessionId, 'ses_1', 'the tab click did not switch');
  confirms.length = 0;
  emitEvent('session.deleted', { info: { id: 'ses_4' } });
  await tick(60);
  same([!!questionRow(), !!pill('ses_4')], [false, false], 'a deleted session asked, or kept its tab');
  same(notices().map((err) => err.kept), [
    { text: 'typed for four', images: [IMAGE], paths: [], mentions: [] },
    { text: 'also for four', images: [], paths: [], mentions: [] },
  ], 'the prompts were not kept whole');
  expect(/^Not sent: “typed for four” with 1 attachment was waiting for “.+”, and that session is gone\. It is kept here until you put it back into the box or discard it; reloading the page drops it\.$/.test(notices()[0].message), `the notice: ${notices()[0].message}`);
  // A recovery leaves them alone, and starts none itself.
  await tick(900);
  same([notices().length, store.getState().healing], [2, false], 'the notices started a recovery, or went with one');
  expect(bannerButton('typed for four', 'Put back') && bannerButton('typed for four', 'Discard'), 'the notice has no actions');
  bannerButton('typed for four', 'Put back')._fire('click');
  await tick(40);
  same([input().value, store.getState().attachedImages, store.getState().sessionId], ['typed for four', [IMAGE], 'ses_1'], 'the prompt is not in the box of the session on screen, whole');
  same(notices().map((err) => err.kept.text), ['also for four'], 'the notice that was used stayed, or the other went');
  bannerButton('also for four', 'Discard')._fire('click');
  await tick(40);
  same(notices().length, 0, 'Discard left the notice');
  same(input().value, 'typed for four', 'Discard touched the box');
});

if (nativeDialogs) problems.push(`a native dialog was used ${nativeDialogs} time(s): every question belongs in the panel`);
for (const r of requests) r.done = true;
console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.join('\n') : '\nno problems');
process.exit(0);

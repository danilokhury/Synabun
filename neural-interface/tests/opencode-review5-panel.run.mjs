// Release-gate review 5 of the OpenCode panel: the panel itself
// (ocp-v2-panel.js), booted and driven under the DOM stand-in of the smoke
// run. Started by opencode-review5.test.mjs in a child process. The socket stand-in answers
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

// ═══ W05: a rename the server refuses ═══════════════════════════════════════
await step('W05 a rename the server refuses is a banner, and neither the header, the tab nor the store take the name', async () => {
  same(store.getState().sessionId, 'ses_3', 'setup: on ses_3');
  // The session has a title of its own.
  emitEvent('session.updated', { info: { id: 'ses_3', title: 'Server title', directory: '/work/a' } });
  await tick(20);
  same(store.getState().sessionInfo.title, 'Server title', 'setup: the server\'s title is on screen');
  const release = hold((msg) => msg.type === 'session:update' && msg.body?.title === 'Refused name');
  button('Rename')._fire('click');
  const box = renameInput();
  expect(box, 'Rename did not open a box');
  box.value = 'Refused name';
  box._fire('keydown', { key: 'Enter' });
  await tick(10);
  const [update] = waiting('session:update', (m) => m.body?.title === 'Refused name');
  expect(update && update.msg.sessionId === 'ses_3', 'the rename did not go out');
  await tick(250);                                 // (longer than the title push-back timer)
  same(sentOf('session:update', (m) => m.body?.title === 'Refused name').length, 1, 'a second request for the same title raced the rename');
  refuse(update);
  release();
  await tick(40);
  same(errors(), ['Rename failed upstream'], 'the refusal was not reported');
  same(store.getState().sessionInfo.title, 'Server title', 'the store took a title the session never got');
  expect(!renameInput(), 'the box stayed');
  same(label().textContent, 'Server title', 'the header shows the refused name');
  expect(!/Refused name/.test(String(find(pill('ses_3'), (n) => hasClass(n, 'term-minimized-pill-label'))?.textContent)), 'the tab shows the refused name');
  // OpenCode reports the session again: the refused name is not put back over its title, nor pushed again.
  emitEvent('session.updated', { info: { id: 'ses_3', title: 'Server title', directory: '/work/a' } });
  await tick(300);
  same(store.getState().sessionInfo.title, 'Server title', 'the refused name came back as the panel\'s own title');
  same(sentOf('session:update', (m) => m.body?.title === 'Refused name').length, 1, 'the refused name was pushed again');
  await tick(900);                                 // (a rename failure starts no recovery)
  same(errors(), ['Rename failed upstream'], 'the banner was cleared by a recovery');
  clearBanners();
  // The next rename works, and is the panel's own title from then on.
  button('Rename')._fire('click');
  renameInput().value = 'Accepted name';
  renameInput()._fire('keydown', { key: 'Enter' });
  await tick(40);
  same([store.getState().sessionInfo.title, errors()], ['Accepted name', []], 'a rename that worked did not rename');
});

await step('W05 a name typed into the naming dialog and refused by the server is reported, and the session is not shown as named', async () => {
  const release = hold((msg) => msg.type === 'session:update' && msg.body?.title === 'Dialog name');
  button('New session')._fire('click');
  await tick(20);
  answer(waiting('session:create')[0], { id: 'ses_4', title: '', directory: '/work/a' });
  await tick(40);
  await releaseProjects();
  expect(overlay(), 'no naming dialog');
  const field = find(overlay(), (n) => n.tagName === 'INPUT' && hasClass(n, 'ocpv2-name-modal-input')) || find(overlay(), (n) => n.tagName === 'INPUT');
  expect(field, 'no name field in the dialog');
  field.value = 'Dialog name';
  (find(overlay(), (n) => hasClass(n, 'save')) || find(overlay(), (n) => n.tagName === 'BUTTON' && /save|create|start/i.test(String(n.textContent))))._fire('click');
  await tick(20);
  const [update] = waiting('session:update', (m) => m.body?.title === 'Dialog name');
  expect(update && update.msg.sessionId === 'ses_4', 'the name did not go out for the new session');
  refuse(update, 'Session is locked');
  release();
  await tick(40);
  same(errors(), ['Rename failed for “Dialog name”: Session is locked'], 'the refusal was not reported');
  expect(store.getState().sessionInfo?.title !== 'Dialog name', 'the store shows the session as named');
  emitEvent('session.updated', { info: { id: 'ses_4', title: 'Untitled by OpenCode', directory: '/work/a' } });
  await tick(300);
  same(store.getState().sessionInfo.title, 'Untitled by OpenCode', 'the refused name was put back over the session\'s title');
  same(sentOf('session:update', (m) => m.body?.title === 'Dialog name').length, 1, 'the refused name was pushed again');
  clearBanners();
});

// ═══ W01: closing a tab that has prompts waiting ════════════════════════════
await step('W01 the tab\'s × asks first when prompts are parked for it; declined, nothing is closed, deleted or lost', async () => {
  pill('ses_3')._fire('click');
  await tick(40);
  same(store.getState().sessionId, 'ses_3', 'setup: on ses_3');
  await queuePrompt('parked for three');
  same(queued(), ['parked for three'], 'setup: queued');
  pill('ses_1')._fire('click');
  await tick(40);
  same(store.getState().sessionId, 'ses_1', 'the tab click did not switch');
  const deletesBefore = sentOf('session:delete').length;
  confirms.length = 0;
  confirmAnswer = false;
  find(pill('ses_3'), (n) => hasClass(n, 'term-minimized-pill-close'))._fire('click');
  await tick(40);
  // The click put the question up, in the panel, and did nothing else.
  expect(questionRow() && find(panelEl, (n) => n === questionRow()), 'the question is not in the panel');
  same([!!pill('ses_3'), sentOf('session:delete').length - deletesBefore], [true, 0], 'one click on the × closed or deleted something');
  await settleQuestion();
  same(confirms.length, 1, 'the close did not ask');
  expect(/^Close “Accepted name”\?\n\nA prompt is still waiting to be sent there and will be discarded:\n• “parked for three”$/.test(confirms[0]), `the question names the session and the prompt: ${confirms[0]}`);
  expect(pill('ses_3'), 'the tab was closed although the user declined');
  same(sentOf('session:delete').length, deletesBefore, 'the session was deleted although the user declined');
  same(errors(), [], 'a notice for prompts that were not dropped');
  // The prompt is still there, whole, when the panel is back on the session.
  pill('ses_3')._fire('click');
  await tick(40);
  same(queued(), ['parked for three'], 'the prompt did not survive the declined close');
});

await step('W01 the header X asks too, for the queue on screen; agreed, the tab closes and no notice repeats what was asked', async () => {
  same(store.getState().sessionId, 'ses_3', 'setup: on ses_3');
  const deletesBefore = sentOf('session:delete').length;
  confirms.length = 0;
  confirmAnswer = false;
  button('Close session')._fire('click');
  await tick(40);
  await settleQuestion();
  same(confirms.length, 1, 'the header X did not ask');
  same([store.getState().sessionId, !!pill('ses_3'), sentOf('session:delete').length - deletesBefore, queued()], ['ses_3', true, 0, ['parked for three']], 'declined, and something changed');
  // Agreed.
  confirmAnswer = true;
  button('Close session')._fire('click');
  await tick(60);
  // One click closes nothing: the question is up, the tab and the session are still there.
  same([!!questionRow(), !!pill('ses_3'), sentOf('session:delete').length - deletesBefore], [true, true, 0], 'one click on the header X closed or deleted something');
  // Nor does a second click that comes with the first (a double click).
  find(questionRow(), (n) => hasClass(n, 'ocpv2-confirm-yes'))._fire('click');
  await tick(20);
  same([!!questionRow(), !!pill('ses_3')], [true, true], 'a double click closed the tab');
  await settleQuestion();
  await tick(60);
  same(confirms.length, 2, 'the second close did not ask');
  expect(!pill('ses_3'), 'the tab was not closed');
  same(sentOf('session:delete', (m) => m.sessionId === 'ses_3').length, 1, 'the session was not deleted');
  same(store.getState().errors.filter((err) => err.notice).length, 0, 'a notice after the user had been asked');
  expect(store.getState().sessionId !== 'ses_3', 'the panel stayed on the closed session');
  expect(queueTray()?.hidden !== false || queued().length === 0, 'the closed session\'s queue is on screen in another session');
  // A tab with nothing waiting closes without a question, as before.
  confirms.length = 0;
  find(pill('ses_4'), (n) => hasClass(n, 'term-minimized-pill-close'))._fire('click');
  await tick(60);
  same([!!questionRow(), !!pill('ses_4')], [false, false], 'a tab with nothing waiting asked, or did not close');
});

// ═══ W06: a recovery and an error that appears while it is out ══════════════
await step('W06 the recovery clears the error it recovered from and leaves the one that appeared meanwhile', async () => {
  pill('ses_2')._fire('click');
  await tick(60);
  same(store.getState().sessionId, 'ses_2', 'setup: on ses_2');
  clearBanners();
  const release = hold((msg) => msg.type === 'session:get' && msg.sessionId === 'ses_2');
  store.pushError({ message: 'websocket closed' });      // recoverable: the panel heals itself
  await tick(950);
  expect(store.getState().healing === true, 'no recovery started');
  expect(waiting('session:get', (m) => m.sessionId === 'ses_2').length >= 1, 'the recovery is not re-reading its session');
  // Meanwhile, on the same session, something of the user's fails.
  store.pushError({ message: 'The provider refused the prompt' });
  release();
  for (const entry of waiting('session:get', (m) => m.sessionId === 'ses_2')) answer(entry, { id: 'ses_2', directory: '/work/a', title: 'two' });
  await tick(120);
  expect(store.getState().healing === false, 'the recovery did not finish');
  same(store.getState().sessionId, 'ses_2', 'the recovery moved the panel');
  same(errors(), ['The provider refused the prompt'], 'the recovery did not clear exactly what it recovered from');
  clearBanners();
});

// ═══ W01: a session that goes away by itself ════════════════════════════════
await step('W01 a session deleted elsewhere cannot ask: its waiting prompts are kept on a notice (review 6, N02: no longer a pointer at the prompt history)', async () => {
  same(store.getState().sessionId, 'ses_2', 'setup: on ses_2');
  await queuePrompt('typed for two');
  pill('ses_1')._fire('click');
  await tick(40);
  same(store.getState().sessionId, 'ses_1', 'the tab click did not switch');
  confirms.length = 0;
  emitEvent('session.deleted', { info: { id: 'ses_2' } });
  await tick(40);
  same([!!questionRow(), !!pill('ses_2')], [false, false], 'a deleted session asked, or kept its tab');
  const notices = store.getState().errors.filter((err) => err.notice).map((err) => err.message);
  same(notices.length, 1, `one notice: ${errors()}`);
  expect(/^Not sent: “typed for two” was waiting for “.+”, and that session is gone\. It is kept here until you put it back into the box or discard it; reloading the page drops it\.$/.test(notices[0]), `the notice: ${notices[0]}`);
  // The prompt history has the text too, as before: ArrowUp in the empty box brings it back.
  input().value = ''; input()._fire('input', { isTrusted: true });
  input()._fire('keydown', { key: 'ArrowUp', isTrusted: true, isComposing: false, shiftKey: false });
  same(input().value, 'typed for two', 'the prompt history does not have the text');
  clearBanners();
});

if (nativeDialogs) problems.push(`a native dialog was used ${nativeDialogs} time(s): every question belongs in the panel`);
for (const r of requests) r.done = true;
console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.join('\n') : '\nno problems');
process.exit(0);

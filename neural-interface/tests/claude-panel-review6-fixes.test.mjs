// Review 6 of the Claude panel parity build, browser side: the two findings
// left in "a prompt typed while a Compact is running waits in the queue".
// W06: the queue was advanced only by a `done` or `aborted`. A Compact whose
//      hold ended another way (the session stayed silent, the socket closed, the
//      reconnect found nothing, an error, a turn end no `done` follows) left the
//      prompt in the queue until something else ended a turn.
// W07: a queued prompt belonged to no conversation. Queue one during a Compact,
//      pick another session in the same tab, and it was sent there.
// cp/cp-compose.js is DOM-free and runs here. The panel file cannot be imported
// in Node, so its own functions (send, the queue, finishTab, the socket
// handlers, the frame cases, selectSession) are cut out of the source and run
// against stand-ins for what they call, with the clock and the socket faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as compose from '../public/shared/cp/cp-compose.js';
import * as temporary from '../public/shared/cp/cp-temporary.js';
import { hasCapability } from '../public/shared/cp/cp-events.js';

const {
  COMPACT_HOLD_MS, COMPACT_SETTLE_MS, QUEUED_REFUSAL_LINES,
  compactHolds, compactHoldLeft, newConversation, nextQueued, ownsQueued, queueAfterCompact, queuedRefusal, restoredQueue,
} = compose;

const HERE = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(join(HERE, '..', 'public', 'shared', 'ui-claude-panel.js'), 'utf8').replace(/\r\n/g, '\n');
const fn = (name) => {
  const found = new RegExp(`\\n(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`).exec(panel)?.[0];
  assert.ok(found, `${name}() found in the panel`);
  return found;
};
const between = (from, to) => {
  const a = panel.indexOf(from);
  const b = panel.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `found: ${from}`);
  return panel.slice(a, b);
};
const NOW = 1_800_000_000_000;

// ── The page's own code, run here ──

const PAGE_FUNCTIONS = ['send', 'addToQueue', 'advanceQueue', '_keepQueued', '_sendQueued', 'pauseQueue', 'removeFromQueue', 'clearQueue', 'finishTab', 'connectTab', 'selectSession'];
const COMPACT_QUEUE = /\nconst _compactQueue = compactQueue\(\{[\s\S]*?\n\}\);\n/.exec(panel)?.[0];
const REATTACH_CASE = between("    case 'reattach_result': {", "    case 'rewind_conversation_result': {");
const END_CASES = between("    case 'done':", '    default:\n      // A wire message');

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  constructor(page) { this.page = page; this.readyState = FakeSocket.CONNECTING; this.listeners = {}; page.sockets.push(this); }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  emit(type, event = {}) { for (const listener of this.listeners[type] || []) listener(event); }
  send(data) { this.page.sent.push(JSON.parse(data)); }
  open() { this.readyState = FakeSocket.OPEN; this.emit('open'); }
  close() { this.readyState = FakeSocket.CLOSED; this.emit('close'); }
}

// A clock the test moves. A timer set while another runs is counted from that
// timer's own time, as in a browser (node's mock timers count it from the end of
// the tick, which would hide the 300 ms + 200 ms of a queue advance).
const REAL_CLOCK = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now };
function fakeClock(t) {
  let now = NOW;
  let lastId = 0;
  const timers = new Map();
  globalThis.setTimeout = (run, ms = 0) => { timers.set(++lastId, { id: lastId, at: now + Math.max(0, Number(ms) || 0), run }); return lastId; };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  Date.now = () => now;
  t.after(() => { globalThis.setTimeout = REAL_CLOCK.setTimeout; globalThis.clearTimeout = REAL_CLOCK.clearTimeout; Date.now = REAL_CLOCK.now; });
  return (ms) => {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const timer of timers.values()) if (timer.at <= end && (!next || timer.at < next.at || (timer.at === next.at && timer.id < next.id))) next = timer;
      if (!next) break;
      timers.delete(next.id);
      now = next.at;
      next.run();
    }
    now = end;
  };
}

/** One page: the panel's functions over stand-ins, one tab on session A with an open socket. */
function page(t, { sessionId = 'session-A' } = {}) {
  const tick = fakeClock(t);
  const p = { sockets: [], sent: [], said: [], errors: [], created: [], labels: [], input: { value: '' }, tabs: [] };
  const env = {
    ...compose,
    WebSocket: class extends FakeSocket { constructor() { super(p); } },
    location: { protocol: 'http:', host: 'localhost:3344' },
    CSS: { escape: (s) => String(s) },
    console: { log() {}, warn() {}, error: (...args) => { throw args.find((arg) => arg instanceof Error) || new Error(args.join(' ')); } }, // the socket handler logs what a frame threw: here it fails the test
    fetch: async () => ({ json: async () => ({}) }),
    _panel: { querySelector: (selector) => (selector === '#cp-input' ? p.input : null) },
    _tabs: p.tabs,
    _windowId: 'window-1',
    _cliInstalled: true,
    _cliInstallFailureForced: false,
    MAX_TABS: 3,
    CLAUDE_ICON: '',
    NOTIF_TYPE: { DONE: 'done', ERROR: 'error', WARN: 'warn' },
    activeTab: () => p.tab,
    appendStatus: (tab, text) => { p.said.push(text); },
    appendError: (tab, text) => { p.errors.push(text); },
    appendUser() {}, showThinking() {}, hideThinking() {}, autoResize() {}, hideSlashHints() {}, updateAttachBadge() {},
    renderQueue() {}, saveTabs() {}, renderStatusline() {}, renderGauge() {}, updatePillLabel() {}, notify() {},
    recordHookEvent() {}, renderPostPlanActions() {}, flushSessionSnapshotSave() {}, flagClaudeCliInstallFailure() {},
    // The tab's mode on a new socket and after a reconnect (cp-permission-model.js and the panel's own helpers): not what these tests are about.
    connectionOpened() {}, sessionForgotten() {}, _paintMode() {}, _sessionSaysMode() {}, _stateOwnMode() {},
    loadSessionHistory() {}, _updateCostLabel() {}, _releaseSessionLock() {}, _setBackgroundWork() {}, _applySessionOptions() {},
    // The temporary chat's decisions (cp-temporary.js, the real ones) and the panel's helpers around them: these tabs are ordinary ones.
    ...temporary, hasCapability, _paintTemporary() {}, _temporaryOver() {},
    _setCompactingUI: (on) => { p.labels.push(on); },
    _checkSessionLock: async () => ({ ok: true }),
    setRunning: (tab, running) => { tab.running = running; },
    buildPromptWithAttachments: (tab, text) => text,
    ddGetValue: () => '',
    _getModelId: () => '',
    _getEffort: () => '',
    trunc: (text) => text,
    createTab: (sid, label) => { p.created.push({ sid, label }); p.tabs.push({ created: true }); },
    handleTabMsg: (tab, msg) => { tab._lastWsActivity = Date.now(); p.frame(tab, msg); },
  };
  const names = Object.keys(env);
  const source = `${COMPACT_QUEUE}\n${PAGE_FUNCTIONS.map(fn).join('\n')}
    function frame(tab, msg) { switch (msg.type) {\n${REATTACH_CASE}\n${END_CASES}\n    } }
    return { _compactQueue, frame, ${PAGE_FUNCTIONS.join(', ')} };`;
  Object.assign(p, new Function(...names, source)(...names.map((name) => env[name])));

  p.tab = {
    id: 'tab-1', sessionId, label: 'Session A', conversation: newConversation(), running: false, compacting: false,
    queue: [], queuePaused: false, queueExpanded: false, attachedImages: [], attachedFiles: [], backgroundWork: [],
    messagesEl: { innerHTML: '' }, usage: {}, _permQueue: [], _msgBuffer: [],
  };
  p.tabs.push(p.tab);
  p.connectTab(p.tab);
  p.sockets[0].open();
  p.sent.length = 0; // the reattach of the first connect
  p.tab._reattachExpectRunning = false;

  p.tick = tick;
  /** What the three Compact senders do (pinned by source below). */
  p.compact = (tab = p.tab) => {
    tab.compacting = true;
    tab._compactSentAt = Date.now();
    p.sent.push({ type: 'compact' });
    p._compactQueue.watch(tab);
  };
  p.type = (text) => { p.input.value = text; p.send(); };
  p.receive = (msg, tab = p.tab) => tab.ws.emit('message', { data: JSON.stringify(msg) });
  p.queries = () => p.sent.filter((msg) => msg.type === 'query');
  p.queued = (tab = p.tab) => tab.queue.map((item) => item.text);
  return p;
}

// ── W07: whose a queued prompt is ──

test('W07: a queued prompt belongs to the conversation it was typed for', () => {
  const tab = { conversation: newConversation(), queue: [] };
  const own = { id: '1', text: 'mine', conversation: tab.conversation };
  const other = { id: '2', text: 'theirs', conversation: newConversation() };
  assert.notEqual(own.conversation, other.conversation, 'every conversation gets its own name');
  assert.equal(ownsQueued(tab, own), true);
  assert.equal(ownsQueued(tab, other), false);
  assert.equal(ownsQueued(tab, { id: '3', text: 'no name' }), false, 'a prompt that names no conversation is nobody\'s');
  assert.equal(ownsQueued(null, own), false);
  assert.equal(ownsQueued(tab, null), false);

  // The queue sends the first prompt typed for this conversation, whatever sits in front of it.
  tab.queue = [other, own];
  assert.equal(nextQueued(tab), 1);
  tab.queue = [other];
  assert.equal(nextQueued(tab), -1, 'nothing of this conversation waits');
  assert.equal(nextQueued({ conversation: 'x' }), -1);
  assert.equal(nextQueued(null), -1);

  // Taken off the queue and about to be sent: checked once more.
  assert.equal(queuedRefusal(tab, own, { connected: true }), '');
  assert.equal(queuedRefusal(tab, other, { connected: true }), 'conversation');
  assert.equal(queuedRefusal(tab, own, { connected: false }), 'closed');
  assert.equal(queuedRefusal(tab, other, { connected: false }), 'conversation', 'another conversation is the reason that stays');
  for (const reason of ['conversation', 'closed']) assert.match(QUEUED_REFUSAL_LINES[reason], /not sent/);
});

test('W07: a queue read from storage keeps what each prompt was typed for', () => {
  const tab = { conversation: 'conv-now' };
  const restored = restoredQueue(tab, [{ id: '1', text: 'saved by an older page' }, { id: '2', text: 'typed elsewhere', conversation: 'conv-before' }, null]);
  assert.deepEqual(restored.map((item) => item.conversation), ['conv-now', 'conv-before'], 'a prompt saved without a conversation is the tab\'s own; one saved with another is not');
  assert.equal(ownsQueued(tab, restored[0]), true);
  assert.equal(ownsQueued(tab, restored[1]), false);
  assert.deepEqual(restoredQueue(tab, undefined), []);
});

test('W07: a tab with a Compact under way is busy for the session menu: the session opens in a new tab and the queue stays', async (t) => {
  const p = page(t);
  p.compact();
  p.type('prompt for A');
  assert.deepEqual(p.queued(), ['prompt for A']);
  assert.equal(p.tab.queue[0].conversation, p.tab.conversation, 'the prompt carries the tab\'s conversation');

  await p.selectSession('session-B', 'Session B');
  assert.deepEqual(p.created, [{ sid: 'session-B', label: 'Session B' }], 'opened in a new tab, as with a running turn');
  assert.equal(p.tab.sessionId, 'session-A', 'the tab stays with its conversation');
  assert.deepEqual(p.queued(), ['prompt for A']);
  assert.equal(compactHolds(p.tab), true, 'and the Compact still holds it');

  await p.selectSession(null, 'New chat');
  assert.deepEqual(p.created[1], { sid: null, label: 'New chat' }, 'New chat too');
  assert.equal(p.tab.sessionId, 'session-A');

  // No room for another tab: said, and nothing moves.
  await p.selectSession('session-C', 'Session C');
  assert.equal(p.created.length, 2);
  assert.equal(p.said.at(-1), 'Max tabs reached — close a tab first.');
  assert.equal(p.tab.sessionId, 'session-A');

  // The Compact ends: the prompt goes to the conversation it was typed for.
  p.receive({ type: 'done' });
  p.tick(500);
  assert.deepEqual(p.queries().map((msg) => [msg.prompt, msg.sessionId]), [['prompt for A', 'session-A']]);
});

test('W07: the queue never sends a prompt into another conversation; it stays in the tray, marked', async (t) => {
  const p = page(t);
  // A paused queue in an idle tab: the session menu may still reuse the tab (so before).
  p.tab.queue.push({ id: 'q1', text: 'prompt for A', images: null, files: null, conversation: p.tab.conversation });
  p.tab.queuePaused = true;
  const before = p.tab.conversation;
  await p.selectSession('session-B', 'Session B');
  assert.equal(p.created.length, 0);
  assert.equal(p.tab.sessionId, 'session-B');
  assert.notEqual(p.tab.conversation, before, 'the tab holds another conversation now');
  assert.deepEqual(p.queued(), ['prompt for A'], 'kept');
  assert.equal(ownsQueued(p.tab, p.tab.queue[0]), false);
  assert.equal(p.tab.queueExpanded, true, 'and shown');

  // Resume the queue, end a turn, end it stopped: the prompt is never sent to B.
  p.pauseQueue(p.tab);
  p.tick(1000);
  p.tab.running = true;
  p.receive({ type: 'done' });
  p.tick(1000);
  p.tab.running = true;
  p.receive({ type: 'aborted' });
  p.tick(1000);
  assert.deepEqual(p.queries(), []);
  assert.deepEqual(p.queued(), ['prompt for A']);

  // A prompt typed for B behind a running turn goes out when the turn ends; the other one stays.
  p.tab.running = true;
  p.type('prompt for B');
  assert.deepEqual(p.queued(), ['prompt for A', 'prompt for B']);
  p.receive({ type: 'done' });
  p.tick(500);
  assert.deepEqual(p.queries().map((msg) => [msg.prompt, msg.sessionId]), [['prompt for B', 'session-B']]);
  assert.deepEqual(p.queued(), ['prompt for A']);

  // The tray says so.
  const render = fn('renderQueue');
  assert.match(render, /const stranded = !ownsQueued\(tab, item\);/);
  assert.match(render, /stranded \? 'Not sent \(typed for another conversation\): ' : ''/);
});

test('W07: a prompt already taken off the queue when the tab moves is put back, not sent', async (t) => {
  const p = page(t);
  p.tab.queue.push({ id: 'q1', text: 'prompt for A', images: null, files: null, conversation: p.tab.conversation });
  p.advanceQueue(p.tab); // takes it; it is sent 200 ms later
  assert.deepEqual(p.queued(), []);
  await p.selectSession('session-B', 'Session B'); // inside those 200 ms
  p.tick(200);
  assert.deepEqual(p.queries(), [], 'not sent into B');
  assert.deepEqual(p.queued(), ['prompt for A'], 'back in the queue');
  assert.equal(p.said.at(-1), QUEUED_REFUSAL_LINES.conversation);
  p.tick(60_000);
  assert.deepEqual(p.queries(), []);
});

test('W07: only the page moving the tab starts another conversation', async (t) => {
  const p = page(t);
  const first = p.tab.conversation;
  await p.selectSession('session-A', 'Session A');
  assert.equal(p.tab.conversation, first, 'the same session picked again is the same conversation');
  await p.selectSession('session-B', 'Session B');
  const second = p.tab.conversation;
  assert.notEqual(second, first);
  await p.selectSession(null, 'New chat');
  const third = p.tab.conversation;
  assert.notEqual(third, second);
  await p.selectSession(null, 'New chat');
  assert.notEqual(p.tab.conversation, third, 'New chat on a new chat is another one');

  // One place moves a tab (selectSession: New chat, the session menu, a project change); a new tab
  // gets its own name. The session's id changing under the tab (its first start, a resume, a
  // reattach, a reset) is the same conversation: nothing else assigns the name.
  assert.equal(panel.split('tab.conversation = newConversation();').length - 1, 1);
  assert.equal(panel.split('conversation: newConversation(),').length - 1, 1);
  assert.equal(panel.split('.conversation = ').length - 1, 2, 'selectSession, and the restore of a saved tab');
  assert.match(fn('restoreTabs'), /if \(t && saved\.conversation\) t\.conversation = saved\.conversation;\n\s+if \(t && saved\.queue\?\.length\) t\.queue = restoredQueue\(t, saved\.queue\);/);
  assert.match(fn('saveTabs'), /conversation: t\.conversation \|\| '', queue: t\.queue \|\| \[\]/, 'saved with the tab, so a reload keeps it');
  assert.match(fn('addToQueue'), /conversation: tab\.conversation,/);
  // Fork and "Fork from here" open the copy in a tab of its own; an automation takes only a tab with nothing queued.
  assert.equal(panel.split('const t = createTab(r.sessionId, title);').length - 1, 2);
  assert.match(between('export async function attachClaudeAutomation(', 'tab.automationRunId = run.runId;'), /\(!entry\.queue \|\| entry\.queue\.length === 0\)/);
});

// ── W06: the decision ──

test('W06: what the queue does when a Compact ends without its `done`', () => {
  const conversation = 'conv';
  const tab = (over = {}) => ({ conversation, running: false, queuePaused: false, queue: [{ text: 'a', conversation }], ...over });
  const two = [{ text: 'a', conversation }, { text: 'b', conversation }];

  // The session can take it: it is sent.
  assert.deepEqual(queueAfterCompact(tab(), { how: 'ended', connected: true }), { action: 'send', line: '' });
  assert.deepEqual(queueAfterCompact(tab(), { how: 'lapsed', connected: true }), { action: 'send', line: 'The Compact did not report back. Sending the queued prompt.' });
  assert.deepEqual(queueAfterCompact(tab({ queue: two }), { how: 'reattached', connected: true }), { action: 'send', line: 'Reconnected. Sending the queued prompts.' });

  // It cannot: the prompts stay, with the reason and what sends them.
  const failed = queueAfterCompact(tab(), { how: 'failed', connected: true });
  assert.equal(failed.action, 'stop');
  assert.equal(failed.line, 'The Compact ended with an error. 1 queued prompt was not sent: resume the queue to send it.');
  const lost = queueAfterCompact(tab({ queue: two }), { how: 'lost', connected: true });
  assert.equal(lost.action, 'stop');
  assert.equal(lost.line, 'The session did not come back after the disconnect, so the Compact may not have finished. 2 queued prompts were not sent: resume the queue to send them.');
  const closed = queueAfterCompact(tab(), { how: 'closed', connected: false });
  assert.deepEqual(closed, { action: 'reconnect', line: 'Connection lost during the Compact. 1 queued prompt will be sent when the session is back.' });
  for (const how of ['lapsed', 'ended', 'reattached']) assert.equal(queueAfterCompact(tab(), { how, connected: false }).action, 'reconnect', `${how} without a socket waits for the reconnect`);

  // Nothing to do: a running turn's end advances the queue, the user paused it, or nothing of this conversation waits.
  for (const how of ['lapsed', 'ended', 'reattached']) assert.deepEqual(queueAfterCompact(tab({ running: true }), { how, connected: true }), { action: 'none', line: '' });
  for (const how of ['lapsed', 'ended', 'failed', 'closed', 'reattached', 'lost']) {
    assert.deepEqual(queueAfterCompact(tab({ queuePaused: true }), { how, connected: true }), { action: 'none', line: '' }, `${how}, paused by the user`);
    assert.deepEqual(queueAfterCompact(tab({ queue: [] }), { how, connected: true }), { action: 'none', line: '' }, `${how}, nothing queued`);
    assert.deepEqual(queueAfterCompact(tab({ queue: [{ text: 'x', conversation: 'another' }] }), { how, connected: true }), { action: 'none', line: '' }, `${how}, only a prompt of another conversation`);
  }
});

test('W06: how long a hold has left', () => {
  const tab = { running: false, _compactSentAt: NOW };
  assert.equal(compactHoldLeft(tab, NOW), COMPACT_HOLD_MS);
  assert.equal(compactHoldLeft(tab, NOW + 1000), COMPACT_HOLD_MS - 1000);
  assert.equal(compactHoldLeft(tab, NOW + COMPACT_HOLD_MS), 0, 'lapsed');
  tab._lastWsActivity = NOW + 60_000;
  assert.equal(compactHoldLeft(tab, NOW + 60_000), COMPACT_HOLD_MS, 'counted from the last thing the session said');
  assert.equal(compactHoldLeft({ running: true, _compactSentAt: NOW }, NOW), 0);
  assert.equal(compactHoldLeft({ running: false }, NOW), 0);
  assert.equal(compactHoldLeft(null, NOW), 0);
});

// ── An ordinary Compact, and a tab without one: as before ──

test('an ordinary Compact followed by a queued prompt behaves as it did: held, then sent once when `done` arrives', (t) => {
  const p = page(t);
  p.compact();
  p.type('first');
  p.type('second');
  assert.deepEqual(p.queued(), ['first', 'second']);
  p.tick(60_000);
  assert.deepEqual(p.queries(), [], 'held while the Compact runs');
  assert.deepEqual(p.said, []);

  p.receive({ type: 'done' });
  assert.equal(compactHolds(p.tab), false);
  p.tick(299);
  assert.deepEqual(p.queued(), ['first', 'second'], 'the queue advances 300 ms after `done`…');
  p.tick(1);
  assert.deepEqual(p.queued(), ['second']);
  assert.deepEqual(p.queries(), []);
  p.tick(200);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['first'], '…and the prompt goes out 200 ms later');
  assert.equal(p.queries()[0].sessionId, 'session-A');
  assert.equal(p.tab.running, true);

  // Nothing else goes out until that turn ends, however long it takes.
  p.tick(COMPACT_HOLD_MS * 2);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['first']);
  p.receive({ type: 'done' });
  p.tick(500);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['first', 'second']);
  p.receive({ type: 'done' });
  p.tick(COMPACT_HOLD_MS * 2);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['first', 'second'], 'each prompt sent once');
  assert.deepEqual(p.said, ['Queue complete'], 'and nothing said that was not said before');
  assert.equal(p.tab.queuePaused, false);
});

test('a Compact stopped by the user advances the queue as it did', (t) => {
  const p = page(t);
  p.compact();
  p.type('after the stop');
  p.receive({ type: 'aborted' });
  p.tick(500);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['after the stop']);
  p.tick(COMPACT_HOLD_MS);
  assert.equal(p.queries().length, 1);
  assert.deepEqual(p.said, ['Aborted.']);
});

test('a tab with no Compact under way behaves as before', async (t) => {
  const p = page(t);
  // Behind a running turn: queued, sent 500 ms after its `done`.
  p.tab.running = true;
  p.type('behind a turn');
  assert.deepEqual(p.queued(), ['behind a turn']);
  p.tick(COMPACT_HOLD_MS * 2);
  assert.deepEqual(p.queries(), []);
  assert.equal(p.tab._queueWaits, undefined, 'nothing is watched');
  assert.equal(p.tab._compactTimer, undefined, 'and no timer is set');
  p.receive({ type: 'done' });
  p.tick(499);
  assert.deepEqual(p.queries(), []);
  p.tick(1);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['behind a turn']);

  // A turn that ends with an error leaves the queue as it is: not sent, not paused, nothing said about it.
  p.type('behind an error');
  p.receive({ type: 'error', message: 'boom' });
  p.tick(COMPACT_HOLD_MS * 2);
  assert.equal(p.queries().length, 1);
  assert.deepEqual(p.queued(), ['behind an error']);
  assert.equal(p.tab.queuePaused, false);
  assert.deepEqual(p.errors, ['boom']);
  assert.deepEqual(p.said, []);

  // A socket that closes and comes back with nothing queued behind a Compact: nothing said, nothing paused.
  p.tab.ws.close();
  p.tick(2000);
  p.sockets.at(-1).open();
  p.receive({ type: 'reattach_result', ok: true, running: false });
  p.tick(COMPACT_HOLD_MS);
  assert.equal(p.queries().length, 1);
  assert.equal(p.tab.queuePaused, false);
  assert.deepEqual(p.said, []);

  // An idle tab is reused by the session menu.
  p.tab.queue = [];
  await p.selectSession('session-B', 'Session B');
  assert.equal(p.created.length, 0);
  assert.equal(p.tab.sessionId, 'session-B');
});

// ── W06: each way a hold ends without its `done` ──

test('W06: the session stays silent until the hold lapses: the queued prompt is sent, and the user is told', (t) => {
  const p = page(t);
  p.compact();
  p.type('waiting');
  p.tick(COMPACT_HOLD_MS - 1);
  assert.deepEqual(p.queries(), []);
  assert.equal(compactHolds(p.tab), true);
  p.tick(1);
  assert.deepEqual(p.said, ['The Compact did not report back. Sending the queued prompt.']);
  assert.equal(p.tab._compactSentAt, 0, 'the hold is over for good: a late message does not bring it back');
  assert.equal(p.tab.compacting, false);
  assert.equal(p.labels.at(-1), false, 'the "compacting" label is off');
  p.tick(200);
  assert.deepEqual(p.queries().map((msg) => [msg.prompt, msg.sessionId]), [['waiting', 'session-A']]);
  assert.deepEqual(p.queued(), []);
  p.tick(COMPACT_HOLD_MS * 2);
  assert.equal(p.queries().length, 1, 'sent once');
});

test('W06: a session that is still talking keeps the hold; the lapse is counted from its last word', (t) => {
  const p = page(t);
  p.compact();
  p.type('waiting');
  p.tick(COMPACT_HOLD_MS - 60_000);
  p.receive({ type: 'stderr', text: '' }); // anything the session says
  p.tick(60_000);
  assert.deepEqual(p.queries(), [], 'not lapsed: the session spoke a minute ago');
  assert.deepEqual(p.said, []);
  p.tick(COMPACT_HOLD_MS - 60_000 - 1);
  assert.deepEqual(p.queries(), []);
  p.tick(1 + 200);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['waiting']);
});

test('W06: prompts already in the queue when the Compact starts are moved too', (t) => {
  const p = page(t);
  p.tab.queue.push({ id: 'q1', text: 'left over', images: null, files: null, conversation: p.tab.conversation });
  p.compact();
  p.tick(COMPACT_HOLD_MS + 200);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['left over']);
  // Each of the three senders starts the watch.
  const sends = panel.split("_sendControl(tab, { type: 'compact' });");
  assert.equal(sends.length - 1, 3);
  for (const after of sends.slice(1)) assert.match(after.slice(0, 120), /^\n\s+_compactQueue\.watch\(tab\);/);
});

test('W06: the socket closes during the Compact and the session is there after the reconnect: the prompt is sent', (t) => {
  const p = page(t);
  p.compact();
  p.type('waiting');
  p.tab.ws.close(); // within the 300 ms in which the queue first tries to advance: that try waits too
  assert.equal(compactHolds(p.tab), false, 'the hold is dropped (so before)');
  assert.deepEqual(p.said, ['Connection lost during the Compact. 1 queued prompt will be sent when the session is back.']);
  assert.deepEqual(p.queued(), ['waiting'], 'kept');
  p.tick(1999);
  assert.deepEqual(p.queries(), []);
  p.tick(1); // the reconnect
  assert.equal(p.sockets.length, 2);
  p.sockets[1].open();
  assert.deepEqual(p.sent.at(-1), { type: 'reattach', windowId: 'window-1', sessionId: 'session-A' });
  assert.deepEqual(p.queries(), [], 'not before the session answered');
  p.receive({ type: 'reattach_result', ok: true, running: false, sessionId: 'session-A' });
  assert.equal(p.said.at(-1), 'Reconnected. Sending the queued prompt.');
  p.tick(200);
  assert.deepEqual(p.queries().map((msg) => [msg.prompt, msg.sessionId]), [['waiting', 'session-A']]);
  p.tick(COMPACT_HOLD_MS * 2);
  assert.equal(p.queries().length, 1);
});

test('W06: after the reconnect the session is running a turn: the prompt waits for that turn to end', (t) => {
  const p = page(t);
  p.compact();
  p.type('waiting');
  p.tab.ws.close();
  p.tick(2000);
  p.sockets[1].open();
  p.receive({ type: 'reattach_result', ok: true, running: true });
  assert.equal(p.tab.running, true);
  p.tick(60_000);
  assert.deepEqual(p.queries(), []);
  p.receive({ type: 'done' });
  p.tick(500);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['waiting']);
});

test('W06: the reconnect finds no session: the prompts stay in a paused queue, with the reason, and Resume sends them', (t) => {
  const p = page(t);
  p.compact();
  p.type('one');
  p.type('two');
  p.tick(60_000);
  p.tab.ws.close();
  p.tick(2000);
  p.sockets[1].open();
  p.receive({ type: 'reattach_result', ok: false });
  assert.equal(p.said.at(-1), 'The session did not come back after the disconnect, so the Compact may not have finished. 2 queued prompts were not sent: resume the queue to send them.');
  assert.equal(p.tab.queuePaused, true);
  assert.equal(p.tab.queueExpanded, true, 'the tray is open: the prompts are in sight');
  assert.deepEqual(p.queued(), ['one', 'two']);
  p.tick(COMPACT_HOLD_MS * 2);
  assert.deepEqual(p.queries(), [], 'nothing is sent until the user says so');

  p.pauseQueue(p.tab); // the tray's Resume
  p.tick(500);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['one']);
  p.receive({ type: 'done' });
  p.tick(500);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['one', 'two']);
});

test('W06: a tab with no session to ask after is told the same when its socket comes back', (t) => {
  const p = page(t, { sessionId: null });
  p.compact();
  p.type('waiting');
  p.tab.ws.close();
  p.tick(2000);
  p.sockets[1].open();
  assert.equal(p.sent.some((msg) => msg.type === 'reattach'), false);
  assert.match(p.said.at(-1), /^The session did not come back after the disconnect.*1 queued prompt was not sent: resume the queue to send it\.$/);
  assert.equal(p.tab.queuePaused, true);
  assert.deepEqual(p.queued(), ['waiting']);
});

test('W06: the socket closes again before the reconnect is answered: the prompts go on waiting, and nothing is said twice', (t) => {
  const p = page(t);
  p.compact();
  p.type('waiting');
  p.tab.ws.close();
  p.tick(2000);
  p.sockets[1].open();
  p.sockets[1].close();
  assert.equal(p.said.length, 1);
  assert.equal(p.tab._queueWaits, 'session');
  p.tick(2000);
  p.sockets[2].open();
  p.receive({ type: 'reattach_result', ok: true, running: false });
  p.tick(200);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['waiting']);
});

test('W06: the Compact ends with an error: the queue is stopped with the reason, and Resume sends it', (t) => {
  const p = page(t);
  p.compact();
  p.type('waiting');
  p.receive({ type: 'error', message: 'compaction failed' });
  assert.deepEqual(p.errors, ['compaction failed']);
  assert.deepEqual(p.said, ['The Compact ended with an error. 1 queued prompt was not sent: resume the queue to send it.']);
  assert.equal(p.tab.queuePaused, true);
  p.tick(COMPACT_HOLD_MS * 2);
  assert.deepEqual(p.queries(), []);
  assert.deepEqual(p.queued(), ['waiting']);
  p.pauseQueue(p.tab);
  p.tick(500);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['waiting']);
});

test('W06: the Compact\'s turn ends and no `done` follows: the queue is moved without it', (t) => {
  const p = page(t);
  p.compact();
  p.type('waiting');
  p.tick(1000);
  p.finishTab(p.tab, true); // a `result` event, the idle state, any end that is not a frame of its own
  assert.equal(compactHolds(p.tab), false);
  p.tick(COMPACT_SETTLE_MS - 1);
  assert.deepEqual(p.queued(), ['waiting'], 'the `done` is given its time');
  p.tick(1 + 200);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['waiting']);
  assert.deepEqual(p.said, []);
  p.tick(COMPACT_HOLD_MS * 2);
  assert.equal(p.queries().length, 1);
});

test('W06: a turn end followed by its `done` sends the prompt once', (t) => {
  const p = page(t);
  p.compact();
  p.type('first');
  p.type('second');
  p.finishTab(p.tab, true);
  p.tick(100);
  p.receive({ type: 'done' });
  p.tick(500);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['first']);
  p.tick(COMPACT_SETTLE_MS * 2);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['first'], 'the fallback found the queue already moved');
  assert.deepEqual(p.queued(), ['second']);
});

test('W06: a second Compact started before the fallback of the first has fired has its queue watched too', (t) => {
  const p = page(t);
  p.compact();
  p.type('waiting');
  p.tick(1000);
  p.finishTab(p.tab, true); // the first Compact's turn ended; no `done`
  p.tick(1000);
  p.compact(); // another one, before the fallback fires
  p.tick(COMPACT_SETTLE_MS);
  assert.deepEqual(p.queries(), [], 'the fallback found a Compact under way: nothing is sent into it');
  assert.deepEqual(p.queued(), ['waiting']);
  p.tick(COMPACT_HOLD_MS);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['waiting'], 'and when that one stays silent, the prompt still goes out');
  assert.deepEqual(p.said, ['The Compact did not report back. Sending the queued prompt.']);
});

test('W06: a queue the user paused is left paused by every one of these', (t) => {
  for (const end of ['lapse', 'error', 'close', 'end']) {
    const p = page(t);
    p.compact();
    p.type('waiting');
    p.pauseQueue(p.tab);
    if (end === 'lapse') p.tick(COMPACT_HOLD_MS);
    if (end === 'error') p.receive({ type: 'error', message: 'x' });
    if (end === 'end') p.finishTab(p.tab, true);
    if (end === 'close') { p.tab.ws.close(); p.tick(2000); p.sockets[1].open(); p.receive({ type: 'reattach_result', ok: true, running: false }); }
    p.tick(COMPACT_HOLD_MS);
    assert.deepEqual(p.queries(), [], end);
    assert.deepEqual(p.queued(), ['waiting'], end);
    assert.equal(p.tab.queuePaused, true, end);
    assert.deepEqual(p.said, [], `${end}: the user paused it; there is nothing to explain`);
    // Resume: it goes out.
    p.pauseQueue(p.tab);
    p.tick(500);
    assert.deepEqual(p.queries().map((msg) => msg.prompt), ['waiting'], end);
  }
});

// ── Never lost, never twice ──

test('a prompt taken off the queue with no socket to send it on goes back, and the queue is paused with the reason', (t) => {
  const p = page(t);
  p.tab.queue.push({ id: 'q1', text: 'kept', images: null, files: null, conversation: p.tab.conversation });
  p.tab.queuePaused = true;
  p.tab.ws.close();
  p.pauseQueue(p.tab); // Resume, with the socket down
  p.tick(500);
  assert.deepEqual(p.queries(), []);
  assert.deepEqual(p.queued(), ['kept'], 'not lost');
  assert.equal(p.tab.queuePaused, true);
  assert.equal(p.said.at(-1), QUEUED_REFUSAL_LINES.closed);
  // Back online: Resume sends it.
  p.tick(2000);
  p.sockets[1].open();
  p.receive({ type: 'reattach_result', ok: false });
  p.pauseQueue(p.tab);
  p.tick(500);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['kept']);
});

test('two advances inside the 200 ms before a prompt is sent take one prompt, not two', (t) => {
  const p = page(t);
  for (const text of ['first', 'second']) p.tab.queue.push({ id: text, text, images: null, files: null, conversation: p.tab.conversation });
  p.advanceQueue(p.tab);
  p.tick(100);
  p.advanceQueue(p.tab);
  p.tick(1000);
  assert.deepEqual(p.queries().map((msg) => msg.prompt), ['first']);
  assert.deepEqual(p.queued(), ['second']);
});

// ── The panel is wired to it ──

test('the hold-ending paths reach the queue: the socket, the reconnect, the error, the turn end, the session switch', () => {
  const connect = fn('connectTab');
  assert.match(connect, /tab\._compactSentAt = 0;\n[^\n]*\n\s+if \(tab\._queueWaits === 'compact'\) _compactQueue\.after\(tab, 'closed'\);/);
  assert.match(connect, /\} else if \(tab\._queueWaits === 'session'\) \{\n[^\n]*\n\s+_compactQueue\.after\(tab, 'lost'\);/);
  assert.match(REATTACH_CASE, /if \(tab\._queueWaits === 'session'\) _compactQueue\.after\(tab, 'reattached'\);/);
  assert.match(REATTACH_CASE, /if \(tab\._queueWaits === 'session'\) _compactQueue\.after\(tab, 'lost'\);/);
  assert.match(END_CASES, /case 'error':\n\s+finishTab\(tab, true\);\n[^\n]*\n\s+if \(tab\._queueWaits === 'compact'\) _compactQueue\.after\(tab, 'failed'\);/);
  assert.match(fn('finishTab'), /tab\._compactSentAt = 0;[^\n]*\n\s+_compactQueue\.ended\(tab\);/);
  const select = fn('selectSession');
  assert.match(select, /if \(compactHolds\(tab\)\) \{ inNewTab\(\); return; \}/);
  assert.match(select, /if \(!sid \|\| sid !== tab\.sessionId\) \{ tab\.conversation = newConversation\(\); _compactQueue\.drop\(tab\); \}\n\s+tab\.sessionId = sid;/);
  // Running state, not saved with the tab.
  const save = fn('saveTabs');
  for (const field of ['_queueWaits', '_compactTimer', '_queueSending']) assert.equal(save.includes(field), false, field);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { installMiniDom } from './fixtures/mini-dom.mjs';
import {
  TEMPORARY_CAPABILITY, TEMPORARY_LABEL, TEMPORARY_BANNER,
  isTemporary, keepsNothing, temporaryChoice, chooseTemporary, applyTemporary, temporaryRefusal,
  endTemporary, leaveTemporary, persistableTabs, temporaryBlocks, reattaches,
} from '../public/shared/cp/cp-temporary.js';
import { paintTemporary } from '../public/shared/cp/cp-temporary-view.js';
import * as temporary from '../public/shared/cp/cp-temporary.js';
import * as compose from '../public/shared/cp/cp-compose.js';
import { isDefaultableMode, savedMode, sessionForgotten, connectionOpened, statedMode, statementSent } from '../public/shared/cp/cp-permission-model.js';
import { normalizeSession } from '../public/shared/cp/cp-session-model.js';
import { hasCapability } from '../public/shared/cp/cp-events.js';
import { createStickyScrollController } from '../public/shared/ui-scroll-follow.js';

// The page's half of a temporary chat (docs/claude-sidepanel.md, "Temporary
// chat"): choosing it on a new tab, marking it, never writing it to a store,
// and saying why the things it cannot do are off. The decisions are in
// cp/cp-temporary.js; the monolith cannot be imported in Node, so its wiring is
// pinned from its source, as the mode model's is.

const SHARED = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'shared');
const PANEL = readFileSync(join(SHARED, 'ui-claude-panel.js'), 'utf8').replace(/\r\n/g, '\n');

const newTab = (over = {}) => ({ id: 't1', label: 'New chat', sessionId: null, running: false, turns: 0, queue: [], pendingLabel: null, titleState: 'default', ...over });
const capable = { capable: true };

// The body of a function declared in the panel file.
function fn(name) {
  const m = new RegExp(`\\n(?:async )?function ${name}\\(`).exec(PANEL);
  assert.ok(m, `function ${name} is declared in the panel`);
  let i = PANEL.indexOf('{', PANEL.indexOf(')', m.index));
  // Skip a destructured parameter list: the body is the brace after the closing parenthesis of the signature.
  let depth = 0;
  let p = PANEL.indexOf('(', m.index);
  for (; p < PANEL.length; p++) { if (PANEL[p] === '(') depth++; else if (PANEL[p] === ')') { depth--; if (!depth) break; } }
  i = PANEL.indexOf('{', p);
  depth = 0;
  for (let j = i; j < PANEL.length; j++) {
    if (PANEL[j] === '{') depth++;
    else if (PANEL[j] === '}') { depth--; if (!depth) return PANEL.slice(i, j + 1); }
  }
  assert.fail(`function ${name} has no end`);
}

// ── T1: choosing it ──────────────────────────────────────────────────────────

test('the control is offered on a new tab, and only where the bridge announces the capability', () => {
  assert.equal(TEMPORARY_CAPABILITY, 'temporary_chat');
  assert.equal(temporaryChoice(newTab(), capable).show, true);
  // A server that was not restarted does not have the bridge's half: nothing is offered.
  assert.equal(temporaryChoice(newTab(), { capable: false }).show, false);
  assert.equal(temporaryChoice(newTab()).show, false);
  assert.equal(chooseTemporary(newTab(), true, { capable: false }), false);
  // Not for a tab that shows an automation run.
  assert.equal(temporaryChoice(newTab({ automationRunId: 'run-1' }), capable).show, false);
  assert.equal(temporaryChoice(newTab({ automationActive: true }), capable).show, false);
});

test('it cannot be switched on, or off, once the conversation has started', () => {
  for (const started of [{ sessionId: 's-1' }, { running: true }, { turns: 1 }, { queue: [{ text: 'x' }] }]) {
    const tab = newTab(started);
    assert.equal(temporaryChoice(tab, capable).show, false, JSON.stringify(started));
    assert.equal(chooseTemporary(tab, true, capable), false);
    assert.equal(isTemporary(tab), false);
  }
  const tab = newTab();
  assert.equal(chooseTemporary(tab, true, capable), true);
  assert.equal(isTemporary(tab), true);
  assert.equal(tab.label, TEMPORARY_LABEL);
  // Before the first message the choice can still be taken back, and the tab is what it was.
  assert.equal(chooseTemporary(tab, false, capable), true);
  assert.equal(isTemporary(tab), false);
  assert.equal(tab.label, 'New chat');
  // The first message fixes it.
  chooseTemporary(tab, true, capable);
  const msg = applyTemporary(tab, { type: 'query', prompt: 'hello', title: 'A name' });
  assert.equal(msg.temporary, true);
  assert.ok(!('title' in msg), 'no title is sent for it');
  assert.equal(temporaryChoice(tab, capable).show, false);
  assert.equal(chooseTemporary(tab, false, capable), false);
  assert.equal(isTemporary(tab), true);
});

test('a warm start or a control states it without fixing the choice; any other tab sends nothing new', () => {
  const tab = newTab();
  chooseTemporary(tab, true, capable);
  assert.equal(applyTemporary(tab, { type: 'warm' }).temporary, true);
  assert.equal(temporaryChoice(tab, capable).show, true, 'typing is not sending');
  const plain = applyTemporary(newTab(), { type: 'query', prompt: 'x', title: 'Kept' });
  assert.deepEqual(plain, { type: 'query', prompt: 'x', title: 'Kept' });
});

test('a new conversation in the same tab is an ordinary one again', () => {
  const tab = newTab();
  chooseTemporary(tab, true, capable);
  applyTemporary(tab, { type: 'query' });
  tab.sessionId = 's-temp';
  assert.equal(leaveTemporary(tab), true);
  assert.equal(isTemporary(tab), false);
  assert.equal(tab.tempStarted, false);
  assert.equal(tab.tempEnded, '');
  assert.equal(leaveTemporary(tab), false);
});

// ── T4: nothing from SynaBun ─────────────────────────────────────────────────

test('a temporary tab is never among the tabs that are saved', () => {
  const a = newTab({ id: 'a', sessionId: 's-a' });
  const t = newTab({ id: 't', sessionId: 's-t', temporary: true, label: TEMPORARY_LABEL, queue: [{ text: 'secret' }] });
  const b = newTab({ id: 'b' });
  assert.deepEqual(persistableTabs([a, t, b], 0), { tabs: [a, b], activeIdx: 0 });
  assert.deepEqual(persistableTabs([a, t, b], 2), { tabs: [a, b], activeIdx: 1 });
  // The active tab is the temporary one: the saved state points at a tab that exists.
  assert.deepEqual(persistableTabs([a, t, b], 1), { tabs: [a, b], activeIdx: 0 });
  assert.deepEqual(persistableTabs([t, b], 0), { tabs: [b], activeIdx: 0 });
  assert.deepEqual(persistableTabs([t], 0), { tabs: [], activeIdx: -1 });
  assert.deepEqual(persistableTabs([a, b], 1), { tabs: [a, b], activeIdx: 1 });
  assert.equal(keepsNothing(t), true);
  assert.equal(keepsNothing(a), false);
  assert.equal(keepsNothing(null), false);
});

test('the panel writes a temporary tab to no store, asks for no title and never reclaims it', () => {
  // Saved tabs: only what persistableTabs() returns is written.
  const save = fn('saveTabs');
  assert.match(save, /persistableTabs\(_tabs, _activeTabIdx\)/);
  assert.doesNotMatch(save, /_tabs\.map\(/, 'the list written is the filtered one');
  // The transcript snapshot: not written, not scheduled.
  assert.match(fn('writeSessionSnapshot'), /if \(keepsNothing\(tab\)\) return;\s*\n\s*const sid = /, 'before the session id is even read');
  assert.match(fn('scheduleSessionSnapshotSave'), /keepsNothing\(tab\)/);
  // A title made from the prompt.
  assert.match(fn('requestClaudeSessionTitle'), /^\{\s*(?:\/\/[^\n]*\n\s*)*if \(keepsNothing\(tab\)\) return;/);
  // Every message that can start a session states what the tab is, in one place.
  assert.match(fn('_applySessionOptions'), /applyTemporary\(tab, msg\)/);
  // Reconnecting never asks for a temporary session back, and its end is said.
  const connect = fn('connectTab');
  assert.match(connect, /tab\.sessionId && !tab\.automationRunId && reattaches\(tab\)/);
  assert.match(connect, /_temporaryOver\(tab, 'connection'\)/);
  // Closing its tab: the socket's dispose ends it; no kill request, no lock call names it.
  const close = fn('closeTab');
  assert.match(close, /tab\.sessionId && !tab\.automationRunId && !keepsNothing\(tab\)/);
  assert.match(close, /if \(tab\.sessionId && !keepsNothing\(tab\)\) _releaseSessionLock/);
  // No heartbeat and no cost lookup carry its id.
  assert.match(fn('_startHeartbeat'), /tab\.sessionId && !keepsNothing\(tab\) && tab\.ws/);
  // The page going away ends it: the bridge is told, where the socket is still open.
  assert.match(PANEL, /window\.addEventListener\('pagehide', \(\) => \{[\s\S]{0,300}?keepsNothing\(t\) && t\.ws\?\.readyState === WebSocket\.OPEN\) \{ try \{ t\.ws\.send\(JSON\.stringify\(\{ type: 'dispose' \}\)\)/s);
  // An automation run never takes a temporary tab over.
  assert.match(PANEL, /!entry\.sessionId && !entry\.running && !entry\.turns && !keepsNothing\(entry\)/);
});

test('no name of a temporary tab reaches the label store', () => {
  // Every write of a session label. One for the tab's own session asks first
  // whether the tab is temporary (on its line, or the line above); the others
  // name another session: a fork's new one, or a row of the session menu.
  const all = PANEL.split('\n');
  const writes = all.map((text, i) => ({ text: text.trim(), i })).filter(l => l.text.includes('storage.setItem(LABEL_PREFIX'));
  assert.equal(writes.length, 7, 'a new write of a label is sorted here before it ships');
  for (const { text, i } of writes) {
    const guarded = /keepsNothing\(/.test(text) || /keepsNothing\(/.test(all[i - 1]);
    const fork = /LABEL_PREFIX \+ r\.sessionId\b/.test(text);
    const menuRow = /LABEL_PREFIX \+ sid, val\);$/.test(text) && all.slice(i - 20, i).some(l => l.includes('promptEl.textContent = currentName'));
    assert.ok(guarded || fork || menuRow, `line ${i + 1} writes a label without asking whether the tab is temporary: ${text.slice(0, 120)}`);
  }
  // A fork is only offered from a prompt's rewind menu, which a temporary chat does not have (below).
});

// ── T6: lifetime ─────────────────────────────────────────────────────────────

test('it ends with its connection, and says so once', () => {
  const tab = newTab();
  chooseTemporary(tab, true, capable);
  // Nothing was sent yet: a dropped socket ends nothing.
  assert.equal(endTemporary(tab, 'connection'), '');
  assert.equal(temporaryRefusal(tab, capable), '');
  applyTemporary(tab, { type: 'query' });
  tab.sessionId = 's-temp';
  assert.equal(reattaches(tab), false);
  assert.equal(reattaches(newTab({ sessionId: 's-1' })), true);
  const line = endTemporary(tab, 'connection');
  assert.match(line, /temporary chat/i);
  assert.match(line, /connection/i);
  assert.equal(endTemporary(tab, 'process'), '', 'said once');
  // Nothing more is sent in its name.
  assert.match(temporaryRefusal(tab, capable), /over|ended/i);
  // A tab that is not temporary is never ended or refused by this.
  assert.equal(endTemporary(newTab({ sessionId: 's-1' }), 'connection'), '');
  assert.equal(temporaryRefusal(newTab(), { capable: false }), '');
});

test('a temporary chat is never sent to a bridge that would save it', () => {
  const tab = newTab();
  chooseTemporary(tab, true, capable);
  assert.equal(temporaryRefusal(tab, capable), '');
  assert.match(temporaryRefusal(tab, { capable: false }), /restart/i);
  // The send path asks before anything leaves, and so does a queued prompt.
  assert.match(fn('send'), /temporaryRefusal\(tab, \{ capable: hasCapability\(tab, TEMPORARY_CAPABILITY\) \}\)/);
  assert.match(fn('_sendQueued'), /temporaryRefusal\(tab, \{ capable: hasCapability\(tab, TEMPORARY_CAPABILITY\) \}\)/);
});

// ── T7: what it cannot do ────────────────────────────────────────────────────

test('what it cannot do is off, each with its reason', () => {
  const tab = newTab({ temporary: true, sessionId: 's-temp' });
  for (const action of ['resume', 'history', 'fork', 'rewind', 'rename', 'plan-file']) {
    assert.match(temporaryBlocks(tab, action), /temporary chat/i, action);
    assert.equal(temporaryBlocks(newTab({ sessionId: 's-1' }), action), '', `${action} on any other tab`);
  }
  assert.equal(temporaryBlocks(tab, 'compact'), '', 'what it can do is not blocked');
  // Rename: the label, /rename and the header's two gestures.
  assert.match(fn('renameSession'), /temporaryBlocks\(activeTab\(\), 'rename'\)/);
  // Rewind and fork: the button is not put on a prompt of a temporary chat.
  assert.match(fn('_attachRewindButton'), /keepsNothing\(tab\)/);
  // Resume: a session picked in the menu opens beside it, never over it.
  assert.match(fn('selectSession'), /temporaryBlocks\(tab, 'resume'\)/);
  // History: nothing is fetched for a session that has no transcript.
  assert.match(fn('_fetchToolResultText'), /keepsNothing\(tab\)/);
});

// ── T9: permission modes ─────────────────────────────────────────────────────

test('a mode picked in a temporary tab is not stored as the default for new tabs', () => {
  const line = PANEL.split('\n').find(l => l.includes('storage.setItem(STOR.permissionMode'));
  assert.ok(line, 'the one place the default is stored');
  assert.match(line, /!keepsNothing\(tab\)/);
});

// ── T2: marking ──────────────────────────────────────────────────────────────

test('the tab says what it is: its pill, and one line at the top of the conversation', () => {
  const dom = installMiniDom();
  try {
    const messages = document.createElement('div');
    const empty = document.createElement('div');
    empty.className = 'cp-empty';
    messages.appendChild(empty);
    const pill = document.createElement('div');
    const tab = newTab({ messagesEl: messages, pillEl: pill });
    const toggled = [];
    const paint = () => paintTemporary(tab, { ...capable, onToggle: (on) => { toggled.push(on); chooseTemporary(tab, on, capable); paint(); } });

    // A new tab: the control, off; no mark.
    paint();
    const button = () => messages.querySelector('.cp-temp-choice');
    assert.ok(button(), 'the control is in the empty state');
    assert.equal(button().getAttribute('aria-pressed'), 'false');
    assert.equal(messages.querySelector('.cp-temp-banner'), null);
    assert.equal(pill.classList.contains('cp-pill-temporary'), false);

    // Chosen: the line says what it means, before the first message is sent.
    button().fire('click');
    assert.deepEqual(toggled, [true]);
    assert.equal(button().getAttribute('aria-pressed'), 'true');
    const banner = messages.querySelector('.cp-temp-banner');
    assert.equal(banner.textContent, TEMPORARY_BANNER);
    assert.equal(messages.firstElementChild, banner, 'at the top');
    assert.equal(pill.classList.contains('cp-pill-temporary'), true);
    for (const word of [/not saved|nothing here is saved/i, /read-only/i, /closed/i, /reloaded/i]) assert.match(TEMPORARY_BANNER, word);

    // Started: the control is gone, the line stays at the top whatever is added below or cleared.
    applyTemporary(tab, { type: 'query' });
    tab.sessionId = 's-temp';
    const row = document.createElement('div');
    row.className = 'msg';
    messages.appendChild(row);
    paint();
    assert.equal(button(), null);
    assert.equal(messages.firstElementChild.className, 'cp-temp-banner');
    messages.innerHTML = '';
    paint();
    assert.equal(messages.querySelectorAll('.cp-temp-banner').length, 1, 'put back after the transcript is cleared');
    paint();
    assert.equal(messages.querySelectorAll('.cp-temp-banner').length, 1, 'never twice');

    // Ended: the line says so.
    endTemporary(tab, 'connection');
    paint();
    assert.match(messages.querySelector('.cp-temp-banner').textContent, /ended/i);

    // New chat: no mark, and the control is back for the new conversation.
    leaveTemporary(tab);
    tab.sessionId = null;
    messages.appendChild(empty);
    paint();
    assert.equal(messages.querySelector('.cp-temp-banner'), null);
    assert.equal(pill.classList.contains('cp-pill-temporary'), false);
    assert.ok(button());

    // Against a server that was not restarted nothing is shown at all.
    paintTemporary(tab, { capable: false, onToggle: () => {} });
    assert.equal(button(), null);
  } finally { dom.restore(); }
});

test('the panel repaints the mark wherever the conversation area is rebuilt', () => {
  assert.match(fn('_paintTemporary'), /paintTemporary\(tab, \{ capable: hasCapability\(tab, TEMPORARY_CAPABILITY\), onToggle:/);
  for (const name of ['createTab', 'switchTab', 'selectSession']) assert.match(fn(name), /_paintTemporary\(/, name);
  // The hello is what says whether the control exists.
  assert.match(PANEL, /tab\.capabilities = new Set\(hello\.capabilities\);\s*\n\s*_paintTemporary\(tab\);/);
  // New chat and a session switch leave the temporary conversation.
  assert.match(fn('selectSession'), /leaveTemporary\(tab\)/);
  // The bridge's word that its process is gone, and a refusal that says the same.
  assert.match(PANEL, /case 'temporary_ended':/);
  assert.match(PANEL, /msg\.code === 'temporary_ended'/);
});

// ── Review of 2026-10-04: what is left when a temporary chat ends, and the choice taken back ──
//
// The panel's own functions, cut out of its source and run against stand-ins
// for what they call (as tests/claude-panel-review6-fixes.test.mjs does): one
// tab, an open socket, a storage and a fetch that record what leaves the page.

const cut = (name) => {
  const found = new RegExp(`\\n(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`).exec(PANEL)?.[0];
  assert.ok(found, `${name}() found in the panel`);
  return found;
};
const PAGE_FUNCTIONS = ['newTabState', 'connectTab', '_afterTemporary', 'selectSession', 'saveTabs', '_checkSessionLock', '_releaseSessionLock', 'addToQueue', '_pushPromptHistory', '_navigatePromptHistory',
  'writeSessionSnapshot', 'scheduleSessionSnapshotSave', 'flushSessionSnapshotSave', '_applySessionOptions', 'send'];

// A socket as connectTab() opens one. It records what is sent on it; the test
// plays the bridge and the network: open(), deliver() (also of a message that
// arrives late), fire('close').
function socketsOf(p) {
  return class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closed = false; this.listeners = {}; p.sockets.push(this); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    fire(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
    send(data) { const msg = JSON.parse(data); this.sent.push(msg); p.sent.push(msg); }
    close() { this.closed = true; this.readyState = 3; }
    open() { this.readyState = 1; this.fire('open'); }
    deliver(msg) { this.fire('message', { data: JSON.stringify(msg) }); }
  };
}

// A conversation area: what the scroll controller needs of one
// (ui-scroll-follow.js), with observers that record what they watch. Markup is
// stored, not parsed: one row stands for the content.
function conversationArea(p) {
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = new Set(); this.live = true; p.observers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); this.live = false; }
  }
  class Resize extends Observer {}
  class Mutation extends Observer {}
  const listeners = new Map();
  let html = '';
  const area = {
    ownerDocument: { defaultView: { ResizeObserver: Resize, MutationObserver: Mutation, requestAnimationFrame: () => 0, cancelAnimationFrame() {} } },
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, children: [],
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = String(value);
      area.children = html ? [{ row: html }] : [];
      for (const o of p.observers) if (o instanceof Mutation && o.live && o.targets.has(area)) o.callback([]);
    },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    listening: (type) => listeners.get(type)?.size || 0,
    scrollTo() {},
    querySelectorAll: () => [],
  };
  return area;
}

function page() {
  const p = { sent: [], said: [], fetched: [], writes: [], created: [], switched: [], input: { value: '' }, tabs: [], sockets: [], observers: [], handled: [], over: [], snapshots: {} };
  const stored = new Map();
  let ids = 0;
  const env = {
    ...compose, ...temporary, isDefaultableMode, savedMode, sessionForgotten, normalizeSession, connectionOpened, statedMode, statementSent, hasCapability, createStickyScrollController,
    WebSocket: socketsOf(p),
    location: { protocol: 'http:', host: 'localhost:3344' },
    // What the panel's handler does with the messages of these sequences (each pinned from its source in test A):
    // the hello, the end of an interrupted turn, an answer drawn into the transcript, a result that names the session.
    handleTabMsg: (tab, msg) => {
      p.handled.push(msg);
      if (msg.type === 'engine') { tab.capabilities = new Set(msg.capabilities); tab.sdkMode = true; return; }
      if (msg.type === 'aborted') { tab.running = false; return; }
      const ev = msg.type === 'event' ? msg.event : null;
      if (ev?.type === 'assistant') { tab.messagesEl.innerHTML += `<div class="msg-assistant">${ev.message.content[0].text}</div>`; p.scheduleSessionSnapshotSave(tab); }
      if (ev?.type === 'result' && ev.session_id) { tab.sessionId = ev.session_id; p.saveTabs(); }
    },
    _temporaryOver: (tab, reason) => { p.over.push(reason); },
    _sessionSnapshots: p.snapshots, _persistSessionSnapshots() {}, _armSnapshotFlusher() {},
    _cliInstalled: true, _cliInstallFailureForced: false, _modeBridge: () => ({ numbered: false, bypass: false }),
    _getModelId: () => 'model-picked', _getEffort: () => 'off', buildPromptWithAttachments: (tab, text) => text,
    setRunning: (tab, on) => { tab.running = on; },
    hideSlashHints() {}, requestClaudeSessionTitle() {}, appendUser() {}, showThinking() {}, updateAttachBadge() {}, recordHookEvent() {}, _renderSuggestion() {},
    crypto: { randomUUID: () => `id-${++ids}` },
    fetch: async (url, init) => { p.fetched.push(`${url} ${init?.body || ''}`); return { json: async () => ({ ok: true }) }; },
    storage: { getItem: (k) => (stored.has(k) ? stored.get(k) : null), setItem: (k, v) => { stored.set(k, String(v)); p.writes.push(`${k} ${v}`); }, removeItem: (k) => { stored.delete(k); } },
    STOR: { tabs: 'tabs-of-window-1', permissionMode: 'default-mode' },
    _panel: { querySelector: (selector) => (selector === '#cp-input' ? p.input : null) },
    _tabs: p.tabs, _activeTabIdx: 0, _windowId: 'window-1', nativeLoopWindowId: 'window-1', MAX_TABS: 3, CLAUDE_ICON: '',
    activeTab: () => p.tabs[0],
    appendStatus: (tab, text) => { p.said.push(text); },
    createTab: (sid, label) => { p.created.push({ sid, label }); },
    switchTab: (idx) => { p.switched.push(idx); p.input.value = p.tabs[idx].draft || ''; }, // what switchTab() does to the composer (pinned below)
    ddGetValue: () => '/projects/demo',
    _getDefaultModel: () => 'model-default',
    _compactQueue: { drop() {}, watch() {}, after() {} },
    _setCompactingUI() {}, renderQueue() {}, _updateCostLabel() {}, _paintMode() {}, renderGauge() {},
    updatePillLabel() {}, _paintTemporary() {}, loadSessionHistory() {}, _updateWindowRegistry() {}, autoResize() {}, advanceQueue() {},
  };
  const names = Object.keys(env);
  const source = `${PAGE_FUNCTIONS.map(cut).join('\n')}\nreturn { ${PAGE_FUNCTIONS.join(', ')} };`;
  Object.assign(p, new Function(...names, source)(...names.map((name) => env[name])));
  p.stored = stored;
  return p;
}

// A tab as createTab() makes one: its conversation area and scroll controller,
// its socket, and the bridge's hello on it.
const HELLO = [TEMPORARY_CAPABILITY, 'session_title', 'tool_policy', 'session_settings', 'accounts'];
function openTab(p, sessionId = null, label = 'New chat') {
  const tab = p.newTabState(sessionId, label, null);
  tab.messagesEl = conversationArea(p);
  tab.scrollController = createStickyScrollController(tab.messagesEl, { active: false });
  tab.pillEl = { tag: 'pill' };
  p.tabs.push(tab);
  p.connectTab(tab);
  tab.ws.open();
  tab.ws.deliver({ type: 'engine', engine: 'sdk', capabilities: HELLO });
  p.handled.length = 0;
  return tab;
}

// A temporary conversation as the reviewer left it: a sent prompt, a queue
// that is paused with a prompt and its attachments in it, a draft, an
// attachment in the composer, a hook event, and a field nobody has added yet.
const SECRET = 'PRIVATE';
const TEMP_SESSION = 'temp-session-5f3a';
function temporaryConversation(p) {
  const tab = openTab(p);
  assert.equal(chooseTemporary(tab, true, capable), true);
  applyTemporary(tab, { type: 'query', prompt: `${SECRET} first prompt` });
  tab.sessionId = TEMP_SESSION;
  tab.turns = 1;
  p._pushPromptHistory(tab, `${SECRET} sent prompt`);
  tab.queuePaused = true;
  p.addToQueue(tab, `${SECRET} queued prompt`, [{ base64: `${SECRET}QUEUEDIMAGE`, mediaType: 'image/png' }], [{ name: 'notes.txt', path: '/x/notes.txt', content: `${SECRET} queued file content` }]);
  tab.draft = `${SECRET} draft`;
  p.input.value = tab.draft;
  tab.attachedFiles.push({ name: 'a.txt', content: `${SECRET} attached file` });
  tab.attachedImages.push({ base64: `${SECRET}ATTACHEDIMAGE`, mediaType: 'image/png' });
  tab.hookEvents.push({ event: 'UserPromptSubmit', detail: `${SECRET} hook detail`, at: 1 });
  tab.sessionCost = 0.42;
  tab._btwPending = { text: `${SECRET} aside` };
  tab._modelChangedMidTurn = true; // two fields selectSession() itself writes for every conversation it opens
  tab._compactSentAt = 12345;
  tab.aFieldAddedNextYear = `${SECRET} something new`;
  p.writes.length = 0;
  p.fetched.length = 0;
  p.sent.length = 0;
  return tab;
}

// Every string reachable from a value: own properties of any kind, array and Map and Set members.
function strings(value, seen = new Set(), out = []) {
  if (typeof value === 'string') { out.push(value); return out; }
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (value instanceof Map) { for (const [k, v] of value) { strings(k, seen, out); strings(v, seen, out); } }
  if (value instanceof Set) { for (const v of value) strings(v, seen, out); }
  for (const key of Reflect.ownKeys(value)) { if (typeof key === 'string') out.push(key); strings(value[key], seen, out); }
  return out;
}

test('R1: New chat after a temporary conversation leaves nothing of it on the tab or in the saved tabs', async () => {
  const p = page();
  const tab = temporaryConversation(p);
  // While it is temporary nothing is written (the confirmed behaviour).
  p.saveTabs();
  assert.ok(!p.writes.join('\n').includes(SECRET) && !p.writes.join('\n').includes(TEMP_SESSION));

  await p.selectSession(null, 'New chat');

  assert.equal(isTemporary(tab), false, 'the tab is an ordinary one');
  assert.equal(p.tabs[0], tab, 'the same tab, in the same place');
  // The saved tabs: the ordinary tab is there, and nothing of the conversation it left.
  const saved = JSON.parse(p.stored.get('tabs-of-window-1'));
  assert.equal(saved.tabs.length, 1);
  assert.equal(saved.tabs[0].id, tab.id);
  assert.deepEqual(saved.tabs[0].queue, [], 'no queued prompt, no attachment of one');
  assert.equal(saved.tabs[0].sessionId, null);
  assert.equal(saved.tabs[0].sessionCost, 0);
  for (const written of p.writes) {
    assert.ok(!written.includes(SECRET), `written to storage: ${written.slice(0, 160)}`);
    assert.ok(!written.includes(TEMP_SESSION), 'the session id is not written either');
  }
  // Up and Ctrl+R read tab.promptHistory and nothing else: neither shows a prompt of the conversation.
  assert.deepEqual(tab.promptHistory, []);
  p.input.value = '';
  assert.equal(p._navigatePromptHistory(tab, -1, p.input), false, 'Up finds nothing');
  assert.equal(p.input.value, '');
  assert.match(fn('_openReverseSearch'), /const hist = tab\.promptHistory\.slice\(\)\.reverse\(\);/);
  assert.doesNotMatch(fn('_openReverseSearch').replace('tab.promptHistory.slice()', ''), /promptHistory|\.draft|\.queue/);
  // The composer: no draft, no attachment, and it is drawn again from the tab.
  assert.equal(tab.draft, '');
  assert.deepEqual([tab.attachedFiles, tab.attachedImages, tab.queue, tab.hookEvents], [[], [], [], []]);
  assert.equal(tab.queuePaused, false);
  assert.deepEqual(p.switched, [0], 'the composer, the previews and the widgets are repainted from the tab');
  assert.equal(p.input.value, '');
  assert.match(fn('switchTab'), /if \(\$input\) \{ \$input\.value = tab\.draft \|\| ''; autoResize\(\); \}/);
  assert.match(fn('switchTab'), /preview\.innerHTML = '';\s*\n\s*tab\.attachedImages\.forEach/);
  // Nothing anywhere on the tab object.
  for (const text of strings(tab)) assert.ok(!text.includes(SECRET) && !text.includes(TEMP_SESSION), `left on the tab: ${text.slice(0, 120)}`);
  assert.ok(!('aFieldAddedNextYear' in tab) && !('_btwPending' in tab));
});

test('R1: every own property of the tab is either on the list of what is carried over, or a new tab\'s', async () => {
  // The list, and why each is on it. A field added to it is added here too.
  const identity = ['id', 'messagesEl', 'pillEl', 'project'];
  // The owner's own configuration of the tab: what an ordinary New chat keeps of it (rule B).
  const settings = ['model', 'effort', 'toolPolicy', 'accountId', 'session', 'viewMode', 'todosVisible', 'hookStripVisible'];
  const mode = ['permissionMode', 'modeChosen', 'bypassChosen', 'planFrom', 'planMode', 'modeSeq', 'modeSent', 'modeUnsent', 'actualMode', 'actualSeq', 'mayBypass', 'settingsMode', 'runMode', 'modeRev', 'modeRevNow', 'modeRevOf'];
  assert.deepEqual(Object.keys(temporary.CARRIED_OVER).sort(), [...identity, ...settings, ...mode].sort());
  // Not on it: the conversation's socket and what its hello said (rule A), its scroll controller (rule C),
  // and what the conversation produced (rule B: the rules granted while it ran, the queue and its state).
  for (const gone of ['ws', 'reconnectTimer', 'sdkMode', 'sdkVersion', 'capabilities', '_lastWsActivity', 'scrollController', 'grantedRules', 'queue', 'queuePaused', 'queueExpanded']) {
    assert.ok(!Object.hasOwn(temporary.CARRIED_OVER, gone), `${gone} is not carried over`);
  }
  for (const [name, why] of Object.entries(temporary.CARRIED_OVER)) assert.ok(typeof why === 'string' && why.length >= 12, `${name} says why`);
  assert.ok(Object.isFrozen(temporary.CARRIED_OVER));

  // The pure half: every property the old tab has holds something of the conversation.
  const p = page();
  const marked = (key) => ({ of: 'the temporary conversation', key });
  const old = {};
  for (const key of [...Object.keys(p.newTabState(null, 'New chat', null)), ...Object.keys(temporary.CARRIED_OVER), '_planContent', '_btwPending', 'aFieldAddedNextYear']) old[key] = marked(key);
  old[Symbol.for('hidden')] = marked('symbol');
  Object.defineProperty(old, 'quiet', { value: marked('quiet'), enumerable: false, configurable: true, writable: true });
  const fresh = p.newTabState(null, 'New chat', 'tab-id');
  const result = temporary.tabAfterTemporary(old, fresh);
  assert.equal(result, old, 'the same object: every listener and list that holds the tab keeps holding it');
  for (const key of Reflect.ownKeys(old)) {
    if (Object.hasOwn(temporary.CARRIED_OVER, key)) assert.deepEqual(old[key], marked(key), `${String(key)} is carried over`);
    else {
      assert.ok(Object.hasOwn(fresh, key), `${String(key)} is not a new tab's and not on the list: it is not there`);
      assert.equal(old[key], fresh[key], `${String(key)} is what a new tab has`);
    }
  }
  for (const key of Reflect.ownKeys(fresh)) assert.ok(Object.hasOwn(old, key), `${String(key)}: a new tab has it`);

  // The same walk over the real sequence: a conversation, New chat, and then every own property.
  const live = page();
  const tab = temporaryConversation(live);
  const before = new Map(Reflect.ownKeys(tab).map(key => [key, tab[key]]));
  await live.selectSession(null, 'New chat');
  const newTab = live.newTabState(null, 'New chat', tab.id);
  for (const key of Reflect.ownKeys(tab)) {
    const value = tab[key];
    if (Object.hasOwn(temporary.CARRIED_OVER, key)) continue;
    if (!Object.hasOwn(newTab, key)) {
      // Not a new tab's field: selectSession() wrote it after the tab was made new (a constant it sets for
      // every conversation it opens). It is not what the conversation left there.
      assert.ok(!before.has(key) || !isDeepStrictEqual(value, before.get(key)), `${String(key)} stayed on the tab with what it held, and is neither a new tab's field nor on the list`);
      continue;
    }
    if (value && typeof value === 'object') assert.notEqual(value, before.get(key), `${String(key)} is still the object the temporary conversation filled`);
    // …and holds exactly what a new tab holds (the conversation's name is a new one each time, and so is
    // the socket selectSession() opens for the next conversation).
    if (key !== 'conversation' && key !== 'ws') assert.ok(isDeepStrictEqual(value, newTab[key]), `${String(key)} is not what a new tab has`);
  }
  // What identifies the tab did stay, and so did the owner's configuration of it.
  for (const key of ['id', 'messagesEl', 'pillEl', 'project', ...settings]) assert.equal(tab[key], before.get(key), key);
  // What a new tab starts with is what the tab has (the conversation id is a new one each time).
  for (const key of ['label', 'titleState', 'turns', 'sessionCost', 'temporary', 'tempStarted', 'tempEnded', 'grantedRules', 'queue', 'queuePaused', 'queueExpanded', 'sdkMode', 'reconnectTimer']) assert.deepEqual(tab[key], newTab[key], key);
  for (const key of ['capabilities', 'sdkVersion', '_lastWsActivity']) assert.ok(!(key in tab), `${key}: said on the socket that is gone`);
});

test('R1: a session picked on a tab whose temporary chat was only chosen leaves the choice behind the same way', async () => {
  const p = page();
  const tab = openTab(p);
  chooseTemporary(tab, true, capable);
  tab.draft = `${SECRET} typed, never sent`;
  tab.attachedFiles.push({ name: 'a.txt', content: `${SECRET} attached` });
  await p.selectSession('session-B', 'Session B');
  assert.equal(isTemporary(tab), false);
  assert.equal(tab.sessionId, 'session-B');
  assert.equal(tab.label, 'Session B');
  assert.equal(tab.titleState, 'manual');
  for (const text of strings(tab)) assert.ok(!text.includes(SECRET), text.slice(0, 80));
  assert.deepEqual(p.sent, [{ type: 'dispose' }]);
});

test('R3: no request of the page names a temporary tab\'s session; only the conversation\'s own messages do, on its own socket', async () => {
  const p = page();
  const tab = temporaryConversation(p);
  await p.selectSession(null, 'New chat');
  // The bridge is told to end the session, on the tab's own socket, without a name.
  assert.deepEqual(p.sent, [{ type: 'dispose' }]);
  // No request: not a lock release, not a kill, not a cost or history read.
  assert.deepEqual(p.fetched.filter(call => call.includes(TEMP_SESSION)), []);
  assert.deepEqual(p.fetched.filter(call => call.includes('session-lock')), [], 'no lock was taken for it, so none is released');
  // An ordinary tab still releases the lock of the session it leaves.
  const q = page();
  const plain = q.newTabState('session-A', 'Session A', null);
  Object.assign(plain, { messagesEl: { innerHTML: '' }, ws: { readyState: 1, send: (data) => q.sent.push(JSON.parse(data)) } });
  q.tabs.push(plain);
  await q.selectSession(null, 'New chat');
  assert.equal(q.fetched.filter(call => call.includes('session-lock') && call.includes('"release"') && call.includes('session-A')).length, 1);
  assert.deepEqual(q.sent, [], 'and its session is not disposed: the next message replaces it');

  // The conversation itself does name its session: a later message of it carries the id, on the
  // conversation's own socket, to the bridge session that holds it. Nothing else does.
  const r = page();
  temporaryConversation(r);
  r.input.value = 'more';
  r.send();
  assert.deepEqual(r.sent.map(m => [m.type, m.sessionId, m.temporary]), [['query', TEMP_SESSION, true]]);
  assert.deepEqual(r.sockets.map(socket => socket.sent.length), [1], 'on the one socket the conversation has');
  assert.deepEqual(r.fetched.filter(call => call.includes(TEMP_SESSION)), [], 'and in no request');

  // Every place of the page that puts a tab's session id into a request, or
  // into a socket message that is not the conversation's own (a reattach, a
  // heartbeat), asks first whether the tab keeps nothing, or cannot be reached
  // by a temporary tab at all. A new one is sorted here before it ships.
  const lines = PANEL.split('\n');
  const guardedNear = (i, span = 6) => lines.slice(Math.max(0, i - span), i + 1).some(l => /keepsNothing\(|reattaches\(/.test(l));
  const sites = lines.map((text, i) => ({ text: text.trim(), i })).filter(({ text }) =>
    /_releaseSessionLock\(tab\.sessionId\)|kill-session|type: 'heartbeat'|\/cost\/session\/\$\{tab\.sessionId\}|sessions\/\$\{encodeURIComponent\(tab\.sessionId\)\}|type: 'reattach'/.test(text));
  assert.ok(sites.length >= 6, 'the sites are found');
  for (const { text, i } of sites) assert.ok(guardedNear(i), `line ${i + 1} names the tab's session without asking whether it is temporary: ${text.slice(0, 140)}`);
});

// ── Second round (the confirmation review of 2026-10-04): rules A, B and C ──

test('A: what a temporary conversation sends late reaches nothing of the next conversation in its tab', async () => {
  const p = page();
  const tab = temporaryConversation(p);
  const old = tab.ws;
  // A turn is running and part of its answer is drawn. The user interrupts it; the bridge says so.
  tab.running = true;
  tab.messagesEl.innerHTML = `<div class="msg-assistant">${SECRET} answer so far</div>`;
  old.deliver({ type: 'aborted' });
  assert.equal(tab.running, false);
  p.handled.length = 0;
  p.sent.length = 0;

  // New chat, before the rest of the interrupted turn's output has arrived.
  await p.selectSession(null, 'New chat');
  const view = tab.messagesEl.innerHTML;
  assert.ok(!view.includes(SECRET));

  // It arrives now, on the socket the temporary conversation had: the answer, its result (which names the
  // session), the end of the turn. Then the tab is left, which is when its transcript snapshot is written.
  old.deliver({ type: 'event', event: { type: 'assistant', session_id: TEMP_SESSION, message: { role: 'assistant', content: [{ type: 'text', text: `${SECRET} late answer` }] } } });
  old.deliver({ type: 'event', event: { type: 'result', subtype: 'success', session_id: TEMP_SESSION, total_cost_usd: 0.5 } });
  old.deliver({ type: 'done' });
  p.flushSessionSnapshotSave(tab);

  assert.deepEqual(p.handled, [], 'nothing received on the old socket after New chat is handled');
  assert.equal(tab.messagesEl.innerHTML, view, 'the transcript view is what New chat made it');
  assert.equal(tab.sessionId, null, 'the old session id is not put back');
  assert.deepEqual(p.snapshots, {}, 'no transcript snapshot');
  for (const written of p.writes) assert.ok(!written.includes(SECRET) && !written.includes(TEMP_SESSION), `written to storage: ${written.slice(0, 160)}`);
  assert.deepEqual(p.fetched.filter(call => call.includes(TEMP_SESSION)), []);
  for (const text of strings(tab)) assert.ok(!text.includes(SECRET) && !text.includes(TEMP_SESSION), `on the tab: ${text.slice(0, 120)}`);

  // The socket ended with the conversation: the dispose went out on it, then it was closed, and the tab
  // no longer listens to it (its close neither ends a chat nor starts a reconnect).
  assert.deepEqual(old.sent.slice(-1), [{ type: 'dispose' }]);
  assert.equal(old.closed, true);
  old.fire('close');
  assert.deepEqual(p.over, []);
  assert.equal(tab.reconnectTimer, null);
  // The next conversation has a socket of its own, and its first message goes out there.
  const next = tab.ws;
  assert.ok(next && next !== old, 'a new socket');
  assert.deepEqual(p.sockets, [old, next]);
  next.open();
  next.deliver({ type: 'engine', engine: 'sdk', capabilities: HELLO });
  p.input.value = 'the next conversation';
  p.send();
  assert.equal(next.sent.length, 1);
  assert.equal(next.sent[0].type, 'query');
  assert.equal(next.sent[0].prompt, 'the next conversation');
  assert.ok(!('sessionId' in next.sent[0]) && !('temporary' in next.sent[0]), 'an ordinary conversation that names no session');
  assert.deepEqual(p.sent, [{ type: 'dispose' }, next.sent[0]], 'nothing else left the page');
  assert.deepEqual(old.sent.slice(-1), [{ type: 'dispose' }], 'and nothing more on the old socket');

  // The stand-in handler above does what the panel's does with these messages, and the tab that is left is flushed.
  assert.match(PANEL, /if \(ev\.session_id\) \{ tab\.sessionId = ev\.session_id; saveTabs\(\); \}/);
  assert.match(PANEL, /renderAssistant\(scope, ev\.message\);/);
  assert.match(fn('switchTab'), /flushSessionSnapshotSave\(prev\);/);
  // The listeners of a socket act on the tab's own socket only: that is what ends the listening.
  assert.match(fn('connectTab'), /ws\.addEventListener\('message', \(e\) => \{\s*\n\s*if \(tab\.ws !== ws\) return;/);
});

test('A: an ordinary New chat keeps its socket; only a temporary conversation takes its socket with it', async () => {
  const p = page();
  const tab = openTab(p, 'session-A', 'Session A');
  const socket = tab.ws;
  const controller = tab.scrollController;
  const sent = socket.sent.length;
  await p.selectSession(null, 'New chat');
  assert.equal(tab.ws, socket);
  assert.equal(socket.closed, false);
  assert.deepEqual(p.sockets, [socket]);
  assert.equal(socket.sent.length, sent, 'no dispose: the next message replaces the session');
  assert.equal(tab.scrollController, controller);
});

test('B: after New chat the tab keeps the owner\'s own settings, and nothing the conversation produced', async () => {
  const p = page();
  const tab = temporaryConversation(p);
  // The owner's configuration of the tab.
  const session = normalizeSession({ ...tab.session, fastMode: true, maxTurns: 7, systemPromptAppend: 'Answer briefly.', disallowedTools: ['WebFetch'] });
  assert.notDeepEqual(session, normalizeSession(null));
  const own = { model: 'model-other', effort: 'high', toolPolicy: 'read-only', accountId: 'work', viewMode: 'focus', todosVisible: true, hookStripVisible: true };
  Object.assign(tab, own, { session });
  // What the conversation produced: a rule granted from one of its cards, and its queue (in the fixture: one prompt, paused).
  tab.grantedRules.push({ toolName: 'Bash', ruleContent: `${SECRET}:*`, behavior: 'allow' });
  tab.queueExpanded = true;
  assert.equal(tab.queue.length, 1);

  await p.selectSession(null, 'New chat');

  for (const [key, value] of Object.entries(own)) assert.equal(tab[key], value, key);
  assert.deepEqual(tab.session, session);
  assert.deepEqual(tab.grantedRules, [], 'no granted rules');
  assert.deepEqual([tab.queue, tab.queuePaused, tab.queueExpanded], [[], false, false], 'no queue');
  for (const text of strings(tab)) assert.ok(!text.includes(SECRET), `on the tab: ${text.slice(0, 120)}`);
  // The saved tab says the same.
  const saved = JSON.parse(p.stored.get('tabs-of-window-1')).tabs[0];
  assert.deepEqual([saved.model, saved.effort, saved.toolPolicy, saved.accountId], ['model-other', 'high', 'read-only', 'work']);
  assert.deepEqual(saved.session, session);
  assert.deepEqual([saved.queue, saved.queuePaused], [[], false]);
  // And the next conversation starts under them: its first message states the tool policy, the account and the settings.
  tab.ws.open();
  tab.ws.deliver({ type: 'engine', engine: 'sdk', capabilities: HELLO });
  p.input.value = 'next';
  p.send();
  const query = tab.ws.sent[0];
  assert.equal(query.type, 'query');
  assert.equal(query.toolPolicy, 'read-only');
  assert.equal(query.accountId, 'work');
  assert.deepEqual(query.session, session);
});

test('C: the scroll controller goes with the conversation', async () => {
  const p = page();
  const tab = temporaryConversation(p);
  const area = tab.messagesEl;
  const before = tab.scrollController;
  // The transcript: the controller watches each of its rows (ui-scroll-follow.js).
  area.innerHTML = `<div class="msg-assistant">${SECRET} answer</div>`;
  const rows = [...area.children];
  const watching = (row) => p.observers.filter(o => o.live && o.targets.has(row)).length;
  assert.ok(rows.length && rows.every(row => watching(row) === 1), 'the rows of the conversation are observed');
  const old = [...p.observers];

  await p.selectSession(null, 'New chat');

  // The controller of the conversation is destroyed: its observers watch nothing, its listeners are off the area.
  for (const o of old) assert.ok(!o.live && o.targets.size === 0, 'an observer of the old controller is disconnected');
  for (const row of rows) assert.equal(watching(row), 0, 'no row of the old transcript is still observed');
  assert.equal(before.scrollToBottom({ force: true, immediate: true }), false, 'the old controller does nothing more');
  // The next conversation has one of its own, on the same area, made after the area was emptied.
  const after = tab.scrollController;
  assert.ok(after && after !== before, 'a new controller');
  assert.equal(after.scrollToBottom({ force: true, immediate: true }), true, 'and it follows (the tab is the active one)');
  const live = p.observers.filter(o => o.live);
  assert.equal(live.length, 2, 'one resize observer and one mutation observer');
  for (const o of live) assert.ok(o.targets.has(area));
  for (const type of ['scroll', 'wheel', 'keydown', 'touchstart']) assert.equal(area.listening(type), 1, `one ${type} listener on the area`);
  assert.ok(area.innerHTML.includes('cp-empty'));
  for (const row of area.children) assert.equal(watching(row), 1, 'the new content is what it watches');
});

test('R2: choosing Temporary and taking the choice back are exact inverses', () => {
  // A tab renamed before its first message: the name is the title Claude Code gets.
  const renamed = () => newTab({ label: 'Quarterly numbers', pendingLabel: 'Quarterly numbers', titleState: 'manual', planFilePath: '/plans/older.md', _warmSentAt: 1234, tempStarted: false, tempEnded: '', temporary: false });
  for (const make of [renamed, newTab, () => newTab({ label: 'Auto title', titleState: 'auto', pendingLabel: 'Auto title' })]) {
    const tab = make();
    const before = structuredClone(tab);
    assert.equal(chooseTemporary(tab, true, capable), true);
    assert.equal(tab.label, TEMPORARY_LABEL);
    assert.equal(tab.pendingLabel, null, 'a temporary chat is sent no title');
    assert.ok(!tab.planFilePath, 'and has no plan file');
    assert.ok(!('title' in applyTemporary(tab, { type: 'warm', title: 'x' })));
    assert.equal(chooseTemporary(tab, false, capable), true);
    assert.deepEqual(tab, before, 'the tab is what it was');
    assert.deepEqual(Reflect.ownKeys(tab).sort(), Reflect.ownKeys(before).sort(), 'no field more, none less');
    // …also the second time round.
    chooseTemporary(tab, true, capable);
    chooseTemporary(tab, false, capable);
    assert.deepEqual(tab, before);
  }
  // The title reaches Claude Code: the first message of the ordinary conversation carries it.
  const tab = renamed();
  chooseTemporary(tab, true, capable);
  chooseTemporary(tab, false, capable);
  assert.equal(tab.pendingLabel, 'Quarterly numbers');
  assert.match(fn('_applySessionOptions'), /!tab\.sessionId && tab\.pendingLabel\) msg\.title = tab\.pendingLabel;/);
  assert.equal(tab.titleState, 'manual', 'and no generated title replaces it');
  // The panel's wrapper writes no field of its own: everything the choice touches is in cp-temporary.js.
  assert.doesNotMatch(fn('_chooseTemporary'), /tab\.\w+\s*=[^=]/);
  // What the choice left behind is gone with the conversation too.
  chooseTemporary(tab, true, capable);
  applyTemporary(tab, { type: 'query' });
  leaveTemporary(tab);
  assert.deepEqual(Reflect.ownKeys(tab).filter(key => /before/i.test(String(key))), []);
});

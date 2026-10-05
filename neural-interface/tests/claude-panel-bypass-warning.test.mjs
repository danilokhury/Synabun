import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installMiniDom } from './fixtures/mini-dom.mjs';
import { setCpCtx } from '../public/shared/cp/cp-ctx.js';
import { ClaudeSession, configureClaudeBridge, createClaudeBridge, shutdownAllBridges } from '../lib/claude-agent-bridge.js';
import * as model from '../public/shared/cp/cp-permission-model.js';
import { renderPlanApprovalCard } from '../public/shared/cp/cp-permissions.js';
import { scrubSavedTab } from '../public/shared/cp/cp-restore.js';

// Never under-warn (docs/claude-sidepanel.md, M7 = W1 to W5). "May be in
// Bypass" is a fact of its own, kept on both sides, that errs toward warning:
//   W1  the bridge holds it from the moment a switch into Bypass is sent (or a
//       process is launched in it) until the CLI acknowledged a switch away or
//       the process ended;
//   W2  the bridge reports the mode the CLI last acknowledged or reported, a
//       switch under way as under way, and the fact with every report;
//   W3  the page holds it from the moment it sends a statement of Bypass until
//       a report numbered at or after its latest statement says otherwise;
//   W4  the control warns whenever the pick is Bypass or either side says so;
//   W5  Bypass exists only against a bridge that numbers statements.
// The sequences below are the third review gate's findings and the list in the
// task, run with the page's model against the real bridge over a fake socket
// and a scripted SDK query. Each asserts what the control shows at every step.
// `Page` does what ui-claude-panel.js does with the model, in the same order;
// tests/claude-panel-mode-ownership.test.mjs pins that wiring in the source.

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const panel = read('public/shared/ui-claude-panel.js');
const fnBody = (signature) => {
  const start = panel.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const rest = panel.slice(start + signature.length);
  const next = rest.search(/\n(?:export )?(?:async )?function /);
  return next >= 0 ? rest.slice(0, next) : rest;
};

const BYPASS = 'bypassPermissions';
const WIN = 'w-warn';
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const REAL = { settingsPick: true, numbered: true, bypass: true };

function scriptedQuery({ prompt, options }, behaviour = {}) {
  const queue = [];
  let wake = null;
  let ended = false;
  const wakeUp = () => { const w = wake; wake = null; w?.(); };
  const finish = () => { ended = true; wakeUp(); };
  const q = (async function* () {
    for (;;) {
      while (queue.length) yield queue.shift();
      if (ended) return;
      await new Promise(r => { wake = r; });
    }
  })();
  q.options = options;
  q.pushed = [];
  q.calls = [];
  q.emit = (m) => { queue.push(m); wakeUp(); };
  q.exit = finish; // the process ends by itself
  q.interrupt = async () => {};
  q.setPermissionMode = async (mode) => {
    q.calls.push(mode);
    const answer = behaviour.answer?.(mode, q.calls.length);
    if (answer) await answer;
  };
  q.setModel = async () => {};
  q.applyFlagSettings = async () => {};
  q.supportedCommands = async () => [];
  q.mcpServerStatus = async () => [];
  q.initializationResult = async () => ({ commands: [], agents: [], models: [] });
  (async () => { for await (const m of prompt) q.pushed.push(m); finish(); })();
  options.abortController?.signal.addEventListener('abort', finish, { once: true });
  return q;
}

function world(behaviour = {}) {
  const queries = [];
  const warms = [];
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(),
    includePartialMessages: false,
    queryFactory: (args) => { const q = scriptedQuery(args, behaviour); queries.push(q); return q; },
    // startup(): the process exists ahead of the prompt; query(prompt) binds the input to it.
    startupFactory: async ({ options }) => {
      const handle = { options, closed: false, close() { handle.closed = true; }, query(prompt) { const q = scriptedQuery({ prompt, options }, behaviour); q.warm = true; queries.push(q); return q; } };
      warms.push(handle);
      return handle;
    },
    acquireSessionLock: () => ({ ok: true }),
    heartbeatLock: () => {},
    releaseAllLocks: () => {},
    getSessionCost: () => 0,
    addCost: () => {},
    maybeInjectSkillPrompt: (prompt) => ({ prompt }),
    toCliModelName: (m) => m,
    writePlanFile: () => ({ ok: false }),
    bypassBlock: () => '',
  });
  const connect = () => {
    const ws = new EventEmitter();
    Object.assign(ws, { readyState: 1, bufferedAmount: 0, sent: [], ping() {}, terminate() {} });
    ws.send = (data) => ws.sent.push(JSON.parse(data));
    createClaudeBridge(ws);
    const received = [];
    return { ws, received, client: (msg) => { received.push(msg); ws.emit('message', Buffer.from(JSON.stringify(msg))); }, close: () => { if (ws.readyState === 3) return; ws.readyState = 3; ws.emit('close'); } };
  };
  return { queries, warms, connect };
}

const settle = (ms = 30) => new Promise(r => setTimeout(r, ms));
async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 5));
  }
}
const init = (permissionMode) => ({ type: 'system', subtype: 'init', session_id: UUID, tools: [], mcp_servers: [], slash_commands: [], permissionMode });
const status = (permissionMode) => ({ type: 'system', subtype: 'status', status: null, permissionMode, session_id: UUID });
const eventsOf = (ws) => ws.sent.filter(p => p.type === 'event').map(p => p.event);
const modeEvents = (ws) => eventsOf(ws).filter(e => e.type === 'mode_changed' || e.type === 'mode_state');
/** A report without its revision (the F2 tests assert that; the rest of a report is compared exactly). */
const sansRev = ({ modeRev, modeRevOf, ...rest }) => { assert.ok(Number.isSafeInteger(modeRev) && modeRev > 0 && typeof modeRevOf === 'string' && modeRevOf, 'every report carries its revision'); return rest; };
const inits = (ws) => eventsOf(ws).filter(e => e.type === 'system' && e.subtype === 'init');
const statuses = (ws) => eventsOf(ws).filter(e => e.type === 'system' && e.subtype === 'status');
const freshTab = (over = {}) => ({ permissionMode: 'default', planMode: false, modeChosen: false, bypassChosen: false, planFrom: null, modeSeq: 0, actualMode: '', settingsMode: '', mayBypass: false, sessionId: null, running: false, ...over });
const facts = (carrier) => ({ seq: carrier?.modeSeq, numbered: true, mayBypass: carrier?.mayBypass, switching: carrier?.switching, failed: carrier?.failed, rev: carrier?.modeRev, revOf: carrier?.modeRevOf });
const result = () => ({ type: 'result', subtype: 'success', session_id: UUID, total_cost_usd: 0, usage: {}, result: 'ok' });

/** The page: _stateOwnMode, _sessionSaysMode, _applySessionOptions, a new socket's reattach, saveTabs and restoreTabs. */
class Page {
  constructor(tab = freshTab()) { this.tab = tab; this.seen = 0; this.sock = null; this.reasons = []; this.saved = null; }
  attach(sock) {
    this.sock = sock;
    this.seen = 0;
    model.connectionOpened(this.tab);
    if (this.tab.sessionId) sock.client({ type: 'reattach', windowId: WIN, sessionId: this.tab.sessionId });
    return this;
  }
  get open() { return !!this.sock && this.sock.ws.readyState === 1; }
  /** saveTabs(): what a reload gets back. */
  save() { this.saved = JSON.parse(JSON.stringify({ sessionId: this.tab.sessionId, running: this.tab.running, ...model.savedMode(this.tab) })); }
  /** A statement was written to the socket: saved when that changed what the tab knows of its session. */
  sent() { if (model.statementSent(this.tab, REAL)) this.save(); }
  state() {
    const t = this.tab;
    if (!(t.running || t.sessionId)) return false;
    if (!this.open) { t.modeUnsent = true; return false; }
    this.sock.client({ type: 'set_permission_mode', ...model.modeStatement(t, REAL) });
    this.sent();
    t.modeUnsent = false;
    return true;
  }
  pick(mode) { model.pickMode(this.tab, mode); this.state(); this.save(); }
  query(prompt = 'go', extra = {}) {
    const t = this.tab;
    const msg = { type: 'query', prompt, windowId: WIN, sessionId: t.sessionId || undefined, ...model.statedMode(t, REAL), ...extra };
    this.sent();
    t.running = true;
    this.sock.client(msg);
    this.save();
    return msg;
  }
  /** The first keystroke in an idle tab (_maybeWarm): the process is started ahead of the prompt, with the tab's mode. */
  warm() {
    const t = this.tab;
    const msg = { type: 'warm', windowId: WIN, sessionId: t.sessionId || undefined, ...model.statedMode(t, REAL) };
    this.sent();
    this.sock.client(msg);
    return msg;
  }
  says(mode, from, carrier) {
    const verdict = model.sessionReport(this.tab, typeof mode === 'string' ? mode : '', from, facts(carrier));
    if (verdict.restate) this.state();
    if (verdict.changed || verdict.warned) this.save();
    return verdict;
  }
  /** Handle what the bridge sent since the last call. Until then it waits, as it does in the page's buffer while a card is open. */
  drain() { const sent = this.sock.ws.sent; this.arrived(); while (this.seen < sent.length) this.handle(sent[this.seen++]); return this; }
  /** Handle the next message only. */
  step() { const sent = this.sock.ws.sent; this.arrived(); if (this.seen < sent.length) this.handle(sent[this.seen++]); return this; }
  /** handleTabMsg: every message is noted when it arrives, before it may wait in the buffer. */
  arrived() { const sent = this.sock.ws.sent; this.got = this.got?.sock === this.sock ? this.got : { sock: this.sock, n: 0 }; for (; this.got.n < sent.length; this.got.n++) model.reportReceived(this.tab, sent[this.got.n]); }
  handle(msg) {
    const t = this.tab;
    if (msg.type === 'reattach_result') {
      if (msg.ok) { if (msg.sessionId) t.sessionId = msg.sessionId; this.says(msg.mode, 'reattach', msg); }
      else { model.sessionForgotten(t); if (t.modeUnsent) this.state(); this.save(); }
      return;
    }
    if (msg.type === 'done') { t.running = false; return; }
    if (msg.type !== 'event') return;
    const ev = msg.event;
    if (ev.type === 'mode_changed' || ev.type === 'mode_state') { if (ev.reason) this.reasons.push(ev.reason); this.says(ev.mode, ev.type, ev); }
    else if (ev.type === 'mode_behind') { if (model.statementDropped(t, ev.modeSeq)) { this.state(); this.save(); } }
    else if (ev.type === 'system' && ev.subtype === 'init') { if (ev.permissionMode) this.says(ev.permissionMode, 'init', ev); if (ev.session_id) t.sessionId = ev.session_id; }
    else if (ev.type === 'system' && ev.subtype === 'status' && ev.permissionMode) this.says(ev.permissionMode, 'status', ev);
  }
  /** The page is reloaded: the tab comes back from what was last saved. */
  reload() {
    const s = this.saved || {};
    return new Page(freshTab({ ...model.restoredMode(s, { permissionMode: 'default', modeChosen: false }), sessionId: s.sessionId || null, running: !!s.running }));
  }
  get shown() { return model.modeControl(model.controlFacts(this.tab, REAL)); }
  get control() { return this.shown.text; }
  get warns() { return this.shown.state === 'bypass'; }
  /** What the control shows: its text, and whether it is in the warning style. */
  get look() { return [this.control, this.warns]; }
}

/** A page on a live session whose first turn is running: its first init reported `started`. */
async function live({ pick = '', started = pick || 'auto', behaviour = {} } = {}) {
  const w = world(behaviour);
  const sock = w.connect();
  const page = new Page().attach(sock);
  if (pick) page.pick(pick);
  page.query();
  await until(() => w.queries.length === 1 && w.queries[0].pushed.length === 1);
  w.queries[0].emit(init(started));
  await until(() => inits(sock.ws).length === 1);
  page.drain();
  return { w, sock, page, q: w.queries[0] };
}
const end = (...socks) => { for (const s of socks) { try { s.close(); } catch {} } shutdownAllBridges(); };

/** Calls to the CLI the test answers when it chooses to. */
function heldCalls(when) {
  const calls = [];
  return { calls, answer: (mode, n) => (when(mode, n) ? new Promise((resolve, reject) => { calls.push({ mode, resolve, reject }); }) : null) };
}

// ── W1 + W2: leaving Bypass, with the acknowledgement held, refused, failed ──

test('gate finding 1: while the switch away from Bypass is not acknowledged, a Bypass status or a reconnect never shows Default without the warning', async () => {
  // "Confirm Bypass at seq 1, pick Default at seq 2, and hold or refuse the CLI switch. A Bypass status
  // received meanwhile is rewritten as Default at seq 2, or reconnect returns Default at seq 2."
  const held = heldCalls(mode => mode === 'default');
  const { w, sock, page, q } = await live({ pick: BYPASS, behaviour: held });
  let again = null;
  try {
    assert.deepEqual(page.look, ['Bypass', true]);
    page.pick('default');
    await until(() => held.calls.length === 1);
    assert.deepEqual(page.look, ['Bypass → Default', true], 'stated, not acknowledged');
    q.emit(status(BYPASS));
    await until(() => statuses(sock.ws).length === 1);
    const told = statuses(sock.ws)[0];
    assert.deepEqual([told.permissionMode, told.switching, told.mayBypass, told.modeSeq], [BYPASS, 'default', true, 2], 'the bridge reports what is, and the switch as under way');
    assert.deepEqual(page.drain().look, ['Bypass → Default', true], 'a report at the latest number does not end the warning');
    // A reconnect in the middle.
    sock.close();
    again = w.connect();
    page.attach(again);
    await until(() => again.ws.sent.some(m => m.type === 'reattach_result'));
    const answer = again.ws.sent.find(m => m.type === 'reattach_result');
    assert.deepEqual([answer.ok, answer.mode, answer.switching, answer.mayBypass, answer.modeSeq], [true, BYPASS, 'default', true, 2]);
    assert.deepEqual(page.drain().look, ['Bypass → Default', true], 'after the reconnect');
    assert.equal(page.saved.sessionBypass, true, 'and a reload would warn too');
    // The CLI acknowledges. The Bypass it reported meanwhile may have been written after the first switch
    // landed, so the bridge stated the mode again: the session is out of Bypass once a switch sent after
    // that report is acknowledged, and not before.
    assert.equal(held.calls.length, 2, 'the mode was stated to the CLI again when it said Bypass');
    held.calls[0].resolve();
    await settle();
    assert.deepEqual(page.drain().look, ['Bypass → Default', true], 'the acknowledgement of the switch sent before that report proves nothing');
    held.calls[1].resolve();
    await until(() => modeEvents(again.ws).some(e => e.mayBypass === false));
    assert.deepEqual(page.drain().look, ['Default', false]);
    assert.equal(page.saved.sessionBypass, undefined);
    assert.deepEqual(q.calls.filter(m => m === BYPASS), [], 'nothing put the session back');
  } finally { end(sock, ...(again ? [again] : [])); }
});

for (const how of ['refused', 'failed']) {
  test(`a switch away from Bypass that is ${how} leaves the warning, through a reconnect and a reload, until a switch is acknowledged`, async () => {
    // "after refusal, reconnect can remove the warning permanently"
    const held = heldCalls(mode => mode === 'default');
    const { w, sock, page, q } = await live({ pick: BYPASS, behaviour: held });
    let again = null;
    try {
      page.pick('default');
      await until(() => held.calls.length === 1);
      assert.deepEqual(page.look, ['Bypass → Default', true]);
      held.calls[0].reject(new Error(how === 'refused' ? 'Cannot set permission mode to default' : 'the control channel closed'));
      await until(() => modeEvents(sock.ws).some(e => e.failed));
      const told = modeEvents(sock.ws).find(e => e.failed);
      assert.deepEqual([told.mode, told.failed, told.mayBypass, told.modeSeq], [BYPASS, 'default', true, 2], 'the record is what the CLI is in, and the page is told');
      const before = sock.received.length;
      assert.deepEqual(page.drain().look, ['Bypass → Default', true], 'the pick stays the owner\'s, and the control says where the session is');
      assert.deepEqual([page.tab.permissionMode, page.tab.modeChosen], ['default', true]);
      assert.equal(sock.received.length, before, 'a switch that failed is not asked again in a loop');
      assert.equal(page.saved.sessionBypass, true);
      // A CLI report that may have been written before any of it clears nothing.
      q.emit(init(BYPASS));
      await until(() => inits(sock.ws).length === 2);
      assert.deepEqual(page.step().look.slice(1), [true]);
      await settle();
      page.drain();
      // A reconnect, then a reload, in the middle.
      sock.close();
      const reloaded = page.reload();
      assert.deepEqual(reloaded.look.slice(1), [true], 'restored with the warning, before its socket is back');
      again = w.connect();
      reloaded.attach(again);
      await until(() => again.ws.sent.some(m => m.type === 'reattach_result'));
      reloaded.step();
      assert.deepEqual([reloaded.tab.permissionMode, reloaded.warns], ['default', true], 'the reconnect does not remove it');
      // The session leaves Bypass once a switch away is acknowledged (the bridge switched back when the CLI said Bypass again).
      assert.equal(q.calls.filter(m => m === 'default').length, 2);
      assert.deepEqual(reloaded.drain().look, ['Bypass → Default', true], 'still not acknowledged');
      held.calls[1].resolve();
      await until(() => modeEvents(again.ws).some(e => e.mayBypass === false));
      assert.deepEqual(reloaded.drain().look, ['Default', false]);
    } finally { end(sock, ...(again ? [again] : [])); }
  });
}

test('a reload while the switch away from Bypass is held: the restored control warns until the acknowledgement', async () => {
  const held = heldCalls(mode => mode === 'default');
  const { w, sock, page } = await live({ pick: BYPASS, behaviour: held });
  let again = null;
  try {
    page.pick('default');
    await until(() => held.calls.length === 1);
    sock.close();
    const reloaded = page.reload();
    assert.deepEqual(reloaded.look, ['Bypass → Default', true], 'before the socket is back');
    again = w.connect();
    reloaded.attach(again);
    await until(() => again.ws.sent.some(m => m.type === 'reattach_result'));
    assert.deepEqual(reloaded.drain().look, ['Bypass → Default', true], 'the reclaimed session says it may still be in Bypass');
    held.calls[0].resolve();
    await until(() => modeEvents(again.ws).some(e => e.mayBypass === false));
    assert.deepEqual(reloaded.drain().look, ['Default', false]);
  } finally { end(sock, ...(again ? [again] : [])); }
});

// ── W3: the page's own statement of Bypass ──

test('gate finding 2: a Bypass confirmation still waiting behind a question card does not let Default show without the warning', async () => {
  // "Start with a handled Default report. Choose Bypass; the CLI switches, but its confirmation waits behind
  // an AskUserQuestion buffer. Choose Default before draining that confirmation, with the exit switch pending."
  const held = heldCalls(mode => mode === 'default');
  const { sock, page, q } = await live({ pick: 'default', behaviour: held });
  try {
    assert.deepEqual(page.look, ['Default', false]);
    page.pick(BYPASS);
    await until(() => modeEvents(sock.ws).length === 1);   // confirmed, and not handled: a card is open
    assert.deepEqual(page.look, ['Bypass', true]);
    page.pick('default');
    await until(() => held.calls.length === 1);
    assert.deepEqual(page.look, ['Bypass → Default', true], 'the page stated Bypass itself: the session may be in it');
    assert.deepEqual(page.drain().look, ['Bypass → Default', true], 'the older confirmation handled');
    held.calls[0].resolve();
    await until(() => modeEvents(sock.ws).length === 2);
    assert.deepEqual(page.drain().look, ['Default', false]);
    assert.deepEqual(q.calls, [BYPASS, 'default']);
  } finally { end(sock); }
});

test('gate finding 3: the warning survives a reload, also when a report with an older number sets it', async () => {
  // "Save a Default pick while the earlier Bypass confirmation is still buffered. Drain that older Bypass
  // confirmation while the Default switch remains pending ... Reload before a confirming Default report."
  const held = heldCalls(mode => mode === 'default');
  const { sock, page } = await live({ pick: 'default', behaviour: held });
  try {
    page.pick(BYPASS);
    await until(() => modeEvents(sock.ws).length === 1);
    page.pick('default');
    await until(() => held.calls.length === 1);
    page.drain();
    assert.deepEqual(page.reload().look, ['Bypass → Default', true]);
  } finally { end(sock); }
  // The fact set by a report alone (the tab never stated Bypass), with a number older than the tab's latest statement.
  const tab = freshTab({ sessionId: UUID });
  model.pickMode(tab, 'default');
  model.statementSent(tab, REAL);
  model.sessionReport(tab, 'default', 'mode_changed', { seq: 1, numbered: true, mayBypass: false });
  model.pickMode(tab, 'acceptEdits');
  model.statementSent(tab, REAL);
  assert.equal(model.savedMode(tab).sessionBypass, undefined);
  const older = model.sessionReport(tab, BYPASS, 'status', { seq: 1, numbered: true, mayBypass: true, switching: 'default' });
  assert.deepEqual([older.stale, older.changed, older.warned], [true, false, true], 'nothing of the tab\'s own changed, and what it knows of its session did');
  assert.equal(model.savedMode(tab).sessionBypass, true);
  assert.equal(model.modeControl(model.controlFacts(tab, REAL)).text, 'Bypass → Accept Edits');
  // An older report can set it, never clear it; one at the latest number clears it.
  assert.equal(model.sessionReport(tab, 'default', 'status', { seq: 1, numbered: true, mayBypass: false }).warned, false);
  assert.equal(model.modeControl(model.controlFacts(tab, REAL)).state, 'bypass');
  assert.equal(model.sessionReport(tab, 'acceptEdits', 'mode_changed', { seq: 2, numbered: true, mayBypass: false }).warned, true);
  assert.deepEqual(model.modeControl(model.controlFacts(tab, REAL)), { text: 'Accept Edits', keep: 'Accept Edits', state: '', title: '' });
  // A report that does not say the session is out of Bypass does not end it either.
  model.sessionReport(tab, BYPASS, 'status', { seq: 2, numbered: true, mayBypass: true });
  model.sessionReport(tab, 'acceptEdits', 'status', { seq: 2, numbered: true });
  assert.equal(model.modeControl(model.controlFacts(tab, REAL)).state, 'bypass');
  // The wiring: saved whenever the fact changes, by a report or by a statement.
  assert.match(fnBody('function _sessionSaysMode(tab, mode, from, carrier) {'), /if \(verdict\.changed \|\| verdict\.warned\) saveTabs\(\);/);
  assert.match(fnBody('function _stateOwnMode(tab, { quiet = false } = {}) {'), /if \(statementSent\(tab, _modeBridge\(tab\)\)\) saveTabs\(\);/);
  assert.match(fnBody('function _applySessionOptions(tab, msg) {'), /if \(statementSent\(tab, \{ \.\.\._modeBridge\(tab\), counted: msg\.type === 'query' \|\| msg\.type === 'warm' \}\)\) saveTabs\(\);/);
});

// ── W1: what a CLI report can and cannot clear ──

test('a calm status written before the switch into Bypass and handled after it changes nothing', async () => {
  const { sock, page, q } = await live({ pick: 'default' });
  try {
    page.pick(BYPASS);
    await until(() => modeEvents(sock.ws).length === 1);
    assert.deepEqual(sansRev(modeEvents(sock.ws)[0]), { type: 'mode_changed', mode: BYPASS, modeSeq: 2, mayBypass: true });
    assert.deepEqual(page.drain().look, ['Bypass', true]);
    q.emit(status('default'));                          // written before the switch landed
    await until(() => statuses(sock.ws).length === 1);
    const told = statuses(sock.ws)[0];
    assert.deepEqual([told.permissionMode, told.mayBypass, told.modeSeq], [BYPASS, true, 2], 'nothing orders this report after the switch: the record and the fact stay');
    assert.deepEqual(page.drain().look, ['Bypass', true]);
    assert.deepEqual([page.tab.permissionMode, page.tab.bypassChosen], [BYPASS, true], 'and the owner\'s pick is not replaced');
    // The owner leaves: the warning ends with the acknowledgement, not with the pick.
    page.pick('default');
    await until(() => modeEvents(sock.ws).length === 2);
    assert.deepEqual(sansRev(modeEvents(sock.ws)[1]), { type: 'mode_changed', mode: 'default', modeSeq: 3, mayBypass: false });
    assert.deepEqual(page.drain().look, ['Default', false]);
  } finally { end(sock); }
});

test('a process that started in Bypass says so itself: its own later report of another mode ends the warning', async () => {
  // Everything a process writes is written after its launch: here the bridge can prove the order.
  const { sock, page, q } = await live({ started: BYPASS });
  try {
    assert.deepEqual([inits(sock.ws)[0].permissionMode, inits(sock.ws)[0].mayBypass], [BYPASS, true]);
    assert.deepEqual(page.look, ['Bypass · from settings', true]);
    q.emit(status('plan'));                             // the model entered plan mode
    await until(() => statuses(sock.ws).length === 1);
    assert.deepEqual([statuses(sock.ws)[0].permissionMode, statuses(sock.ws)[0].mayBypass], ['plan', false]);
    assert.deepEqual(page.drain().look, ['Plan', false]);
  } finally { end(sock); }
});

test('the process ending while the switch away from Bypass is under way ends the warning, and the next process starts in the pick', async () => {
  const held = heldCalls(mode => mode === 'default');
  const { w, sock, page, q } = await live({ pick: BYPASS, behaviour: held });
  try {
    page.pick('default');
    await until(() => held.calls.length === 1);
    assert.deepEqual(page.look, ['Bypass → Default', true]);
    q.exit();
    await until(() => sock.ws.sent.some(m => m.type === 'done'));
    await settle();
    const last = modeEvents(sock.ws).at(-1);
    assert.deepEqual([last.mode, last.mayBypass, last.modeSeq], ['default', false, 2], 'no process: nothing is in Bypass');
    assert.deepEqual(page.drain().look, ['Default', false]);
    held.calls[0].reject(new Error('the control channel closed'));
    await settle();
    assert.deepEqual(page.drain().look, ['Default', false], 'the old process\'s failure says nothing about the session now');
    page.query('next');
    await until(() => w.queries.length === 2);
    assert.equal(w.queries[1].options.permissionMode, 'default');
  } finally { end(sock); }
});

test('a Bypass the CLI reports by itself is warned of until the switch back is acknowledged', async () => {
  const held = heldCalls(mode => mode === 'acceptEdits');
  const { sock, page, q } = await live({ pick: 'acceptEdits', behaviour: held });
  try {
    q.emit(status(BYPASS));
    await until(() => held.calls.length === 1);
    const told = statuses(sock.ws)[0];
    assert.deepEqual([told.permissionMode, told.switching, told.mayBypass], [BYPASS, 'acceptEdits', true]);
    assert.deepEqual(page.drain().look, ['Bypass → Accept Edits', true]);
    assert.match(page.reasons[0], /Something other than you/);
    assert.deepEqual([page.tab.permissionMode, page.tab.bypassChosen], ['acceptEdits', false], 'never the tab\'s mode');
    held.calls[0].resolve();
    await until(() => modeEvents(sock.ws).some(e => e.mayBypass === false));
    assert.equal(modeEvents(sock.ws).at(-1).type, 'mode_state', 'said to the page without a line in the transcript');
    assert.deepEqual(page.drain().look, ['Accept Edits', false]);
  } finally { end(sock); }
});

// ── What the self-review as an opponent of the property found ──

test('a report never names a mode the CLI is not in without the mode the session holds, and a session that holds Bypass is said to be possibly in it', async () => {
  // After a switch away from Bypass failed: nothing is under way, the CLI is in Bypass, the session holds Default.
  const held = heldCalls(mode => mode === 'default');
  const { w, sock, page } = await live({ pick: BYPASS, behaviour: held });
  let again = null;
  try {
    page.pick('default');
    await until(() => held.calls.length === 1);
    held.calls[0].reject(new Error('the control channel closed'));
    await until(() => modeEvents(sock.ws).some(e => e.failed));
    page.drain();
    sock.close();
    again = w.connect();
    page.attach(again);
    await until(() => again.ws.sent.some(m => m.type === 'reattach_result'));
    const answer = again.ws.sent.find(m => m.type === 'reattach_result');
    assert.deepEqual([answer.mode, answer.switching, answer.mayBypass, answer.modeSeq], [BYPASS, 'default', true, 2], 'what is, and what the session holds for the tab');
    const before = again.received.length;
    assert.deepEqual(page.drain().look, ['Bypass → Default', true]);
    assert.deepEqual([page.tab.permissionMode, page.tab.modeChosen, again.received.length], ['default', true, before], 'the pick stands and is not said again: the session holds it');
  } finally { end(sock, ...(again ? [again] : [])); }
  // A session that holds Bypass for the tab and has no process yet: the next one starts in it.
  const cold = world().connect();
  try {
    cold.client({ type: 'set_permission_mode', mode: BYPASS, modeSeq: 1 });
    await until(() => modeEvents(cold.ws).length === 1);
    assert.deepEqual(sansRev(modeEvents(cold.ws)[0]), { type: 'mode_changed', mode: BYPASS, modeSeq: 1, mayBypass: true });
  } finally { end(cold); }
});

test('whether the tab may be in Bypass is saved by every statement that sets it, and survives the scrub of a saved tab', () => {
  assert.match(fnBody('function _approvePendingPlan(tab) {'), /if \(statementSent\(tab, _modeBridge\(tab\)\)\) saveTabs\(\);/);
  // Every report reaches the model with its facts: a status too (it goes through cp-event-rows.js).
  assert.match(read('public/shared/cp/cp-event-rows.js'), /cpCtx\.applyPermissionMode\(tab, view\.permissionMode, ev\?\.modeSeq, ev\);/);
  assert.match(panel, /applyPermissionMode: \(tab, mode, modeSeq, ev\) => _syncPermissionModeFromCli\(tab, mode, modeSeq, ev\),/);
  assert.match(fnBody('function _syncPermissionModeFromCli(tab, mode, modeSeq, ev) {'), /_sessionSaysMode\(tab, mode, 'status', \{ modeSeq, mayBypass: ev\?\.mayBypass, switching: ev\?\.switching, modeRev: ev\?\.modeRev, modeRevOf: ev\?\.modeRevOf \}\);/);
  for (const [from, carrier] of [['init', 'ev'], ['mode_changed', 'ev'], ['mode_state', 'ev'], ['reattach', 'msg']]) assert.match(panel, new RegExp(`_sessionSaysMode\\(tab, \\w+\\.(?:mode|permissionMode), '${from}', ${carrier}\\);`), from);
  const saved = { id: 't1', sessionId: UUID, permissionMode: 'default', modeChosen: true, modeSeq: 4, sessionBypass: true };
  assert.equal(scrubSavedTab(saved).sessionBypass, true, 'only a report ends it');
  assert.equal('sessionBypass' in scrubSavedTab({ ...saved, sessionBypass: undefined }), false);
  assert.equal(model.restoredMode(scrubSavedTab(saved), {}).mayBypass, true);
});

// ── W5: Bypass exists only against a bridge that numbers statements ──

test('gate finding 4: without both capabilities the page states no Bypass, and a saved Bypass pick waits untouched', () => {
  // "On the old bridge, buffer an older Default confirmation behind a question card, then choose and enter
  // Bypass." No such bridge runs Bypass: the page makes the combination impossible.
  assert.match(fnBody('function _bypassOffer(tab) {'), /bypassOffer\(\{ real: _modeBridge\(tab\)\.bypass, policy: /);
  assert.match(panel, /const _modeBridge = \(tab\) => \(\{ numbered: hasCapability\(tab, 'mode_statements'\), bypass: hasCapability\(tab, 'bypass_mode'\) && hasCapability\(tab, 'mode_statements'\) \}\);/);
  const tab = freshTab({ sessionId: UUID });
  model.pickMode(tab, BYPASS);                          // saved earlier, against a bridge that could
  for (const bridge of [{}, { numbered: false, bypass: true }, { numbered: true, bypass: false }]) {
    assert.deepEqual(model.statedMode(tab, { settingsPick: true, ...bridge }).permissionMode, 'default', JSON.stringify(bridge));
    assert.equal(model.modeStatement(tab, bridge).mode, 'default', JSON.stringify(bridge));
    assert.equal(model.statementSent(tab, bridge), false, 'no statement of Bypass was made');
    assert.equal(tab.mayBypass, false);
    const shown = model.modeControl(model.controlFacts(tab, { settingsPick: true, ...bridge }));
    assert.deepEqual([shown.text, shown.state], ['Bypass · unavailable', 'bypass'], 'shown as unavailable, in the warning style');
    assert.match(shown.title, /needs the SynaBun server restart/);
  }
  // The unnumbered fallback does not reason about Bypass: what such a bridge reports leaves the waiting pick alone,
  for (const [mode, from] of [['default', 'init'], ['default', 'status'], ['default', 'mode_changed'], ['plan', 'status'], [BYPASS, 'init'], [BYPASS, 'mode_changed']]) {
    assert.deepEqual(model.sessionReport(tab, mode, from), { stale: false, taken: false, changed: false, decided: false, restate: false, warned: false }, `${mode} ${from}`);
    assert.deepEqual([tab.permissionMode, tab.modeChosen, tab.bypassChosen, tab.planMode], [BYPASS, true, true, false]);
  }
  // and a Bypass it names is never a tab's mode, pick or no pick.
  for (const other of [freshTab(), (() => { const t = freshTab(); model.pickMode(t, 'acceptEdits'); return t; })()]) {
    const before = JSON.stringify(other);
    assert.equal(model.sessionReport(other, BYPASS, 'init').taken, false);
    assert.equal(JSON.stringify(other), before);
    assert.equal(model.sessionReport(other, 'plan', 'status').taken, true, 'its other reports are followed as they were');
  }
  // With both capabilities the pick is stated again, and from then the tab may be in Bypass.
  assert.deepEqual(model.statedMode(tab, REAL), { permissionMode: BYPASS, modeSeq: 1 });
  assert.equal(model.statementSent(tab, REAL), true);
  assert.equal(model.modeControl(model.controlFacts(tab, REAL)).text, 'Bypass');
});

// ── D1 ──

test('gate finding 5 (D1): another conversation in the tab shows "From settings" again, not the previous session\'s mode', () => {
  // "A never-picked tab reports Auto from settings. Change permissions.defaultMode to Bypass, select New chat ..."
  const tab = freshTab({ sessionId: UUID });
  model.sessionReport(tab, 'auto', 'init', { seq: 0, numbered: true, mayBypass: false });
  assert.equal(model.modeControl(model.controlFacts(tab, REAL)).text, 'Auto · from settings');
  model.sessionForgotten(tab);
  assert.deepEqual(model.modeControl(model.controlFacts(tab, REAL)), { text: 'From settings', keep: 'From settings', state: '', title: 'This tab follows your Claude Code settings (permissions.defaultMode). Pick a mode here to choose one for this tab.' });
  assert.equal(tab.settingsMode, '');
  // The previous conversation's process is still there until the next message replaces it: a Bypass it may be in is still said.
  const was = freshTab({ sessionId: UUID });
  model.sessionReport(was, BYPASS, 'init', { seq: 0, numbered: true, mayBypass: true });
  assert.equal(model.modeControl(model.controlFacts(was, REAL)).text, 'Bypass · from settings');
  model.sessionForgotten(was);
  assert.deepEqual([model.modeControl(model.controlFacts(was, REAL)).text, model.modeControl(model.controlFacts(was, REAL)).state], ['Bypass → From settings', 'bypass']);
  // Only a report ends it (W3): the first one of the tab's next process, numbered at or after its latest statement.
  model.sessionReport(was, 'auto', 'init', { seq: 0, numbered: true, mayBypass: false });
  assert.deepEqual([model.modeControl(model.controlFacts(was, REAL)).text, model.modeControl(model.controlFacts(was, REAL)).state], ['Auto · from settings', '']);
  assert.match(panel, /if \(!sid \|\| sid !== tab\.sessionId\) sessionForgotten\(tab\);/);
});

// ── D2 ──

test('gate finding 6 (D2): a statement the bridge drops as older is answered with its number, and the pick is said again', async () => {
  // "The bridge is at seq 5 while the page's saved counter has been lost. The owner picks Accept Edits at
  // seq 2 and sends it before processing reattach. The bridge drops it. Its Auto report at seq 5 is then
  // taken over the newer pick because modeUnsent is false."
  const { w, sock, page, q } = await live({ pick: 'default' });
  let again = null;
  try {
    for (const mode of ['acceptEdits', 'default', 'acceptEdits', 'auto']) page.pick(mode);
    await until(() => modeEvents(sock.ws).some(e => e.mode === 'auto' && e.modeSeq === 5));   // (the three it overtook announce nothing)
    page.drain();
    assert.equal(page.tab.modeSeq, 5);
    sock.close();
    // The reloaded page lost the number (its pick came back).
    const lost = new Page(freshTab({ sessionId: UUID, running: true, permissionMode: 'auto', modeChosen: true, modeSeq: 1 }));
    again = w.connect();
    lost.attach(again);
    lost.pick('acceptEdits');                           // seq 2, sent before the answer to reattach is handled
    await until(() => eventsOf(again.ws).some(e => e.type === 'mode_behind'));
    assert.deepEqual(eventsOf(again.ws).find(e => e.type === 'mode_behind').modeSeq, 5, 'the bridge answers a dropped statement with its number');
    lost.drain();
    await until(() => q.calls.at(-1) === 'acceptEdits' && q.calls.length === 5);
    await settle();
    lost.drain();
    assert.deepEqual([lost.tab.permissionMode, lost.tab.modeChosen, lost.control, lost.tab.modeSeq], ['acceptEdits', true, 'Accept Edits', 6], 'the owner\'s pick stands, with a number the bridge takes');
    assert.equal(modeEvents(again.ws).at(-1).modeSeq, 6);
  } finally { end(sock, ...(again ? [again] : [])); }
  // The answer alone (it arrives first): the number is taken and the pick said again; one that is not ahead changes nothing.
  const tab = freshTab({ sessionId: UUID, permissionMode: 'acceptEdits', modeChosen: true, modeSeq: 2 });
  assert.equal(model.statementDropped(tab, 5), true);
  assert.deepEqual([tab.modeSeq, tab.permissionMode], [6, 'acceptEdits']);
  assert.equal(model.statementDropped(tab, 5), false);
  assert.equal(model.statementDropped(tab, undefined), false);
  assert.match(panel, /if \(ev\.type === 'mode_behind'\) \{\n(?:\s+\/\/[^\n]*\n)*\s+if \(statementDropped\(tab, ev\.modeSeq\)\) \{ _stateOwnMode\(tab, \{ quiet: true \}\); saveTabs\(\); \}\n\s+return;\n\s+\}/);
});

// ── D3 ──

test('gate finding 7 (D3): a plan card button clicked while the socket is closed answers nothing and locks nothing', () => {
  const dom = installMiniDom();
  try {
    const tab = { id: 't', messagesEl: dom.container('cp-messages') };
    setCpCtx({ esc: String, md: (t) => `<p>${t}</p>`, scrollEnd: () => {}, activeTab: () => tab, toolIconSvg: () => '<svg/>', emit: () => {} });
    let open = false;
    const sent = [];
    const approved = [];
    const kept = [];
    const card = renderPlanApprovalCard(tab, 'plan-1', { tool_name: 'ExitPlanMode', input: { plan: '1. Do it' } }, {
      sendResponse: (rid, inner) => { if (!open) return false; sent.push([rid, inner]); return true; },
      bypass: { available: true },
      onApproved: (mode) => approved.push(mode),
      onKeepPlanning: (message) => kept.push(message),
    });
    const button = (text) => card.querySelectorAll('button').find(b => b.textContent === text);
    for (const label of ['Approve', 'Approve & auto-accept edits', 'Approve & bypass permissions', 'Keep planning']) button(label).click();
    assert.deepEqual([sent, approved, kept], [[], [], []], 'nothing was sent, so nothing is shown as answered');
    assert.equal(card.className.includes('resolved'), false);
    assert.equal(card.querySelectorAll('button').some(b => b.disabled), false);
    assert.equal(card.querySelector('.perm-status').hidden, true);
    // The socket is back: the same card answers.
    open = true;
    button('Approve').click();
    assert.deepEqual([sent, approved], [[['plan-1', { behavior: 'allow', planDecision: 'default' }]], ['default']]);
    assert.equal(card.querySelector('.perm-status').textContent, 'Approved');
  } finally { dom.restore(); }
  // The page: an answer that cannot be sent makes no pick either, and says so.
  assert.match(fnBody('function _sendControlInner(tab, requestId, inner) {'), /if \(!tab\.ws \|\| tab\.ws\.readyState !== WebSocket\.OPEN\) return false;/);
  assert.match(fnBody('function _sendControlInner(tab, requestId, inner) {'), /\n  return true;\n/);
  assert.match(fnBody('function _showNextPerm(tab) {'), /sendResponse: \(rid, inner\) => \{\n\s+if \(tab\.ws\?\.readyState !== WebSocket\.OPEN\) \{ appendStatus\(tab, PLAN_ANSWER_UNSENT\); return false; \}\n\s+return _sendControlInner\(tab, rid, inner\?\.behavior === 'allow' \? _planApproved\(tab, inner\) : inner\);\n\s+\},/);
});

// ── D4 ──

test('gate finding 8 (D4): /permissions opens while the tab\'s automation run is active, and nothing else does', () => {
  for (const text of ['/permissions', ' /permissions ', '/PERMISSIONS']) assert.equal(model.isPermissionsCommand(text), true, JSON.stringify(text));
  for (const text of ['', null, '/permissions now', '/permission', 'permissions', '/plan', '/permissions\nrm -rf', 'x /permissions']) assert.equal(model.isPermissionsCommand(text), false, JSON.stringify(text));
  const send = fnBody('function send({ shift = false } = {}) {');
  const through = send.indexOf('if (tab.automationActive && isPermissionsCommand(text) && !tab.attachedImages.length && !tab.attachedFiles.length) {');
  assert.ok(through > 0, 'the local, read-only command is let through');
  assert.ok(through < send.indexOf('if (tab.automationActive && !tab.running) {'), 'before the guards that refuse a manual turn');
  assert.match(send.slice(through, through + 400), /hideSlashHints\(\);\n\s+if \(runSlashCommand\(tab, text\)\) _pushPromptHistory\(tab, text\);\n\s+return;/);
  assert.equal(send.split('automationActive && isPermissionsCommand').length - 1, 1, 'one exception');
  assert.match(fnBody('function runSlashCommand(tab, raw) {'), /if \(tab\.automationActive && tab\.runMode\) html \+= row\('Automation run', /);
});

// ── W4: /permissions says the same in words ──

test('/permissions names the same facts as the control', () => {
  const body = fnBody('function runSlashCommand(tab, raw) {');
  assert.match(body, /const facts = controlFacts\(tab, \{ settingsPick: hasCapability\(tab, 'permission_modes_v2'\), \.\.\._modeBridge\(tab\) \}\);/);
  assert.match(body, /if \(facts\.leaving\) html \+= row\('Session', 'May be in Bypass: /);
  assert.match(body, /if \(facts\.waiting\) html \+= row\('Bypass', /);
  assert.match(fnBody('function populateModeDropdown($dd, tab) {'), /const facts = controlFacts\(tab, \{ settingsPick: hasCapability\(tab, 'permission_modes_v2'\), \.\.\._modeBridge\(tab\) \}\);/);
});

// ── F1: a process started ahead of the prompt is a process of the session's ──

/** The bridge sessions that start a process while a test runs (the idle reaper is a timer of the session's own). */
function watchSessions() {
  const seen = new Set();
  const ensure = ClaudeSession.prototype.ensureQuery;
  ClaudeSession.prototype.ensureQuery = function (...args) { seen.add(this); return ensure.apply(this, args); };
  return { seen, restore: () => { ClaudeSession.prototype.ensureQuery = ensure; } };
}

for (const how of ['the tab\'s pick', 'the mode the user\'s settings name']) {
  test(`F1: a warm process started in Bypass (${how}) never outlives the warning: it is ended when the tab states another mode before the prompt`, async () => {
    // "A tab keeps its sessionId after an idle reap and its recorded pick is Bypass; typing starts a warm
    // process in Bypass; before sending, the owner picks Default; set_permission_mode assigns Default,
    // skips the switch because q is null, and reports Default with mayBypass false, while the warm
    // process, started in Bypass, lives until it is adopted, closed or times out after three minutes."
    const picked = how === 'the tab\'s pick';
    const watch = watchSessions();
    const { w, sock, page, q } = await live(picked ? { pick: BYPASS } : { started: BYPASS });
    try {
      assert.deepEqual(page.look, [picked ? 'Bypass' : 'Bypass · from settings', true]);
      q.emit(result());
      await until(() => sock.ws.sent.some(m => m.type === 'done'));
      page.drain();
      // The idle reaper ends the process: the tab keeps its session id and its mode.
      const session = [...watch.seen][0];
      session.lastActivity = Date.now() - 16 * 60_000;
      session._maybeReapIdle();
      await until(() => !session.q && !(session._closingBypass > 0));
      await settle();
      assert.deepEqual([page.drain().look, page.tab.sessionId, page.tab.running], [[picked ? 'Bypass' : 'Bypass · from settings', true], UUID, false]);
      // Typing starts a process ahead of the prompt, in the tab's mode.
      const said = page.warm();
      assert.deepEqual([said.permissionMode, said.modeFromSettings], picked ? [BYPASS, undefined] : [undefined, true]);
      await until(() => w.warms.length === 1);
      const warm = w.warms[0];
      assert.equal(warm.options.permissionMode, picked ? BYPASS : undefined, picked ? 'launched in Bypass' : 'launched from the settings, which this session saw name Bypass');
      assert.equal(session._mayBypass(), true);
      let sentWhenClosed = -1;
      const close = warm.close;
      warm.close = () => { if (sentWhenClosed < 0) sentWhenClosed = sock.ws.sent.length; close(); };
      // Before sending, the owner picks Default.
      page.pick('default');
      await until(() => modeEvents(sock.ws).some(e => e.modeSeq === page.tab.modeSeq));
      await settle();
      assert.equal(warm.closed, true, 'the warm process was ended: the tab states another mode than the one it was started in');
      const calm = sock.ws.sent.findIndex(m => m.type === 'event' && (m.event.type === 'mode_changed' || m.event.type === 'mode_state') && m.event.mayBypass === false);
      assert.ok(calm < 0 || calm >= sentWhenClosed, 'no report says the session is out of Bypass while a process of its own that was started in Bypass lives');
      assert.deepEqual(page.drain().look, ['Default', false]);
      assert.equal(page.saved.sessionBypass, undefined);
      // The prompt starts a process launched in the stated mode: the warm one never runs a turn.
      page.query('now');
      await until(() => w.queries.length === 2);
      assert.deepEqual([w.queries[1].warm, w.queries[1].options.permissionMode, w.warms.length], [undefined, 'default', 1]);
    } finally { watch.restore(); end(sock); }
  });
}

test('F1: the fact counts every process the session owns: a warm one started in Bypass, whatever the stated mode says meanwhile', async () => {
  const watch = watchSessions();
  const w = world();
  const sock = w.connect();
  // A tab that comes back with its session id and its Bypass pick: no process yet.
  const page = new Page(freshTab({ sessionId: UUID })).attach(sock);
  try {
    page.drain().pick(BYPASS);
    page.warm();
    await until(() => w.warms.length === 1);
    const session = [...watch.seen][0];
    assert.equal(w.warms[0].options.permissionMode, BYPASS);
    assert.deepEqual([!!session.q, !!session._warm, session._mayBypass()], [false, true, true]);
    // (White box) the stated mode alone does not carry the fact: the warm process does, for as long as it lives.
    session.permissionMode = 'default';
    assert.equal(session._mayBypass(), true, 'a process started in Bypass is alive');
    assert.equal(session._modeFacts().mayBypass, true, 'and every report says so');
    session._closeWarm();
    assert.deepEqual([w.warms[0].closed, session._mayBypass()], [true, false], 'ended: nothing of the session\'s is in Bypass');
    // A warm process started in another mode is not counted.
    page.pick('acceptEdits');
    await until(() => modeEvents(sock.ws).some(e => e.mode === 'acceptEdits'));
    session._warmSentAt = 0;
    page.warm();
    await until(() => w.warms.length === 2);
    assert.deepEqual([w.warms[1].options.permissionMode, !!session._warm, session._mayBypass()], ['acceptEdits', true, false]);
  } finally { watch.restore(); end(sock); }
});

// ── F2: the bridge's facts have an order of their own ──

const reportOf = (m) => (m.type === 'reattach_result' ? m : m.type === 'event' && ('modeRev' in m.event || 'modeSeq' in m.event) ? m.event : null);

/** A Default tab at number 1 whose socket is lost during the turn; then `calm` calm reports, then the CLI says Bypass and the switch back is held. */
async function lostDuringTurn({ calm = 1 } = {}) {
  const held = heldCalls(mode => mode === 'default');
  const { w, sock, page, q } = await live({ pick: 'default', behaviour: held });
  assert.deepEqual([page.look, page.tab.modeSeq], [['Default', false], 1]);
  sock.close();
  for (let i = 0; i < calm; i++) q.emit(status('default'));
  await settle();
  q.emit(status(BYPASS));
  await until(() => held.calls.length === 1);
  return { w, sock, page, q, held };
}

test('F2: a calm report written before the CLI said Bypass and replayed after the reattach answer clears nothing', async () => {
  // "A Default tab at number 1 loses its socket during a turn; the buffer receives a calm Default report at
  // number 1; the CLI then reports Bypass and the switch back is held; reattach reports Bypass, switching
  // default, mayBypass true at number 1; the replayed older report then clears it."
  const { w, sock, page, held } = await lostDuringTurn();
  let again = null;
  try {
    again = w.connect();
    page.attach(again);
    await until(() => statuses(again.ws).length === 2);
    const answer = again.ws.sent.find(m => m.type === 'reattach_result');
    assert.deepEqual([answer.ok, answer.mode, answer.switching, answer.mayBypass, answer.modeSeq], [true, BYPASS, 'default', true, 1]);
    const replayed = statuses(again.ws);
    assert.deepEqual(replayed.map(r => [r.permissionMode, r.mayBypass, r.modeSeq]), [['default', false, 1], [BYPASS, true, 1]], 'the answer and the replayed reports carry the same number');
    assert.ok(again.ws.sent.indexOf(answer) < again.ws.sent.findIndex(m => m.event === replayed[0]), 'the answer is written first, the buffer after it');
    // The revision: it only grows for this bridge session, and a buffered message keeps the one it was created with.
    assert.ok(Number.isSafeInteger(replayed[0].modeRev) && replayed[0].modeRev < replayed[1].modeRev && replayed[1].modeRev < answer.modeRev, `${replayed[0].modeRev} < ${replayed[1].modeRev} < ${answer.modeRev}`);
    assert.equal(typeof answer.modeRevOf === 'string' && answer.modeRevOf.length > 0, true);
    assert.deepEqual([...new Set(again.ws.sent.map(reportOf).filter(Boolean).map(r => r.modeRevOf))], [answer.modeRevOf], 'every report names the bridge session that wrote it');
    // The page handles one message at a time (its budgeted drain): from the answer on, the warning holds at every step.
    let answered = false;
    while (page.seen < again.ws.sent.length) {
      const handled = again.ws.sent[page.seen];
      page.step();
      answered ||= handled === answer;
      if (!answered) continue;
      assert.deepEqual(page.look, ['Bypass → Default', true], `after ${handled.type} ${handled.event?.subtype || handled.event?.type || ''} (revision ${reportOf(handled)?.modeRev})`);
      assert.equal(page.saved.sessionBypass, true, 'and that is what a reload would get');
    }
    assert.equal(page.tab.actualMode, BYPASS, 'the mode shown for the session is the newest report\'s');
    // The acknowledgement of the switch back, sent after the CLI said Bypass, ends it: a report with a higher revision.
    held.calls[0].resolve();
    await until(() => modeEvents(again.ws).some(e => e.mayBypass === false && e.modeRev > answer.modeRev));
    assert.deepEqual(page.drain().look, ['Default', false]);
    assert.equal(page.saved.sessionBypass, undefined);
  } finally { end(sock, ...(again ? [again] : [])); }
});

test('F2: the same order when the replay arrives in chunks and the later Bypass report is delayed', async () => {
  // Sixty calm reports at number 1, then the Bypass report: the replay goes out fifty messages at a time and
  // waits while the socket is saturated, so the page has the answer and fifty older calm reports long before
  // the Bypass report arrives.
  const { w, sock, page, held } = await lostDuringTurn({ calm: 60 });
  let again = null;
  try {
    again = w.connect();
    page.attach(again);
    again.ws.bufferedAmount = Number.MAX_SAFE_INTEGER;
    await settle(150);
    assert.deepEqual([statuses(again.ws).length, statuses(again.ws).some(r => r.permissionMode === BYPASS)], [50, false], 'the first slice: calm reports only');
    assert.deepEqual(page.drain().look, ['Bypass → Default', true], 'fifty calm reports with the tab\'s number, all older than the answer');
    assert.equal(page.saved.sessionBypass, true);
    again.ws.bufferedAmount = 0;
    await until(() => statuses(again.ws).some(r => r.permissionMode === BYPASS));
    while (page.seen < again.ws.sent.length) { page.step(); assert.deepEqual(page.look, ['Bypass → Default', true]); }
    held.calls[0].resolve();
    await until(() => modeEvents(again.ws).some(e => e.mayBypass === false));
    assert.deepEqual(page.drain().look, ['Default', false]);
  } finally { end(sock, ...(again ? [again] : [])); }
});

test('F2: a reload in the middle of the replay: the restored tab warns, and takes the session\'s later word', async () => {
  const { w, sock, page, held } = await lostDuringTurn();
  let again = null;
  let third = null;
  try {
    again = w.connect();
    page.attach(again);
    await until(() => statuses(again.ws).length === 2);
    // The answer and the older calm report are handled; the Bypass report is not yet. Then the page is reloaded.
    while (!(again.ws.sent[page.seen - 1]?.event?.subtype === 'status')) page.step();
    assert.deepEqual(page.look, ['Bypass → Default', true]);
    const reloaded = page.reload();
    assert.deepEqual([reloaded.look, reloaded.tab.modeRev, reloaded.tab.modeRevOf], [['Bypass → Default', true], undefined, undefined], 'the warning is restored; the revision is not kept');
    again.close();
    third = w.connect();
    reloaded.attach(third);
    await until(() => third.ws.sent.some(m => m.type === 'reattach_result'));
    const answer = third.ws.sent.find(m => m.type === 'reattach_result');
    assert.deepEqual([answer.mode, answer.switching, answer.mayBypass], [BYPASS, 'default', true]);
    assert.ok(answer.modeRev > again.ws.sent.find(m => m.type === 'reattach_result').modeRev, 'the answer carries the current revision');
    assert.deepEqual(reloaded.drain().look, ['Bypass → Default', true]);
    held.calls[0].resolve();
    await until(() => modeEvents(third.ws).some(e => e.mayBypass === false && e.modeRev > answer.modeRev));
    assert.deepEqual(reloaded.drain().look, ['Default', false], 'a page that forgot the revision still takes the session\'s next word');
  } finally { end(sock, ...(again ? [again] : []), ...(third ? [third] : [])); }
});

test('F2: revisions start again with another bridge session: the page takes them, by the id the bridge announces', async () => {
  const { w, sock, page } = await live({ pick: BYPASS });
  let again = null;
  try {
    for (const mode of ['default', BYPASS, 'default', BYPASS]) page.pick(mode);
    await until(() => modeEvents(sock.ws).some(e => e.modeSeq === 5));
    page.drain();
    const before = { rev: page.tab.modeRev, of: page.tab.modeRevOf };
    assert.ok(before.rev > 2 && typeof before.of === 'string' && before.of, `the page remembers revision ${before.rev} of ${before.of}`);
    assert.deepEqual(page.look, ['Bypass', true]);
    // The server restarts: the session is gone with its process, and the next one counts from the start.
    sock.close();
    shutdownAllBridges();
    again = w.connect();
    page.attach(again);
    await until(() => again.ws.sent.some(m => m.type === 'reattach_result'));
    assert.equal(again.ws.sent.find(m => m.type === 'reattach_result').ok, false);
    page.drain().pick('default');
    await until(() => modeEvents(again.ws).length === 1);
    const first = modeEvents(again.ws)[0];
    assert.deepEqual([first.mode, first.mayBypass, first.modeSeq], ['default', false, 6]);
    assert.ok(first.modeRev < before.rev, `revision ${first.modeRev} is lower than the ${before.rev} the page remembers`);
    assert.notEqual(first.modeRevOf, before.of, 'written by another bridge session');
    assert.deepEqual(page.drain().look, ['Default', false], 'taken: a bridge session that counts again is not ignored');
    assert.deepEqual([page.tab.modeRevOf, page.tab.modeRev], [first.modeRevOf, first.modeRev], 'and the page counts with it from here');
  } finally { end(sock, ...(again ? [again] : [])); }
});

test('F2: in the page, a report with a lower revision can set the fact, never clear it, and never replaces the mode shown', () => {
  const tab = freshTab({ sessionId: UUID });
  model.pickMode(tab, 'default');
  const say = (t, mode, from, o) => model.sessionReport(t, mode, from, { seq: t.modeSeq, numbered: true, ...o });
  say(tab, BYPASS, 'reattach', { mayBypass: true, switching: 'default', rev: 7, revOf: 'A' });
  assert.deepEqual([tab.mayBypass, tab.actualMode, tab.modeRev, tab.modeRevOf], [true, BYPASS, 7, 'A']);
  // Older and calm, with the tab's own number: nothing is cleared and nothing replaced.
  const older = say(tab, 'default', 'status', { mayBypass: false, rev: 5, revOf: 'A' });
  assert.deepEqual([older.stale, older.warned, older.restate, older.taken, older.changed], [true, false, false, false, false]);
  assert.deepEqual([tab.mayBypass, tab.actualMode, tab.modeRev, model.modeControl(model.controlFacts(tab, REAL)).text], [true, BYPASS, 7, 'Bypass → Default']);
  // Older and naming another mode of the tab's own: the tab does not follow it (the newer report already said where the session is).
  say(tab, 'plan', 'status', { mayBypass: true, rev: 6, revOf: 'A' });
  assert.deepEqual([tab.permissionMode, tab.planMode, tab.modeRev], ['default', false, 7]);
  // An older report may still set the fact.
  const quiet = freshTab({ sessionId: UUID });
  model.pickMode(quiet, 'default');
  say(quiet, 'default', 'reattach', { mayBypass: false, rev: 9, revOf: 'A' });
  const sets = say(quiet, BYPASS, 'status', { mayBypass: true, switching: 'default', rev: 4, revOf: 'A' });
  assert.deepEqual([sets.warned, quiet.mayBypass, quiet.actualMode, quiet.modeRev], [true, true, 'default', 9], 'set, and the mode shown for the session stays the newer report\'s');
  // A newer report ends it.
  const newer = say(tab, 'default', 'mode_state', { mayBypass: false, rev: 8, revOf: 'A' });
  assert.deepEqual([newer.warned, tab.mayBypass, tab.actualMode, tab.modeRev], [true, false, 'default', 8]);
  // Another bridge session (a server restart, a session created anew): its revisions start again and are taken.
  say(tab, BYPASS, 'status', { mayBypass: true, switching: 'default', rev: 9, revOf: 'A' });
  const anew = say(tab, 'default', 'init', { mayBypass: false, rev: 1, revOf: 'B' });
  assert.deepEqual([anew.stale, anew.warned, tab.mayBypass, tab.modeRev, tab.modeRevOf], [false, true, false, 1, 'B']);
  // A bridge that sends no revision (the one that is running today): handled as before.
  const plain = freshTab({ sessionId: UUID });
  model.pickMode(plain, 'default');
  say(plain, BYPASS, 'status', { switching: 'default' });
  assert.deepEqual([plain.mayBypass, plain.modeRev], [true, undefined]);
  say(plain, 'default', 'status', {});
  assert.equal(plain.mayBypass, true, 'no mayBypass in its reports: set, never cleared');
  say(plain, 'default', 'status', { mayBypass: false });
  assert.equal(plain.mayBypass, false, 'and one that carries the fact without a revision clears at the tab\'s number, as it did');
});

test('F2: a report of a bridge session the tab no longer talks to, still waiting in the page\'s buffer, clears nothing', () => {
  // The page holds messages while a card is open and handles the reattach answer ahead of them. What waits
  // there was received before the answer: when another bridge session wrote it, it is older than the answer.
  const tab = freshTab({ sessionId: UUID });
  model.pickMode(tab, 'default');
  const waiting = { type: 'event', event: { type: 'system', subtype: 'status', permissionMode: 'default', modeSeq: 1, mayBypass: false, modeRev: 40, modeRevOf: 'A' } };
  const answer = { type: 'reattach_result', ok: true, mode: BYPASS, switching: 'default', mayBypass: true, modeSeq: 1, modeRev: 3, modeRevOf: 'B' };
  model.reportReceived(tab, waiting);
  model.reportReceived(tab, answer);
  model.sessionReport(tab, answer.mode, 'reattach', facts(answer));
  assert.deepEqual([tab.mayBypass, tab.modeRevOf, tab.modeRev], [true, 'B', 3]);
  const late = model.sessionReport(tab, 'default', 'status', facts(waiting.event));
  assert.deepEqual([late.stale, tab.mayBypass, tab.actualMode, tab.modeRevOf, tab.modeRev], [true, true, BYPASS, 'B', 3], 'A\'s higher revision is not B\'s: the tab stays with the session it talks to');
  // Messages without a revision are not notes of a bridge session.
  model.reportReceived(tab, { type: 'done', code: 0 });
  model.reportReceived(tab, { type: 'event', event: { type: 'assistant' } });
  model.reportReceived(tab, null);
  assert.equal(tab.modeRevNow, 'B');
  // The wiring: noted when a message arrives, before it may wait in the buffer; passed on by every path a report takes.
  assert.match(fnBody('function handleTabMsg(tab, msg) {'), /\n  reportReceived\(tab, msg\);\n[\s\S]*const _bufferBypass = bypassesPromptBuffer\(msg\);/);
  assert.match(fnBody('function _sessionSaysMode(tab, mode, from, carrier) {'), /rev: carrier\?\.modeRev, revOf: carrier\?\.modeRevOf \}\);/);
  assert.match(fnBody('function _syncPermissionModeFromCli(tab, mode, modeSeq, ev) {'), /modeRev: ev\?\.modeRev, modeRevOf: ev\?\.modeRevOf \}\);/);
});

// ── F4: the control's label is readable, and what it cuts when short of room ──

test('F4: the mode control never cuts "Bypass" or the mode after the arrow, is sized to its text, and its tooltip has the label in full', () => {
  const LABEL = model.MODE_LABELS;
  const CHAR = 5.7;   // one character of the label: 9.5px JetBrains Mono (measured live: 160px for 28 characters, 91px for 16)
  const CHROME = 19;  // the control's padding, gap and arrow
  const width = (text) => Math.round(text.length * CHAR + CHROME);
  const all = [];
  for (const mode of model.ALL_PERMISSION_MODES) for (const autoApprove of [false, true]) for (const follows of [false, true]) for (const known of [false, true]) for (const leaving of [false, true]) for (const waiting of [false, true]) {
    const shown = model.modeControl({ mode, autoApprove, follows, known, leaving, waiting });
    all.push(shown);
    const at = `${JSON.stringify({ mode, autoApprove, follows, known, leaving, waiting })} → "${shown.text}"`;
    assert.equal(typeof shown.keep, 'string', at);
    assert.ok(shown.keep.length > 0 && shown.text.startsWith(shown.keep), `what is kept is the start of the label: ${at} keeps "${shown.keep}"`);
    if (shown.state === 'bypass') assert.ok(shown.keep.startsWith('Bypass'), at);
    if (shown.text.includes('→')) assert.equal(shown.keep, `Bypass → ${follows && !known ? 'From settings' : LABEL[mode]}`, `the mode after the arrow is never cut: ${at}`);
    else if (shown.state !== 'bypass') assert.equal(shown.keep, follows && !known ? 'From settings' : LABEL[mode], at);
    assert.ok(!shown.keep.includes('·'), `only the suffixes may go: ${at}`);
    assert.ok(width(shown.text) <= 270, `the longest label fits the control's maximum: ${at} is ${width(shown.text)}px`);
    const tip = model.modeTooltip(shown, { fallback: 'Permission mode (Shift+Tab cycles)' });
    assert.ok(tip.startsWith(`${shown.text}. `), `the tooltip starts with the label in full: ${tip}`);
  }
  // The two labels the live test saw cut to 56px, and the longest there is.
  assert.deepEqual(['From settings · auto-approve', 'Bypass → Default', 'Accept Edits · from settings · auto-approve'].map(width), [179, 110, 264]);
  assert.ok(all.some(s => s.text === 'From settings · auto-approve') && all.some(s => s.text === 'Bypass → Default') && all.some(s => s.text === 'Accept Edits · from settings · auto-approve'));
  assert.equal(Math.max(...all.map(s => width(s.text))), 264);
  assert.equal(Math.max(...all.map(s => width(s.keep))), 144, '"Bypass → From settings": the widest part that is never cut');
  assert.equal(model.modeTooltip(model.modeControl({ mode: 'default', follows: true, autoApprove: true }), { fallback: 'x' }), 'Default · from settings · auto-approve. Auto-approve is on: permission requests are answered Allow without a card, in every tab. Turn it off with the Auto-approve toggle.');
  assert.equal(model.modeTooltip(model.modeControl({ mode: 'acceptEdits' }), { fallback: 'Permission mode (Shift+Tab cycles)' }), 'Accept Edits. Permission mode (Shift+Tab cycles).');
  // The styles: the small dropdowns' 72px no longer applies to the mode control; it shrinks only down to what it keeps.
  const styles = read('public/shared/cp/cp-styles.js');
  assert.match(styles, /\n#cp-mode \{ max-width: 270px; min-width: calc\(var\(--cp-mode-keep, 0\) \* 5\.7px \+ 19px\); \}\n/);
  assert.match(panel, /\n    \.cp-dropdown-sm \{ max-width: 72px; \}\n/, 'the other small dropdowns are as they were');
  assert.match(panel, /font-size: 9\.5px; font-family: 'JetBrains Mono', monospace;\n\s+color: rgba\(255,255,255,0\.3\);\n\s+overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;/, 'the label\'s font and its ellipsis are what the numbers above assume');
  const paint = fnBody('function populateModeDropdown($dd, tab) {');
  assert.match(paint, /label\.textContent = shown\.text;/);
  assert.match(paint, /\$dd\.style\.setProperty\('--cp-mode-keep', String\(shown\.keep\.length\)\);/);
  assert.match(paint, /\$dd\.dataset\.tooltip = modeTooltip\(shown, \{ fallback: MODE_CONTROL_TOOLTIP, note: settingsModeNote\(facts, _settingsAsk\(tab\)\) \}\);/);
});

// ── F5: the settings ask for a mode the session did not get ──

test('F5: when the settings name a mode the session did not start in, the tooltip and /permissions say so, and the label stays as it is', () => {
  // Seen live: permissions.defaultMode is Auto, a tab that never picked a mode on Haiku 4.5 showed
  // "Default · from settings". Claude Code declines auto mode where it is not available (the model, the plan,
  // fast mode, a setting) and starts the session in Default: nothing is lost between the CLI and the control.
  const rules = { user: { exists: true, defaultMode: 'auto' }, project: { exists: true, defaultMode: '' }, local: { exists: false } };
  assert.equal(model.settingsDefaultMode(rules), 'auto');
  assert.equal(model.settingsDefaultMode({ ...rules, local: { exists: true, defaultMode: 'acceptEdits' } }), 'acceptEdits', 'the nearest scope wins: local, then project, then user');
  assert.equal(model.settingsDefaultMode({ ...rules, project: { exists: true, defaultMode: 'plan' } }), 'plan');
  assert.equal(model.settingsDefaultMode({ user: { exists: true, error: 'broken', defaultMode: 'auto' } }), '', 'a file that could not be read names nothing');
  assert.equal(model.settingsDefaultMode({ user: { exists: true, defaultMode: 'yolo' } }), '');
  assert.equal(model.settingsDefaultMode(null), '');
  const tab = freshTab({ sessionId: UUID });
  model.sessionReport(tab, 'default', 'init', { seq: 0, numbered: true, mayBypass: false });
  const shown = model.controlFacts(tab, REAL);
  assert.equal(model.modeControl(shown).text, 'Default · from settings', 'the label stays short');
  const note = model.settingsModeNote(shown, 'auto');
  assert.equal(note, 'Your Claude Code settings ask for Auto (permissions.defaultMode) and this session is in Default: Claude Code starts a session in another mode when it cannot give the one asked for (auto mode is not available for every model, plan or setting).');
  assert.equal(model.modeTooltip(model.modeControl(shown), { fallback: 'x', note }), `Default · from settings. This tab follows your Claude Code settings (permissions.defaultMode). Pick a mode here to choose one for this tab. ${note}`);
  assert.match(model.settingsModeNote(shown, 'acceptEdits'), /ask for Accept Edits \(permissions\.defaultMode\) and this session is in Default: Claude Code starts a session in another mode when it cannot give the one asked for\.$/);
  // Nothing to say when they agree, when the mode is not known yet, when nothing is named, or for a tab with a pick.
  assert.equal(model.settingsModeNote(shown, 'default'), '');
  assert.equal(model.settingsModeNote(shown, ''), '');
  assert.equal(model.settingsModeNote(model.controlFacts(freshTab(), REAL), 'auto'), '', 'no session reported yet');
  const picked = freshTab({ sessionId: UUID });
  model.pickMode(picked, 'default');
  assert.equal(model.settingsModeNote(model.controlFacts(picked, REAL), 'auto'), '', 'the tab\'s own pick is not the settings\' business');
  // The page: /permissions reads the rules anyway and says it in its own row; the control's tooltip uses what was last read.
  assert.match(fnBody('function _renderPermissionsCard(tab, headHtml, row, rules, projectPath) {'), /const unmet = settingsModeNote\(controlFacts\(tab, \{ settingsPick: hasCapability\(tab, 'permission_modes_v2'\), \.\.\._modeBridge\(tab\) \}\), _noteSettingsAsk\(tab, rules\)\);\n\s+if \(unmet\) html \+= row\('Settings', unmet, 'warn'\);/);
  assert.match(fnBody('function _settingsAsk(tab) {'), /fetch\(`\/api\/claude-code\/permission-rules\?\$\{params\}`/);
});

// ── A session without the panel flag ──

test('a session without the panel flag: the record is assigned before the CLI answers, a failure is the same error, and none of the new facts exist', async () => {
  const held = heldCalls(mode => mode === 'acceptEdits' || mode === 'plan');
  const queries = [];
  world();
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(), includePartialMessages: false,
    queryFactory: (args) => { const q = scriptedQuery(args, held); queries.push(q); return q; },
    acquireSessionLock: () => ({ ok: true }), heartbeatLock: () => {}, releaseAllLocks: () => {}, getSessionCost: () => 0, addCost: () => {},
    maybeInjectSkillPrompt: (prompt) => ({ prompt }), toCliModelName: (m) => m, writePlanFile: () => ({ ok: false }),
  });
  const sent = [];
  const session = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send: (data) => sent.push(JSON.parse(data)) }, {});
  try {
    session.ensureQuery();
    const first = session.handleMessage({ type: 'set_permission_mode', mode: 'acceptEdits' });
    await until(() => held.calls.length === 1);
    assert.deepEqual([session.permissionMode, sent.length], ['acceptEdits', 0], 'assigned before the await, nothing sent yet');
    held.calls[0].resolve();
    await first;
    assert.deepEqual(sent, [{ type: 'event', event: { type: 'mode_changed', mode: 'acceptEdits' } }]);
    const second = session.handleMessage({ type: 'set_permission_mode', mode: 'plan' });
    await until(() => held.calls.length === 2);
    held.calls[1].reject(new Error('nope'));
    await second;
    await settle();
    assert.deepEqual(sent.slice(1), [{ type: 'error', message: 'Could not switch permission mode: nope' }], 'the one message it always sent');
    assert.equal(session.permissionMode, 'plan', 'and the record it always kept');
    queries[0].emit(status(BYPASS));
    queries[0].exit();
    await settle();
    assert.equal(sent.some(p => p.event?.type === 'mode_changed' && p !== sent[0]), false);
    assert.deepEqual([session._cli, session._toldFacts, session._closingBypass, session._pageSeq, session._modeCalls], [undefined, undefined, undefined, undefined, undefined]);
    assert.deepEqual([session._modeRev, session._modeRevOf, session._warm], [undefined, undefined, undefined], 'no revision, no warm process');
    assert.equal(sent.some(p => 'modeRev' in (p.event || p) || 'modeRevOf' in (p.event || p)), false);
  } finally { session.destroy(); shutdownAllBridges(); }
});

after(() => { shutdownAllBridges(); });

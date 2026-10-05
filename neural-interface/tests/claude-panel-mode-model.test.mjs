import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClaudeSession, PANEL_CAPABILITIES, configureClaudeBridge, createClaudeBridge, shutdownAllBridges } from '../lib/claude-agent-bridge.js';
import * as model from '../public/shared/cp/cp-permission-model.js';

// One model for a tab's permission mode (docs/claude-sidepanel.md, "The mode
// model"). The page owns the tab's chosen mode, the bridge owns the session's
// actual mode, and order is decided by numbers: the page numbers its
// statements, the bridge returns the number it applied with every report, and
// a report older than the page's latest statement changes nothing of the
// tab's own. These tests run the page's model (cp/cp-permission-model.js)
// against the real bridge over a fake socket and a scripted SDK query, as the
// sequences the second review gate described, one test per finding.
// The monolith cannot be imported in Node: `Page` below does what its wiring
// does, in the same order, and tests/claude-panel-mode-ownership.test.mjs pins
// that wiring in the source.

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
const WIN = 'w-mode';
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SETTINGS = { settingsPick: true, numbered: true, bypass: true }; // a bridge that announces permission_modes_v2, mode_statements and bypass_mode

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
  q.interrupt = async () => {};
  q.setPermissionMode = async (mode) => {
    q.calls.push(mode);
    const held = behaviour.hold?.(mode);
    if (held) await held;
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

/** One server: its bridge, and as many sockets as the test opens on it. */
function world(behaviour = {}) {
  const queries = [];
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(),
    includePartialMessages: false,
    queryFactory: (args) => { const q = scriptedQuery(args, behaviour); queries.push(q); return q; },
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
  return { queries, connect };
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
const result = () => ({ type: 'result', subtype: 'success', session_id: UUID, total_cost_usd: 0, usage: {}, result: 'ok' });
const modeEvents = (ws) => ws.sent.filter(p => p.type === 'event' && p.event?.type === 'mode_changed').map(p => p.event);
/** A report without its revision (tests/claude-panel-bypass-warning.test.mjs asserts the order it gives; the rest of a report is compared exactly). */
const sansRev = ({ modeRev, modeRevOf, ...rest }) => { assert.ok(Number.isSafeInteger(modeRev) && modeRev > 0 && typeof modeRevOf === 'string' && modeRevOf, 'every report carries its revision'); return rest; };
const inits = (ws) => ws.sent.filter(p => p.type === 'event' && p.event?.type === 'system' && p.event.subtype === 'init').map(p => p.event);
// A tab as createTab() makes it when no default is stored: it never picked a mode.
const freshTab = (over = {}) => ({ permissionMode: 'default', planMode: false, modeChosen: false, bypassChosen: false, planFrom: null, modeSeq: 0, actualMode: '', settingsMode: '', sessionId: null, running: false, ...over });

/** The page: what ui-claude-panel.js does with the model (_stateOwnMode, _sessionSaysMode, _applySessionOptions, _planApproved, _approvePendingPlan, a new socket's reattach). */
class Page {
  constructor(tab = freshTab()) { this.tab = tab; this.seen = 0; this.sock = null; this.reasons = []; }
  attach(sock) {
    this.sock = sock;
    this.seen = 0;
    model.connectionOpened(this.tab);
    if (this.tab.sessionId) sock.client({ type: 'reattach', windowId: WIN, sessionId: this.tab.sessionId });
    return this;
  }
  get open() { return !!this.sock && this.sock.ws.readyState === 1; }
  state() {
    const t = this.tab;
    if (!(t.running || t.sessionId)) return false;
    if (!this.open) { t.modeUnsent = true; return false; }
    this.sock.client({ type: 'set_permission_mode', ...model.modeStatement(t, SETTINGS) });
    model.statementSent(t, SETTINGS);
    t.modeUnsent = false;
    return true;
  }
  pick(mode) { model.pickMode(this.tab, mode); this.state(); }
  leavePlan() { if (model.leavePlanMode(this.tab)) this.state(); }
  query(prompt = 'go', extra = {}) {
    const t = this.tab;
    const msg = { type: 'query', prompt, windowId: WIN, sessionId: t.sessionId || undefined, ...model.statedMode(t, SETTINGS), ...extra };
    model.statementSent(t, SETTINGS);
    t.running = true;
    this.sock.client(msg);
    return msg;
  }
  says(mode, from, carrier) {
    const verdict = model.sessionReport(this.tab, typeof mode === 'string' ? mode : '', from, { seq: carrier?.modeSeq, numbered: true, mayBypass: carrier?.mayBypass, switching: carrier?.switching, failed: carrier?.failed });
    if (verdict.restate) this.state();
    return verdict;
  }
  /** Handle what the bridge sent since the last call. Until then it waits, as it does in the page's buffer while a card is open. */
  drain() { const sent = this.sock.ws.sent; while (this.seen < sent.length) this.handle(sent[this.seen++]); return this; }
  handle(msg) {
    const t = this.tab;
    if (msg.type === 'reattach_result') {
      if (msg.ok) { if (msg.sessionId) t.sessionId = msg.sessionId; this.says(msg.mode, 'reattach', msg); }
      else { model.sessionForgotten(t); if (t.modeUnsent) this.state(); }
      return;
    }
    if (msg.type === 'done') { t.running = false; return; }
    if (msg.type !== 'event') return;
    const ev = msg.event;
    if (ev.type === 'mode_changed') { if (ev.reason) this.reasons.push(ev.reason); this.says(ev.mode, 'mode_changed', ev); }
    else if (ev.type === 'mode_state') this.says(ev.mode, 'mode_state', ev);
    else if (ev.type === 'mode_behind') { if (model.statementDropped(t, ev.modeSeq)) this.state(); }
    else if (ev.type === 'system' && ev.subtype === 'init') { if (ev.permissionMode) this.says(ev.permissionMode, 'init', ev); if (ev.session_id) t.sessionId = ev.session_id; }
    else if (ev.type === 'system' && ev.subtype === 'status' && ev.permissionMode) this.says(ev.permissionMode, 'status', ev);
  }
  get shown() { return model.modeControl(model.controlFacts(this.tab, SETTINGS)); }
  get control() { return this.shown.text; }
  get warns() { return this.shown.state === 'bypass'; }
  stated() { const { modeSeq, ...mode } = model.statedMode(this.tab, SETTINGS); return mode; }
}

/** A page on a live session: a first turn whose init reported `started` (for a tab without a pick: the mode its settings name). */
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

// ── The hello, and the numbers on the wire ──

test('the bridge says it numbers statements, and returns the number it applied with every report', async () => {
  assert.ok(PANEL_CAPABILITIES.includes('mode_statements'));
  const { sock, page, q } = await live({ pick: 'default' });
  try {
    assert.ok(sock.ws.sent[0].capabilities.includes('mode_statements'));
    assert.equal(q.options.permissionMode, 'default');
    assert.deepEqual([inits(sock.ws)[0].permissionMode, inits(sock.ws)[0].modeSeq], ['default', 1]);
    page.pick('acceptEdits');
    await until(() => modeEvents(sock.ws).length === 1);
    assert.deepEqual(sansRev(modeEvents(sock.ws)[0]), { type: 'mode_changed', mode: 'acceptEdits', modeSeq: 2, mayBypass: false });
    q.emit(status('acceptEdits'));
    await settle();
    const told = sock.ws.sent.filter(p => p.event?.subtype === 'status').at(-1).event;
    assert.deepEqual([told.permissionMode, told.modeSeq], ['acceptEdits', 2]);
    // A statement older than the one applied is not applied (messages are not all handled in the order sent).
    sock.client({ type: 'set_permission_mode', mode: BYPASS, modeSeq: 1 });
    await settle();
    assert.deepEqual(q.calls, ['acceptEdits']);
    assert.equal(modeEvents(sock.ws).length, 1);
    assert.deepEqual(sock.ws.sent.filter(p => p.event?.type === 'mode_behind').map(p => p.event), [{ type: 'mode_behind', modeSeq: 2 }], 'and the page is told the number the session holds');
  } finally { end(sock); }
});

// ── Finding 1 ──

test('finding 1: a stale init, status or confirmation never overwrites the owner\'s newer Bypass pick', async () => {
  // "A process starts in Default. The owner chooses Bypass and receives its confirmation. An init generated
  // before that switch is translated afterward and reports Default."
  const { sock, page, q } = await live({ pick: 'default' });
  try {
    page.pick(BYPASS);
    await until(() => modeEvents(sock.ws).length === 1);
    page.drain();
    assert.equal(page.control, 'Bypass');
    const owners = () => [page.tab.permissionMode, page.tab.bypassChosen, page.control, page.warns];
    assert.deepEqual(owners(), [BYPASS, true, 'Bypass', true]);
    // A stale init: written before the switch landed, handled after its confirmation.
    q.emit(init('default'));
    await until(() => inits(sock.ws).length === 2);
    assert.deepEqual([inits(sock.ws)[1].permissionMode, inits(sock.ws)[1].modeSeq, inits(sock.ws)[1].mayBypass], [BYPASS, 2, true], 'the bridge sends what the CLI acknowledged, not a snapshot older than the switch');
    page.drain();
    assert.deepEqual(owners(), [BYPASS, true, 'Bypass', true], 'after the stale init');
    // A stale calm status: the same, as a status. Nothing orders it after the switch into Bypass, so it is
    // not the CLI changing its mode: the record, the pick and the warning stay, and nothing is switched.
    q.emit(status('default'));
    await until(() => sock.ws.sent.filter(p => p.event?.subtype === 'status').length === 1);
    const calm = sock.ws.sent.find(p => p.event?.subtype === 'status').event;
    assert.deepEqual([calm.permissionMode, calm.modeSeq, calm.mayBypass], [BYPASS, 2, true], 'a calm status after a completed switch into Bypass is not taken');
    page.drain();
    assert.deepEqual(owners(), [BYPASS, true, 'Bypass', true], 'after the stale status');
    // A stale confirmation: the Default the session confirmed before the pick, handled after it.
    assert.deepEqual(page.says('default', 'mode_changed', { modeSeq: 1, mayBypass: false }).stale, true);
    assert.deepEqual(owners(), [BYPASS, true, 'Bypass', true], 'after the stale confirmation');
    assert.deepEqual(q.calls, [BYPASS], 'none of them switched the session');
    assert.deepEqual(page.stated(), { permissionMode: BYPASS }, 'the next message still states Bypass');
    assert.equal(model.savedMode(page.tab).bypassChosen, true, 'and a reload keeps it');
    // The session is in Bypass and the bridge knows it: the CLI saying so is not undone.
    q.emit(status(BYPASS));
    await settle();
    assert.deepEqual(q.calls, [BYPASS]);
    assert.deepEqual(page.drain().reasons, []);
  } finally { end(sock); }
});

test('finding 1: an older Default confirmation drained after the owner chose Bypass changes nothing, in either order of picks', async () => {
  // "An older Default confirmation buffered behind an AskUserQuestion is drained after the owner chooses
  // Bypass; it clears bypassChosen, so the newer Bypass confirmation is rejected and Default is restated."
  const first = await live({ pick: 'acceptEdits' });
  try {
    const { sock, page, q } = first;
    page.pick('default');                 // its confirmation waits in the page's buffer (a question card is open)
    await until(() => modeEvents(sock.ws).length === 1);
    page.pick(BYPASS);                    // the owner's newer choice
    await until(() => modeEvents(sock.ws).length === 2);
    const before = sock.received.length;
    page.drain();
    assert.deepEqual([page.tab.permissionMode, page.tab.bypassChosen, page.control], [BYPASS, true, 'Bypass']);
    assert.equal(sock.received.length, before, 'nothing is restated: Default is not said again');
    assert.equal(q.calls.at(-1), BYPASS, 'the session is in Bypass, as the control says');
    assert.deepEqual(page.stated(), { permissionMode: BYPASS });
  } finally { end(first.sock); }

  // The other order: Bypass, then Default. While the older Bypass confirmation is the latest word of the
  // session the control says so; the session ends in Default and so does the control.
  const second = await live({ pick: 'acceptEdits' });
  try {
    const { sock, page, q } = second;
    page.pick(BYPASS);
    await until(() => modeEvents(sock.ws).length === 1);
    page.pick('default');
    await until(() => modeEvents(sock.ws).length === 2);
    page.handle(sock.ws.sent[page.seen++]); // the older confirmation alone
    while (sock.ws.sent[page.seen - 1]?.event?.type !== 'mode_changed') page.handle(sock.ws.sent[page.seen++]);
    assert.deepEqual([page.tab.permissionMode, page.control, page.warns], ['default', 'Bypass → Default', true], 'never under-warned');
    page.drain();
    assert.deepEqual([page.tab.permissionMode, page.tab.bypassChosen, page.control, page.warns], ['default', false, 'Default', false]);
    assert.equal(q.calls.at(-1), 'default');
  } finally { end(second.sock); }
});

test('finding 1: reports with an older number, in every order, around the confirmation of the latest pick', () => {
  const stale = [['init', 'default'], ['status', 'default'], ['mode_changed', 'default']];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (const order of orders) {
    for (const confirmAt of [0, 1, 2, 3]) {
      const tab = freshTab({ sessionId: UUID });
      model.pickMode(tab, 'default');
      model.statementSent(tab, SETTINGS);
      assert.equal(model.sessionReport(tab, 'default', 'mode_changed', { seq: 1, numbered: true }).taken, true);
      model.pickMode(tab, BYPASS);
      model.statementSent(tab, SETTINGS);
      const reports = order.map(i => () => model.sessionReport(tab, stale[i][1], stale[i][0], { seq: 1, numbered: true }));
      reports.splice(confirmAt, 0, () => model.sessionReport(tab, BYPASS, 'mode_changed', { seq: 2, numbered: true }));
      for (const report of reports) {
        const verdict = report();
        assert.equal(verdict.restate, false, 'the statement was sent: an older report is only on its way');
        assert.deepEqual([tab.permissionMode, tab.modeChosen, tab.bypassChosen, tab.planMode], [BYPASS, true, true, false], `${order} / ${confirmAt}`);
        assert.equal(model.modeControl(model.controlFacts(tab, SETTINGS)).state, 'bypass');
      }
      assert.deepEqual(model.statedMode(tab, SETTINGS), { permissionMode: BYPASS, modeSeq: 2 });
      // The reverse: the owner left Bypass, and older reports still say Bypass. Not taken, and warned until confirmed.
      const left = freshTab({ sessionId: UUID });
      model.pickMode(left, BYPASS);
      model.statementSent(left, SETTINGS);
      model.sessionReport(left, BYPASS, 'mode_changed', { seq: 1, numbered: true });
      model.pickMode(left, 'default');
      model.statementSent(left, SETTINGS);
      for (const i of order) {
        assert.equal(model.sessionReport(left, BYPASS, stale[i][0], { seq: 1, numbered: true }).stale, true);
        assert.deepEqual([left.permissionMode, model.modeControl(model.controlFacts(left, SETTINGS)).text], ['default', 'Bypass → Default']);
      }
      // A confirmation from a bridge that does not say whether the session may be in Bypass ends nothing; one that says it is not does.
      model.sessionReport(left, 'default', 'mode_changed', { seq: 2, numbered: true });
      assert.equal(model.modeControl(model.controlFacts(left, SETTINGS)).text, 'Bypass → Default');
      model.sessionReport(left, 'default', 'mode_changed', { seq: 2, numbered: true, mayBypass: false });
      assert.deepEqual(model.modeControl(model.controlFacts(left, SETTINGS)), { text: 'Default', keep: 'Default', state: '', title: '' });
    }
  }
});

// ── Findings 2 and 7, and every way out of plan mode ──

for (const kind of [{ name: 'a tab that never picked a mode', pick: '', home: 'auto', homeControl: 'Auto · from settings', homeStated: { modeFromSettings: true } },
  { name: 'a tab with a pick', pick: 'acceptEdits', home: 'acceptEdits', homeControl: 'Accept Edits', homeStated: { permissionMode: 'acceptEdits' } }]) {
  test(`finding 2: the post-plan card's "Continue with implementation" takes a live session out of plan mode (${kind.name})`, async () => {
    // "A never-picked tab enters Plan through /plan or Claude's EnterPlanMode, finishes a planning turn without
    // a pending approval, and the owner uses the post-editor 'Continue with implementation' card."
    for (const entry of ['/plan', 'EnterPlanMode']) {
      const { sock, page, q } = await live({ pick: kind.pick });
      try {
        if (entry === '/plan') page.pick('plan'); else q.emit(status('plan')); // the session's own word that the model entered plan mode
        await settle();
        page.drain();
        assert.deepEqual([page.tab.permissionMode, page.tab.planMode, page.control], ['plan', true, 'Plan'], entry);
        q.emit(result());
        await until(() => sock.ws.sent.some(m => m.type === 'done'));
        page.drain();
        // The card: _leavePlanUI(), then the implementation prompt.
        page.leavePlan();
        page.query('Continue with the implementation based on the approved plan.');
        await until(() => q.pushed.length === 2);
        await settle();
        assert.equal(w(q).at(-1), kind.home, `${entry}: the live session is switched to the mode the tab was in before plan mode`);
        assert.equal(q.calls.includes('plan') ? q.calls.lastIndexOf('plan') < q.calls.length - 1 : true, true);
        page.drain();
        assert.deepEqual([page.tab.planMode, page.tab.permissionMode === 'plan', page.control, page.warns], [false, false, kind.homeControl, false], entry);
        assert.deepEqual(page.stated(), kind.homeStated, entry);
      } finally { end(sock); }
    }
  });

  test(`finding 7: /plan off after a planning turn ends plan mode, in the page and in the session (${kind.name})`, async () => {
    // "After a planning turn reports Plan, issue /plan again to turn planning off, then send an implementing message."
    const { sock, page, q } = await live({ pick: kind.pick });
    try {
      page.pick('plan');                       // /plan
      await until(() => q.calls.includes('plan'));
      q.emit(init('plan'));                    // the planning turn reports Plan
      await settle();
      page.drain();
      assert.deepEqual([page.tab.permissionMode, page.tab.planMode], ['plan', true]);
      page.leavePlan();                        // /plan again
      assert.deepEqual([page.tab.permissionMode === 'plan', page.tab.planMode], [false, false], 'one fact: the toggle and the mode cannot disagree');
      const msg = page.query('implement it');
      assert.notEqual(msg.permissionMode, 'plan', 'the implementing message is not another Plan query');
      await until(() => q.pushed.length === 2);
      await settle();
      assert.equal(q.calls.at(-1), kind.home, 'and the live session left plan mode');
      page.drain();
      assert.equal(page.control, kind.homeControl);
    } finally { end(sock); }
  });

  test(`every way out of plan mode leaves a live session in the mode left to (${kind.name})`, async () => {
    const enter = async () => {
      const s = await live({ pick: kind.pick });
      s.page.pick('plan');
      await until(() => s.q.calls.includes('plan'));
      s.page.drain();
      return s;
    };
    // The plan toggle and /plan name no mode: back to what the tab was.
    {
      const { sock, page, q } = await enter();
      try {
        page.leavePlan();
        await until(() => q.calls.at(-1) === kind.home);
        await settle();
        assert.deepEqual([page.drain().control, page.stated()], [kind.homeControl, kind.homeStated]);
        assert.deepEqual(page.reasons, []);
      } finally { end(sock); }
    }
    // Shift+Tab (its cycle goes on to Default) and the mode control name the mode: a pick.
    for (const target of ['default', 'dontAsk']) {
      const { sock, page, q } = await enter();
      try {
        page.pick(target);
        await until(() => q.calls.at(-1) === target);
        await settle();
        assert.deepEqual([page.drain().tab.permissionMode, page.tab.modeChosen, page.tab.planMode, page.stated()], [target, true, false, { permissionMode: target }]);
      } finally { end(sock); }
    }
    // The plan card: each button names its own target. (_planApproved: the pick first, its number on the answer.)
    for (const [decision, target] of [['default', 'default'], ['acceptEdits', 'acceptEdits'], ['bypassPermissions', BYPASS]]) {
      const { sock, page, q } = await enter();
      try {
        const pending = q.options.canUseTool('ExitPlanMode', { plan: 'Do it.' }, { signal: new AbortController().signal });
        await until(() => sock.ws.sent.some(m => m.type === 'control_request'));
        const requestId = sock.ws.sent.find(m => m.type === 'control_request').request_id;
        model.pickMode(page.tab, target);
        model.statementSent(page.tab, SETTINGS);
        sock.client({ type: 'control_response', request_id: requestId, response: { behavior: 'allow', planDecision: decision, modeSeq: page.tab.modeSeq } });
        assert.equal((await pending).behavior, 'allow');
        await until(() => q.calls.at(-1) === target);
        await settle();
        page.drain();
        assert.deepEqual([page.tab.permissionMode, page.tab.planMode, page.tab.bypassChosen, page.warns], [target, false, target === BYPASS, target === BYPASS], decision);
        assert.deepEqual(sansRev(modeEvents(sock.ws).at(-1)), { type: 'mode_changed', mode: target, modeSeq: page.tab.modeSeq, mayBypass: target === BYPASS });
      } finally { end(sock); }
    }
    // "Keep planning" stays in plan mode.
    {
      const { sock, page, q } = await enter();
      try {
        const pending = q.options.canUseTool('ExitPlanMode', { plan: 'Do it.' }, { signal: new AbortController().signal });
        await until(() => sock.ws.sent.some(m => m.type === 'control_request'));
        sock.client({ type: 'control_response', request_id: sock.ws.sent.find(m => m.type === 'control_request').request_id, response: { behavior: 'deny', message: 'more' } });
        assert.equal((await pending).behavior, 'deny');
        await settle();
        assert.deepEqual([page.drain().tab.permissionMode, page.tab.planMode, q.calls.at(-1)], ['plan', true, 'plan']);
      } finally { end(sock); }
    }
  });

  test(`finding 6: "Continue with implementation" answers a pending plan approval, with the edited plan (${kind.name})`, async () => {
    // "While the ExitPlanMode approval card is pending, choose Edit plan, save, then click the newly displayed
    // 'Continue with implementation' button instead of an approval button on the original card."
    const { sock, page, q } = await live({ pick: kind.pick });
    try {
      page.pick('plan');
      await until(() => q.calls.includes('plan'));
      page.drain();
      const pending = q.options.canUseTool('ExitPlanMode', { plan: 'The first plan.' }, { signal: new AbortController().signal });
      await until(() => sock.ws.sent.some(m => m.type === 'control_request'));
      const request = sock.ws.sent.find(m => m.type === 'control_request');
      const before = q.pushed.length;
      // _approvePendingPlan(): where the plan leaves to, then the answer to the approval.
      const exit = model.planExitTarget(page.tab, { bypass: true });
      assert.deepEqual(exit, kind.pick ? { planDecision: 'acceptEdits', planExit: 'acceptEdits' } : { planDecision: 'default', planExit: 'settings' });
      model.leavePlanMode(page.tab);
      sock.client({ type: 'control_response', request_id: request.request_id, response: { behavior: 'allow', planDecision: exit.planDecision, planExit: exit.planExit, modeSeq: page.tab.modeSeq, updatedInput: { ...request.request.input, plan: 'The edited plan.' } } });
      model.statementSent(page.tab, SETTINGS);
      const answer = await pending;
      assert.equal(answer.behavior, 'allow', 'the approval is answered: nothing waits behind it');
      assert.equal(answer.updatedInput.plan, 'The edited plan.', 'the edited plan is the tool\'s input, where Claude Code reads the plan from');
      assert.equal(q.pushed.length, before, 'no message is sent in its place');
      await until(() => q.calls.at(-1) === kind.home);
      await settle();
      assert.deepEqual([page.drain().control, page.tab.planMode, page.stated()], [kind.homeControl, false, kind.homeStated]);
    } finally { end(sock); }
    // The page: the card's action asks first whether an approval is pending, and answers it through the approval's own channel.
    assert.match(panel, /if \(_approvePendingPlan\(tab\)\) return;\n\s+\/\/ Leave plan mode before the implementation prompt/);
    const approve = fnBody('function _approvePendingPlan(tab) {');
    assert.match(approve, /const pending = tab\._pendingPlan;\n  if \(!pending \|\| !tab\._activePerm \|\| tab\.ws\?\.readyState !== WebSocket\.OPEN\) return false;/);
    assert.match(approve, /_sendControlInner\(tab, pending\.requestId, \{\n    behavior: 'allow',/);
    assert.match(approve, /\.\.\.\(edited && edited !== plan \? \{ updatedInput: \{ \.\.\.\(pending\.req\?\.input \|\| \{\}\), plan: edited \} \} : \{\}\),/);
    assert.match(approve, /tab\._activePerm = false;\n  showThinking\(tab\);\n  setRunning\(tab, true\);\n  _showNextPerm\(tab\);/, 'the turn goes on, and what was buffered behind the card is handled');
    assert.match(fnBody('function _showNextPerm(tab) {'), /tab\._pendingPlan = \{ requestId: next\.requestId, req: next\.req \};/);
  });
}
const w = (q) => q.calls;

test('a tab that goes back to its settings on a process that never showed their mode runs in Default, and is told', async () => {
  // The tab picked Plan before its first message: the process started in a stated mode.
  const world1 = world();
  const sock = world1.connect();
  const page = new Page().attach(sock);
  try {
    model.pickMode(page.tab, 'plan');
    page.query();
    await until(() => world1.queries.length === 1);
    const q = world1.queries[0];
    assert.equal(q.options.permissionMode, 'plan');
    q.emit(init('plan'));
    await settle();
    page.drain().leavePlan();
    await until(() => q.calls.length === 1);
    await settle();
    assert.deepEqual(q.calls, ['default']);
    page.drain();
    assert.match(page.reasons[0], /did not start in the mode your Claude Code settings name/);
    assert.deepEqual([page.control, page.stated()], ['Default · from settings', { modeFromSettings: true }], 'shown as what the session runs in; the next process starts from the settings');
  } finally { end(sock); }
});

test('a page that does not number: a message that leaves the mode to the settings again takes the live session out of the stated mode', async () => {
  const world1 = world();
  const sock = world1.connect();
  try {
    sock.client({ type: 'query', prompt: 'a', windowId: WIN, modeFromSettings: true });
    await until(() => world1.queries.length === 1 && world1.queries[0].pushed.length === 1);
    const q = world1.queries[0];
    q.emit(init('acceptEdits'));
    await settle();
    sock.client({ type: 'query', prompt: 'plan it', windowId: WIN, sessionId: UUID, permissionMode: 'plan' });
    await until(() => q.calls.length === 1);
    sock.client({ type: 'query', prompt: 'implement', windowId: WIN, sessionId: UUID, modeFromSettings: true });
    await until(() => q.calls.length === 2);
    assert.deepEqual(q.calls, ['plan', 'acceptEdits'], 'back to the mode this process showed for the settings');
    assert.equal(sock.ws.sent.some(p => p.event && 'modeSeq' in p.event), false, 'and nothing is numbered for it');
  } finally { end(sock); }
});

// ── Finding 3 ──

test('finding 3: choosing the mode the control already shows is a pick', async () => {
  // "With settings defaultMode Bypass, the owner explicitly selects the displayed Default before the first
  // message or init. The selection is ignored, and the process starts or remains in settings-selected Bypass."
  const first = world();
  const sock = first.connect();
  const page = new Page().attach(sock);
  try {
    assert.deepEqual([page.control, page.stated()], ['From settings', { modeFromSettings: true }], 'a tab that never picked shows no mode it may not run in');
    page.pick('default');
    assert.deepEqual([page.tab.modeChosen, page.control], [true, 'Default']);
    page.query();
    await until(() => first.queries.length === 1);
    assert.equal(first.queries[0].options.permissionMode, 'default', 'the process starts in the pick, not in what the settings name');
  } finally { end(sock); }
  assert.doesNotMatch(fnBody('function populateModeDropdown($dd, tab) {'), /if \(m === t\.permissionMode\) return;/);
  assert.match(fnBody('function populateModeDropdown($dd, tab) {'), /if \(blocked\) \{ appendWarn\(t, bypass\.reason\); return; \}\n\s+\/\/ Every choice is a pick[^\n]*\n[^\n]*\n\s+setPermissionModeUI\(t, m\);/);

  // The owner's settings say defaultMode auto: the tab shows that it follows them and which mode that is; choosing it records it.
  const auto = await live({ started: 'auto' });
  try {
    assert.deepEqual([auto.page.control, auto.page.stated(), auto.page.tab.modeChosen], ['Auto · from settings', { modeFromSettings: true }, false]);
    assert.deepEqual(model.savedMode(auto.page.tab), { permissionMode: 'default', modeChosen: false, bypassChosen: false, modeSeq: 1 }, 'a mode from the settings is not saved as the tab\'s');
    auto.page.pick('auto');
    await until(() => auto.q.calls.length === 1);
    await settle();
    assert.deepEqual([auto.page.drain().control, auto.page.stated(), auto.page.tab.modeChosen, auto.q.calls], ['Auto', { permissionMode: 'auto' }, true, ['auto']]);
  } finally { end(auto.sock); }

  // defaultMode bypassPermissions: shown as Bypass from the settings, in the warning style; choosing it records the pick.
  const bypass = await live({ started: BYPASS });
  try {
    assert.deepEqual([bypass.page.control, bypass.page.warns, bypass.page.stated(), bypass.page.tab.bypassChosen], ['Bypass · from settings', true, { modeFromSettings: true }, false]);
    bypass.page.pick(BYPASS);
    await until(() => modeEvents(bypass.sock.ws).length === 1);
    assert.deepEqual([bypass.page.drain().control, bypass.page.warns, bypass.page.stated(), bypass.page.tab.bypassChosen], ['Bypass', true, { permissionMode: BYPASS }, true]);
    assert.equal(model.savedMode(bypass.page.tab).bypassChosen, true);
    // And choosing Default there leaves the Bypass the settings started.
    bypass.page.pick('default');
    await until(() => bypass.q.calls.at(-1) === 'default');
    await settle();
    assert.deepEqual([bypass.page.drain().control, bypass.page.warns], ['Default', false]);
  } finally { end(bypass.sock); }
});

// ── Finding 4 ──

test('finding 4: a mode picked while the socket is down is said to the running session when it is reclaimed, first', async () => {
  // "A Bypass turn loses its socket. The owner selects Default while disconnected. Reconnect successfully
  // reclaims the same ongoing turn, with no new init or mode status since the disconnect."
  for (const reload of [false, true]) {
    const { w: server, sock, page, q } = await live({ pick: BYPASS });
    let again = null;
    try {
      assert.equal(q.options.permissionMode, BYPASS);
      sock.close();                                   // the turn is in flight: the session waits for its tab
      page.pick('default');
      assert.deepEqual([page.tab.modeUnsent, page.control, page.warns], [true, 'Bypass → Default', true], 'the session is still in Bypass, and the control says so');
      let next = page;
      if (reload) {
        // The page is reloaded while disconnected: the saved tab comes back with its pick, its number and the warning.
        const saved = JSON.parse(JSON.stringify({ sessionId: page.tab.sessionId, ...model.savedMode(page.tab) }));
        next = new Page(freshTab({ sessionId: saved.sessionId, running: true, ...model.restoredMode(saved, { permissionMode: 'default', modeChosen: false }) }));
        assert.deepEqual([next.tab.modeSeq, next.control, next.warns], [page.tab.modeSeq, 'Bypass → Default', true]);
      }
      again = server.connect();
      next.attach(again);
      await until(() => again.ws.sent.some(m => m.type === 'reattach_result'));
      const answer = again.ws.sent.find(m => m.type === 'reattach_result');
      assert.deepEqual([answer.ok, answer.mode, answer.modeSeq], [true, BYPASS, 1]);
      next.drain();
      assert.deepEqual(again.received.map(m => m.type), ['reattach', 'set_permission_mode'], 'before anything else is sent');
      assert.deepEqual(again.received[1], { type: 'set_permission_mode', mode: 'default', modeSeq: 2 });
      await until(() => q.calls.length === 1);
      assert.deepEqual(q.calls, ['default'], 'the resumed session leaves Bypass');
      await until(() => modeEvents(again.ws).length === 1);
      assert.deepEqual([next.drain().control, next.warns, next.stated()], ['Default', false, { permissionMode: 'default' }]);
    } finally { end(sock, ...(again ? [again] : [])); }
  }
  // The page: a new socket has had no statement, the answer to reattach is a report like any other, and it is handled outside the buffer.
  assert.match(fnBody('function connectTab(tab) {'), /connectionOpened\(tab\);/);
  assert.match(panel, /_sessionSaysMode\(tab, msg\.mode, 'reattach', msg\);/);
});

test('a mode picked while the socket is down, and no session to reclaim: said on the new connection, and the next process starts in it', async () => {
  const { w: server, sock, page, q } = await live({ pick: BYPASS });
  let again = null;
  try {
    q.emit(result());
    await until(() => sock.ws.sent.some(m => m.type === 'done'));
    page.drain();
    sock.close();                                     // idle: the session ends with its socket
    page.pick('default');
    again = server.connect();
    page.attach(again);
    await until(() => again.ws.sent.some(m => m.type === 'reattach_result'));
    page.drain();
    assert.deepEqual(again.received.map(m => m.type), ['reattach', 'set_permission_mode']);
    await until(() => modeEvents(again.ws).length === 1);
    assert.deepEqual([page.drain().control, page.warns], ['Default', false]);
    page.query('next');
    await until(() => server.queries.length === 2);
    assert.equal(server.queries[1].options.permissionMode, 'default');
    assert.equal(server.queries[1].options.resume, UUID);
  } finally { end(sock, ...(again ? [again] : [])); }
});

// ── Finding 5 ──

test('finding 5: an automation run\'s EnterPlanMode leaves the tab\'s recorded Bypass pick alone, and the follow-up runs in it', async () => {
  // "An automation attaches to an empty tab with an owner-recorded Bypass pick. Its assistant emits
  // EnterPlanMode. After completion, the owner sends a manual follow-up."
  const server = world();
  const sock = server.connect();
  const page = new Page().attach(sock);
  try {
    model.pickMode(page.tab, BYPASS);
    const before = JSON.stringify(page.tab);
    // The dispatcher marks the tab while one of the run's events is handled; what reads the event asks the model.
    page.tab._runEvent = true;
    const event = model.runEvent(page.tab, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'EnterPlanMode', id: 't1', input: {} }] } });
    assert.equal(event.message.content[0].name, 'EnterPlanMode', 'the card is still rendered');
    assert.equal(model.sessionEnteredPlan(page.tab), false);
    assert.deepEqual(model.sessionReport(page.tab, 'plan', 'status', { seq: 1, numbered: true }), { stale: false, taken: false, changed: false, decided: false, restate: false, warned: false });
    assert.deepEqual(model.sessionReport(page.tab, 'plan', 'status'), { stale: false, taken: false, changed: false, decided: false, restate: false, warned: false });
    page.tab._runEvent = false;
    assert.equal(JSON.stringify({ ...page.tab, _runEvent: undefined }), before, 'nothing of the tab\'s own state was written');
    assert.deepEqual([page.control, page.tab.planMode], ['Bypass', false]);
    // The manual follow-up, in the tab's own session.
    page.tab.sessionId = UUID;
    const msg = page.query('carry on');
    assert.equal(msg.permissionMode, BYPASS);
    await until(() => server.queries.length === 1);
    assert.equal(server.queries[0].options.permissionMode, BYPASS, 'the follow-up starts in the mode the control shows');
  } finally { end(sock); }
  const render = fnBody('function renderAssistant(tab, msg) {');
  assert.match(render, /if \(tab === _rootOf\(tab\) && !tab\._runEvent && tools\.some\(t => t\.name === 'EnterPlanMode'\)\) \{\n    if \(!hasCapability\(tab, 'mode_statements'\) && sessionEnteredPlan\(tab\)\) _paintMode\(tab\);/);
  // Nor is the run's plan file this tab's: the two places an event sets it ask the same mark.
  assert.match(panel, /if \(ev\.path && !tab\._runEvent\) \{\n      tab\.planFilePath = ev\.path;/);
  assert.match(panel, /if \(tab && !tab\._runEvent\) tab\.planFilePath = block\.input\.file_path;/);
  // Against a bridge that does not number, the tab's own session calling EnterPlanMode enters plan mode through the same writer.
  const own = freshTab();
  model.pickMode(own, 'acceptEdits');
  assert.equal(model.sessionEnteredPlan(own), true);
  assert.deepEqual([own.permissionMode, own.planMode, own.planFrom], ['plan', true, { mode: 'acceptEdits' }]);
});

// ── Finding 8 (and the reasons of a switch away from Bypass) ──

test('finding 8: leaving a Bypass the owner\'s settings started, before its first init, blames nobody else', async () => {
  // "A never-picked process starts in Bypass from settings. Before its first init is observed, the owner uses
  // the plan toggle on and off. The delayed Bypass init gets BYPASS_FOREIGN."
  for (const numbered of [true, false]) {
    const server = world();
    const sock = server.connect();
    const page = new Page().attach(sock);
    try {
      page.query();
      await until(() => server.queries.length === 1 && server.queries[0].pushed.length === 1);
      const q = server.queries[0];
      assert.equal('permissionMode' in q.options, false, 'the settings choose the starting mode');
      if (numbered) { page.pick('plan'); page.leavePlan(); }
      else { sock.client({ type: 'set_permission_mode', mode: 'plan' }); sock.client({ type: 'set_permission_mode', mode: 'default' }); }
      await until(() => q.calls.length === 2);
      await settle();
      q.emit(init(BYPASS));                           // written before the switches landed
      await until(() => inits(sock.ws).length === 1);
      await settle();
      const reasons = modeEvents(sock.ws).map(e => e.reason).filter(Boolean);
      assert.equal(reasons.some(r => /other than you/i.test(r)), false, `numbered ${numbered}: ${reasons.join(' | ')}`);
      assert.ok(reasons.some(r => /Your Claude Code settings started this session in Bypass/.test(r)));
      // A page that numbers is told what is: the CLI in Bypass, the switch to the tab's own mode under way. Any other gets the tab's mode, as before.
      // (Either way this page numbers its statements: the query did.)
      assert.deepEqual([inits(sock.ws)[0].permissionMode, inits(sock.ws)[0].switching, inits(sock.ws)[0].mayBypass], [BYPASS, 'default', true], 'never as the tab\'s mode');
      assert.equal(q.calls.at(-1), 'default');
      if (numbered) assert.deepEqual([page.drain().warns, page.tab.planMode, page.stated()], [false, false, { modeFromSettings: true }]);
    } finally { end(sock); }
  }
});

test('the reason of a switch away from Bypass says whose Bypass it was', async () => {
  // The owner's own pick, left a moment ago: not "something other than you".
  const own = await live({ pick: BYPASS });
  try {
    own.page.pick('default');
    await until(() => own.q.calls.length === 1);
    await settle();
    own.q.emit(status(BYPASS));
    await until(() => modeEvents(own.sock.ws).some(e => e.reason));
    const reason = modeEvents(own.sock.ws).find(e => e.reason).reason;
    assert.doesNotMatch(reason, /other than you/i);
    assert.match(reason, /reported Bypass again after it had left it/);
  } finally { end(own.sock); }
  // A session that never was in Bypass by the owner's doing: something else did it.
  const foreign = await live({ pick: 'acceptEdits' });
  try {
    foreign.q.emit(status(BYPASS));
    await until(() => modeEvents(foreign.sock.ws).length === 1);
    assert.match(modeEvents(foreign.sock.ws)[0].reason, /Something other than you/);
    assert.deepEqual(foreign.q.calls, ['acceptEdits']);
    await settle();   // the switch back is acknowledged: only then is the session out of Bypass
    assert.deepEqual([foreign.page.drain().control, foreign.page.warns], ['Accept Edits', false]);
  } finally { end(foreign.sock); }
  // A report written while a switch of the session's own is under way is older than that switch: no reason at all.
  let release = null;
  const held = await live({ pick: BYPASS, behaviour: { hold: (mode) => (mode === 'default' && !release ? new Promise(r => { release = r; }) : null) } });
  try {
    held.page.pick('default');
    await until(() => !!release);
    held.q.emit(status(BYPASS));
    await until(() => held.q.calls.length === 2);
    release();
    await settle();
    assert.equal(modeEvents(held.sock.ws).some(e => e.reason), false);
    assert.deepEqual([held.page.drain().control, held.page.warns], ['Default', false]);
  } finally { end(held.sock); }
  // No window of time decides it any more.
  const bridge = read('lib/claude-agent-bridge.js');
  assert.doesNotMatch(bridge, /_ownModeSwitchAt|OWN_MODE_SWITCH_MS/);
  assert.doesNotMatch(panel, /_ownModeSwitchAt/);
});

// ── A pick before the first init of a process that started from the settings ──

test('a pick made before the first init of a settings-started process stands when that init arrives', async () => {
  const server = world();
  const sock = server.connect();
  const page = new Page().attach(sock);
  try {
    page.query();
    await until(() => server.queries.length === 1 && server.queries[0].pushed.length === 1);
    const q = server.queries[0];
    page.pick('acceptEdits');
    await until(() => q.calls.length === 1);
    await settle();
    q.emit(init('auto'));                             // the settings' mode, written before the switch landed
    await until(() => inits(sock.ws).length === 1);
    assert.deepEqual([inits(sock.ws)[0].permissionMode, inits(sock.ws)[0].modeSeq], ['acceptEdits', 2]);
    assert.deepEqual([page.drain().control, page.tab.modeChosen, page.stated()], ['Accept Edits', true, { permissionMode: 'acceptEdits' }]);
    assert.deepEqual(q.calls, ['acceptEdits']);
  } finally { end(sock); }
});

// ── The control never under-warns ──

test('the control says Bypass whenever the session is in it or may be', () => {
  const tab = freshTab({ sessionId: UUID });
  // A report that says Bypass to a tab with another pick: not taken, and warned of until a report at or after the tab's latest statement says the session is out of it.
  model.pickMode(tab, 'acceptEdits');
  assert.equal(model.sessionReport(tab, BYPASS, 'init', { seq: 1, numbered: true, mayBypass: true }).restate, true);
  assert.deepEqual([tab.permissionMode, model.modeControl(model.controlFacts(tab, SETTINGS)).text, model.modeControl(model.controlFacts(tab, SETTINGS)).state], ['acceptEdits', 'Bypass → Accept Edits', 'bypass']);
  model.sessionReport(tab, 'acceptEdits', 'mode_changed', { seq: 1, numbered: true });
  assert.equal(model.modeControl(model.controlFacts(tab, SETTINGS)).state, 'bypass', 'a report that does not say whether the session may be in Bypass ends nothing');
  model.sessionReport(tab, 'acceptEdits', 'mode_changed', { seq: 1, numbered: true, mayBypass: false });
  assert.equal(model.modeControl(model.controlFacts(tab, SETTINGS)).state, '');
  // After a reload the warning is there before the session has said anything again, and only a report ends it.
  model.sessionReport(tab, BYPASS, 'status', { seq: 1, numbered: true, mayBypass: true });
  const saved = JSON.parse(JSON.stringify({ sessionId: UUID, ...model.savedMode(tab) }));
  assert.equal(saved.sessionBypass, true);
  const back = { ...freshTab(), ...model.restoredMode(saved, { permissionMode: 'default', modeChosen: false }) };
  assert.deepEqual([back.permissionMode, back.bypassChosen, model.modeControl(model.controlFacts(back, SETTINGS)).state], ['acceptEdits', false, 'bypass']);
  assert.deepEqual(model.statedMode(back, SETTINGS).permissionMode, 'acceptEdits', 'shown, never stated');
  assert.equal(model.restoredMode({ ...saved, sessionId: null }, {}).mayBypass, true);
  model.sessionForgotten(back);
  assert.equal(model.modeControl(model.controlFacts(back, SETTINGS)).state, 'bypass', 'another conversation in the tab: the process of the one it left is still there');
  model.sessionReport(back, 'acceptEdits', 'init', { seq: 1, numbered: true, mayBypass: false });
  assert.equal(model.modeControl(model.controlFacts(back, SETTINGS)).state, '');
  // A page whose saved number was lost is behind the session's: it takes the number, and a pick it could not
  // send yet is still the newer statement (said again, not replaced by the session's older mode).
  const lost = freshTab({ sessionId: UUID, modeSeq: 2, modeUnsent: true, permissionMode: 'default', modeChosen: true });
  assert.deepEqual(model.sessionReport(lost, BYPASS, 'reattach', { seq: 5, numbered: true }), { stale: true, taken: false, changed: false, decided: false, restate: true, warned: true });
  assert.deepEqual([lost.permissionMode, lost.modeSeq, model.modeControl(model.controlFacts(lost, SETTINGS)).text], ['default', 6, 'Bypass → Default']);
  const behind = freshTab({ sessionId: UUID, modeSeq: 2, permissionMode: 'default', modeChosen: true });
  assert.equal(model.sessionReport(behind, 'acceptEdits', 'reattach', { seq: 5, numbered: true }).taken, true, 'with nothing unsent, the session\'s word at that number is the current one');
  assert.deepEqual([behind.permissionMode, behind.modeSeq], ['acceptEdits', 5]);
  // Auto-approve is said too, and a bridge that cannot leave the mode to the settings runs such a tab in Default.
  assert.equal(model.modeControl({ ...model.controlFacts(freshTab()), autoApprove: true }).text, 'From settings · auto-approve');
  assert.deepEqual(model.controlFacts(freshTab(), { settingsPick: false }), { mode: 'default', follows: false, known: true, leaving: false });
});

// ── A session without the panel flag ──

test('a session without the panel flag knows no numbers: every statement is applied and nothing is numbered', async () => {
  const queries = [];
  world();
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(), includePartialMessages: false,
    queryFactory: (args) => { const q = scriptedQuery(args); queries.push(q); return q; },
    acquireSessionLock: () => ({ ok: true }), heartbeatLock: () => {}, releaseAllLocks: () => {}, getSessionCost: () => 0, addCost: () => {},
    maybeInjectSkillPrompt: (prompt) => ({ prompt }), toCliModelName: (m) => m, writePlanFile: () => ({ ok: false }),
  });
  const sent = [];
  const session = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send: (data) => sent.push(JSON.parse(data)) }, {});
  try {
    session.ensureQuery();
    await session.handleMessage({ type: 'set_permission_mode', mode: 'acceptEdits', modeSeq: 5 });
    assert.deepEqual(sent.at(-1), { type: 'event', event: { type: 'mode_changed', mode: 'acceptEdits' } });
    await session.handleMessage({ type: 'set_permission_mode', mode: 'plan', modeSeq: 2 });
    assert.equal(session.permissionMode, 'plan', 'an "older" number means nothing to it');
    const events = sent.length;
    await session.handleMessage({ type: 'set_permission_mode', fromSettings: true, modeSeq: 9 });
    assert.deepEqual([sent.length, session.permissionMode, session._modeFromSettings === true, queries[0].calls.length], [events, 'plan', false, 2], 'no way back to the settings\' mode, and none into it');
    session._handleQuery({ prompt: 'x', permissionMode: 'default', modeSeq: 1 });
    assert.equal(session.permissionMode, 'default');
    queries[0].emit(init(BYPASS));
    await until(() => sent.some(p => p.event?.subtype === 'init'));
    assert.deepEqual(sent.find(p => p.event?.subtype === 'init').event, init(BYPASS), 'reports pass through untouched');
    assert.deepEqual([session._pageSeq, session._modeCalls, session._bypassHeld, queries[0].calls], [undefined, undefined, undefined, ['acceptEdits', 'plan', 'default']]);
  } finally { session.destroy(); shutdownAllBridges(); }
});

// ── Finding 9: the contract lists every writer ──

// The contract document lives in the development repository; a checkout without docs/claude-sidepanel.md has nothing to compare.
const CONTRACT_DOC = join(HERE, '..', '..', 'docs', 'claude-sidepanel.md');

test('finding 9: docs/claude-sidepanel.md names every writer of a tab\'s mode and of plan state', { skip: !existsSync(CONTRACT_DOC) && 'docs/claude-sidepanel.md is not in this checkout' }, () => {
  const doc = read('../docs/claude-sidepanel.md');
  const source = read('public/shared/cp/cp-permission-model.js');
  // Every function of the model that writes the tab's mode, its pick, plan state or the statement number.
  const writers = [...source.matchAll(/\n(?:export )?function (\w+)\([^)]*\) \{\n([\s\S]*?)\n\}\n/g)]
    .filter(([, , body]) => /\bsetMode\(|\benterPlan\(|tab\.(?:modeChosen|bypassChosen|planFrom|planMode|modeSeq|permissionMode) = /.test(body))
    .map(([, name]) => name);
  assert.deepEqual(writers.sort(), ['currentReport', 'enterPlan', 'leavePlanMode', 'nextStatement', 'pickMode', 'sessionEnteredPlan', 'sessionReport', 'setMode', 'statementDropped', 'unnumberedReport'].sort(), 'a new writer in the model needs a row in the table');
  // (M7: the fact "may be in Bypass" has its writers listed on both sides too.)
  for (const name of ['`statementDropped()`', '`statementSent()`', '`sessionForgotten()`', '`_noteProcessStarted`', '`_switchMode`', '**W1.', '**W2.', '**W3.', '**W4.', '**W5.']) assert.ok(doc.includes(name), `${name} is in the document`);
  for (const name of ['pickMode', 'leavePlanMode', 'sessionEnteredPlan', 'sessionReport', 'restoredMode', 'setMode', 'planFrom']) assert.ok(doc.includes(`\`${name}`), `the doc names ${name}`);
  // And the places of the monolith that call them, each a row of its own.
  for (const name of ['setPermissionModeUI()', '_planApproved()', '_leavePlanUI()', '_approvePendingPlan()', '_sessionSaysMode()', '_stateOwnMode()', 'createTab()', 'restoreTabs()']) assert.ok(doc.includes(name), `the doc names ${name}`);
  // What the gate found missing or overstated.
  assert.match(doc, /EnterPlanMode/);
  assert.match(doc, /\/plan/);
  assert.match(doc, /re-output the plan/);
  assert.doesNotMatch(doc, /the constant Default, and it ends the record/);
  for (const m of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8']) assert.ok(doc.includes(`**${m}.`), `the doc states ${m}`);
  assert.ok(doc.includes('mode_statements'));
});

after(() => { shutdownAllBridges(); });

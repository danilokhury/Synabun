import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  ClaudeSession,
  PANEL_CAPABILITIES,
  configureClaudeBridge,
  createClaudeBridge,
  shutdownAllBridges,
} from '../lib/claude-agent-bridge.js';

// Bypass in the sidepanel is the SDK's bypassPermissions mode. A tab's process
// is launched able to take it, and only what the user chose puts a conversation
// there: the mode a query or a starting control states (the mode control, a
// restored tab), `set_permission_mode`, the plan card's own choice, or the
// user's settings when the tab never picked a mode. These tests pin each of
// those ways in, every other path that can report or carry a mode, what
// happens when Claude Code refuses, and that a session built without the panel
// flag (the Assistant brain) is exactly what it was.

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
    q.calls.push(['setPermissionMode', mode]);
    // `hold`: a call the CLI has not answered yet (a promise the test settles).
    const held = behaviour.hold?.(mode);
    if (held) await held;
    const refusal = behaviour.refuse?.(mode);
    if (refusal) throw new Error(refusal);
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

function configure(extra = {}, behaviour = {}) {
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
    toCliModelName: (model) => model,
    writePlanFile: () => ({ ok: false }),
    // The machine these tests run on decides nothing: no block unless a test sets one.
    bypassBlock: () => '',
    ...extra,
  });
  return queries;
}

function panelConnection(extra = {}, behaviour = {}) {
  const queries = configure(extra, behaviour);
  const ws = new EventEmitter();
  Object.assign(ws, { readyState: 1, bufferedAmount: 0, sent: [], ping() {}, terminate() {} });
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  createClaudeBridge(ws);
  const client = (msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)));
  return { ws, queries, client, close: () => { ws.readyState = 3; ws.emit('close'); } };
}

function plainSession(opts = {}, behaviour = {}) {
  const queries = configure({}, behaviour);
  const sent = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (data) => sent.push(JSON.parse(data)) };
  return { session: new ClaudeSession(ws, opts), queries, sent };
}

async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 5));
  }
}
const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BYPASS = 'bypassPermissions';
const init = (permissionMode, extra = {}) => ({ type: 'system', subtype: 'init', session_id: UUID, tools: [], mcp_servers: [], slash_commands: [], ...(permissionMode ? { permissionMode } : {}), ...extra });
const status = (permissionMode) => ({ type: 'system', subtype: 'status', status: null, permissionMode, session_id: UUID });
const modeChanges = (sent) => sent.filter(p => p.type === 'event' && p.event?.type === 'mode_changed').map(p => p.event);
const systemEvents = (sent, subtype) => sent.filter(p => p.type === 'event' && p.event?.type === 'system' && p.event.subtype === subtype).map(p => p.event);
const setModeCalls = (q) => q.calls.filter(c => c[0] === 'setPermissionMode').map(c => c[1]);
const controlRequests = (sent) => sent.filter(p => p.type === 'control_request');

async function startPanelTurn(query = {}, extra = {}, behaviour = {}) {
  const conn = panelConnection(extra, behaviour);
  conn.client({ type: 'query', prompt: 'hello', windowId: 'w-bypass', ...query });
  await until(() => conn.queries.length === 1 && conn.queries[0].pushed.length === 1);
  return conn;
}

// ── The ways in ──

test('the hello says Bypass is real', () => {
  const { ws, close } = panelConnection();
  try {
    assert.ok(PANEL_CAPABILITIES.includes('bypass_mode'));
    assert.ok(ws.sent[0].capabilities.includes('bypass_mode'));
  } finally { close(); shutdownAllBridges(); }
});

test('a tab in Bypass starts its conversation in the SDK\'s bypassPermissions mode', async () => {
  const { ws, queries, close } = await startPanelTurn({ permissionMode: BYPASS });
  try {
    assert.equal(queries[0].options.permissionMode, BYPASS);
    assert.equal(queries[0].options.allowDangerouslySkipPermissions, true, 'the option without which the SDK refuses the mode');
    queries[0].emit(init(BYPASS));
    await until(() => systemEvents(ws.sent, 'init').length === 1);
    assert.equal(systemEvents(ws.sent, 'init')[0].permissionMode, BYPASS);
    assert.deepEqual(modeChanges(ws.sent), [], 'nothing to correct');
    assert.deepEqual(setModeCalls(queries[0]), []);
  } finally { close(); shutdownAllBridges(); }
});

test('a tab in another mode starts in that mode, on a process a later switch to Bypass can reach', async () => {
  const { queries, close } = await startPanelTurn({ permissionMode: 'default' });
  try {
    assert.equal(queries[0].options.permissionMode, 'default');
    assert.equal(queries[0].options.allowDangerouslySkipPermissions, true);
  } finally { close(); shutdownAllBridges(); }
});

test('the mode switch takes a running conversation into Bypass and out of it', async () => {
  const { ws, queries, client, close } = await startPanelTurn({ permissionMode: 'default' });
  try {
    queries[0].emit(init('default'));
    client({ type: 'set_permission_mode', mode: BYPASS });
    await until(() => modeChanges(ws.sent).length === 1);
    assert.deepEqual(setModeCalls(queries[0]), [BYPASS]);
    assert.deepEqual(modeChanges(ws.sent)[0], { type: 'mode_changed', mode: BYPASS });
    // The CLI saying so afterwards is the tab's own choice, and is left alone.
    queries[0].emit(status(BYPASS));
    queries[0].emit(init(BYPASS));
    await until(() => systemEvents(ws.sent, 'init').length === 2);
    assert.deepEqual(setModeCalls(queries[0]), [BYPASS]);
    assert.equal(systemEvents(ws.sent, 'init')[1].permissionMode, BYPASS);

    client({ type: 'set_permission_mode', mode: 'default' });
    await until(() => modeChanges(ws.sent).length === 2);
    assert.deepEqual(setModeCalls(queries[0]), [BYPASS, 'default']);
    assert.deepEqual(modeChanges(ws.sent)[1], { type: 'mode_changed', mode: 'default' });
  } finally { close(); shutdownAllBridges(); }
});

test('a switch to Bypass sent before the first init is not taken for a start that failed', async () => {
  const { ws, queries, client, close } = await startPanelTurn({ permissionMode: 'default' });
  try {
    client({ type: 'set_permission_mode', mode: BYPASS });
    // The turn's init was emitted before the CLI handled the switch.
    queries[0].emit(init('default'));
    await until(() => modeChanges(ws.sent).length === 1 && systemEvents(ws.sent, 'init').length === 1);
    assert.deepEqual(modeChanges(ws.sent), [{ type: 'mode_changed', mode: BYPASS }]);
    queries[0].emit(status(BYPASS));
    await until(() => systemEvents(ws.sent, 'status').length === 1);
    assert.deepEqual(setModeCalls(queries[0]), [BYPASS], 'the tab stays in the Bypass it chose');
  } finally { close(); shutdownAllBridges(); }
});

test('a later message of a tab in Bypass states the mode again on the live session', async () => {
  const { queries, client, close } = await startPanelTurn({ permissionMode: 'default' });
  try {
    queries[0].emit(init('default'));
    client({ type: 'query', prompt: 'again', windowId: 'w-bypass', permissionMode: BYPASS });
    await until(() => queries[0].pushed.length === 2);
    await settle();
    assert.equal(queries.length, 1, 'no restart: the process was launched able to take it');
    assert.deepEqual(setModeCalls(queries[0]), [BYPASS]);
  } finally { close(); shutdownAllBridges(); }
});

test('a restored tab that was in Bypass starts in it through the cold-start path', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    // After a server restart the session object knows the id and nothing else.
    client({ type: 'reattach', windowId: 'w-bypass', sessionId: UUID });
    await until(() => ws.sent.some(m => m.type === 'reattach_result'));
    client({ type: 'compact', config: { cwd: process.cwd(), sessionId: UUID, windowId: 'w-bypass', permissionMode: BYPASS, toolPolicy: 'full' } });
    await until(() => queries.length === 1);
    assert.equal(queries[0].options.resume, UUID);
    assert.equal(queries[0].options.permissionMode, BYPASS);
    assert.equal(queries[0].options.allowDangerouslySkipPermissions, true);
  } finally { close(); shutdownAllBridges(); }

  // And a first message, which is its own configuration.
  const restored = await startPanelTurn({ permissionMode: BYPASS, sessionId: UUID });
  try {
    assert.equal(restored.queries[0].options.resume, UUID);
    assert.equal(restored.queries[0].options.permissionMode, BYPASS);
  } finally { restored.close(); shutdownAllBridges(); }
});

async function planCard(conn) {
  const pending = conn.queries[0].options.canUseTool('ExitPlanMode', { plan: 'Do the thing.' }, { signal: new AbortController().signal });
  await until(() => controlRequests(conn.ws.sent).length === 1);
  return { pending, requestId: controlRequests(conn.ws.sent)[0].request_id };
}

test('the plan card\'s Bypass choice continues the approved plan in Bypass', async () => {
  const conn = await startPanelTurn({ permissionMode: 'plan' });
  try {
    const { pending, requestId } = await planCard(conn);
    conn.client({ type: 'control_response', request_id: requestId, response: { behavior: 'allow', planDecision: BYPASS } });
    assert.equal((await pending).behavior, 'allow');
    await until(() => modeChanges(conn.ws.sent).length === 1);
    assert.deepEqual(setModeCalls(conn.queries[0]), [BYPASS]);
    assert.deepEqual(modeChanges(conn.ws.sent)[0], { type: 'mode_changed', mode: BYPASS });
  } finally { conn.close(); shutdownAllBridges(); }
});

test('a plain plan approval never continues in Bypass, whatever the tab was in before the plan', async () => {
  const conn = await startPanelTurn({ permissionMode: BYPASS });
  try {
    conn.queries[0].emit(init(BYPASS));
    // The model entered plan mode by itself; the tab's own mode is still Bypass.
    conn.queries[0].emit(status('plan'));
    const { pending, requestId } = await planCard(conn);
    conn.client({ type: 'control_response', request_id: requestId, response: { behavior: 'allow' } });
    assert.equal((await pending).behavior, 'allow');
    // The CLI goes back to the mode it was in before the plan, and says so
    // before the bridge's own switch lands: stated again, without alarm.
    conn.queries[0].emit(status(BYPASS));
    await until(() => modeChanges(conn.ws.sent).some(e => e.mode === 'default'));
    await until(() => setModeCalls(conn.queries[0]).filter(m => m === 'default').length >= 2);
    assert.equal(setModeCalls(conn.queries[0]).includes(BYPASS), false);
    assert.equal(modeChanges(conn.ws.sent).some(e => e.reason), false, 'its own switch is not reported as someone else\'s');
    assert.equal(systemEvents(conn.ws.sent, 'status').at(-1).permissionMode, 'default');
  } finally { conn.close(); shutdownAllBridges(); }
});

test('a tab that never picked a mode takes Bypass from the user\'s settings, at start only', async () => {
  const { ws, queries, close } = await startPanelTurn({ modeFromSettings: true });
  try {
    assert.equal('permissionMode' in queries[0].options, false, 'omitted: the CLI reads permissions.defaultMode');
    assert.equal(queries[0].options.allowDangerouslySkipPermissions, true);
    queries[0].emit(init(BYPASS));
    await until(() => systemEvents(ws.sent, 'init').length === 1);
    assert.equal(systemEvents(ws.sent, 'init')[0].permissionMode, BYPASS);
    assert.deepEqual(setModeCalls(queries[0]), [], 'the user\'s settings named it');
    assert.deepEqual(modeChanges(ws.sent), []);
  } finally { close(); shutdownAllBridges(); }

  // Started in Default from the settings; Bypass showing up at a later turn is not the settings' doing.
  const later = await startPanelTurn({ modeFromSettings: true });
  try {
    later.queries[0].emit(init('default'));
    later.queries[0].emit(init(BYPASS));
    await until(() => systemEvents(later.ws.sent, 'init').length === 2);
    assert.deepEqual(setModeCalls(later.queries[0]), ['default']);
    assert.equal(systemEvents(later.ws.sent, 'init')[1].permissionMode, 'default', 'the page is never told Bypass');
    assert.match(modeChanges(later.ws.sent)[0].reason, /other than you/i);
  } finally { later.close(); shutdownAllBridges(); }
});

test('a restarted process of a tab that leaves the mode to the settings is judged by its own first init', async () => {
  const { ws, queries, client, close } = await startPanelTurn({ modeFromSettings: true });
  try {
    queries[0].emit(init(BYPASS)); // the user's settings named Bypass
    await until(() => systemEvents(ws.sent, 'init').length === 1);
    // The tool policy changes: the process restarts, still leaving the mode to the settings.
    client({ type: 'query', prompt: 'again', windowId: 'w-bypass', sessionId: UUID, modeFromSettings: true, toolPolicy: 'read-only' });
    await until(() => queries.length === 2 && queries[1].pushed.length === 1);
    assert.equal('permissionMode' in queries[1].options, false);
    queries[1].emit(init('default')); // the user changed their settings in between
    await until(() => systemEvents(ws.sent, 'init').length === 2);
    assert.deepEqual(modeChanges(ws.sent), [], 'Bypass was not asked for, so nothing was refused');
    // From here Bypass is not the tab's mode: one that shows up later is undone.
    queries[1].emit(status(BYPASS));
    await until(() => modeChanges(ws.sent).length === 1);
    assert.deepEqual(setModeCalls(queries[1]), ['default']);
  } finally { close(); shutdownAllBridges(); }
});

// ── What is not a way in ──

test('a Bypass the CLI reports that the tab did not choose is switched back at once', async () => {
  for (const report of [status(BYPASS), init(BYPASS)]) {
    const { ws, queries, close } = await startPanelTurn({ permissionMode: 'acceptEdits' });
    try {
      queries[0].emit(init('acceptEdits'));
      queries[0].emit(report);
      await until(() => modeChanges(ws.sent).length === 1);
      assert.deepEqual(setModeCalls(queries[0]), ['acceptEdits'], `${report.subtype}: back to the mode the tab is in`);
      assert.equal(modeChanges(ws.sent)[0].mode, 'acceptEdits');
      assert.match(modeChanges(ws.sent)[0].reason, /other than you/i);
      const forwarded = systemEvents(ws.sent, report.subtype).at(-1);
      assert.equal(forwarded.permissionMode, 'acceptEdits', 'the page never sees a Bypass it could take for a choice');
      assert.equal(JSON.stringify(ws.sent.slice(1)).includes(`"permissionMode":"${BYPASS}"`), false);
    } finally { close(); shutdownAllBridges(); }
  }
});

test('the very first init cannot bring Bypass to a tab that stated another mode', async () => {
  const { ws, queries, close } = await startPanelTurn({ permissionMode: 'default' });
  try {
    queries[0].emit(init(BYPASS));
    await until(() => modeChanges(ws.sent).length === 1);
    assert.deepEqual(setModeCalls(queries[0]), ['default']);
    assert.equal(systemEvents(ws.sent, 'init')[0].permissionMode, 'default');
  } finally { close(); shutdownAllBridges(); }
});

test('a session that cannot be taken out of a Bypass nobody chose is stopped', async () => {
  const { ws, queries, close } = await startPanelTurn({ permissionMode: 'default' }, {}, { refuse: (mode) => (mode === 'default' ? 'control channel closed' : '') });
  try {
    queries[0].emit(init('default'));
    queries[0].emit(status(BYPASS));
    await until(() => ws.sent.some(m => m.type === 'error'));
    assert.match(ws.sent.find(m => m.type === 'error').message, /could not be switched back/i);
    assert.equal(queries[0].options.abortController.signal.aborted, true, 'the process is ended');
    assert.ok(ws.sent.some(m => m.type === 'done'));
  } finally { close(); shutdownAllBridges(); }
});

test('a permission card cannot switch the session to Bypass', async () => {
  const { ws, queries, client, close } = await startPanelTurn({ permissionMode: 'default' });
  try {
    const rule = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' };
    const pending = queries[0].options.canUseTool('Bash', { command: 'npm test' }, { signal: new AbortController().signal, toolUseID: 'toolu_1' });
    await until(() => controlRequests(ws.sent).length === 1);
    client({ type: 'control_response', request_id: controlRequests(ws.sent)[0].request_id, response: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: BYPASS, destination: 'session' }, rule, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } });
    const result = await pending;
    assert.deepEqual(result.updatedPermissions, [rule, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);

    const only = queries[0].options.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'toolu_2' });
    await until(() => controlRequests(ws.sent).length === 2);
    client({ type: 'control_response', request_id: controlRequests(ws.sent)[1].request_id, response: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: BYPASS, destination: 'userSettings' }] } });
    const bare = await only;
    assert.equal('updatedPermissions' in bare, false);
    assert.equal(bare.decisionClassification, 'user_temporary', 'an approval for this once');
    assert.equal(ws.sent.some(m => m.type === 'event' && m.event?.type === 'mode_changed'), false);
  } finally { close(); shutdownAllBridges(); }
});

test('nothing but the mode messages and the plan decision reads a mode from the page', async () => {
  const { ws, queries, client, close } = await startPanelTurn({ permissionMode: 'default' });
  try {
    queries[0].emit(init('default'));
    // Fields a page could carry on messages that do not set the mode.
    client({ type: 'heartbeat', windowId: 'w-bypass', sessionId: UUID, permissionMode: BYPASS, mode: BYPASS });
    client({ type: 'mcp_status', permissionMode: BYPASS });
    client({ type: 'session_request', id: 'r1', what: 'permission_rules', args: { mode: BYPASS }, config: { permissionMode: BYPASS, sessionId: UUID } });
    client({ type: 'abort', permissionMode: BYPASS });
    client({ type: 'set_permission_mode', mode: 'yolo' });
    await until(() => ws.sent.some(m => m.type === 'aborted'));
    await settle();
    assert.deepEqual(setModeCalls(queries[0]), []);
    assert.deepEqual(modeChanges(ws.sent), []);
    // A question's answer or a permission answer carrying a plan decision is not a plan approval.
    const pending = queries[0].options.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal });
    await until(() => controlRequests(ws.sent).length === 1);
    client({ type: 'control_response', request_id: controlRequests(ws.sent)[0].request_id, response: { behavior: 'allow', planDecision: BYPASS } });
    await pending;
    await settle(120);
    assert.deepEqual(setModeCalls(queries[0]), []);
  } finally { close(); shutdownAllBridges(); }
});

// ── Refusals ──

test('a Bypass that Claude Code refuses leaves the tab in the mode it had, and says why', async () => {
  const refuse = (mode) => (mode === BYPASS ? 'Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration' : '');
  const { ws, queries, client, close } = await startPanelTurn({ permissionMode: 'acceptEdits' }, {}, { refuse });
  try {
    queries[0].emit(init('acceptEdits'));
    client({ type: 'set_permission_mode', mode: BYPASS });
    await until(() => modeChanges(ws.sent).length === 1);
    assert.equal(modeChanges(ws.sent)[0].mode, 'acceptEdits');
    assert.match(modeChanges(ws.sent)[0].reason, /turned off by your Claude Code settings/);
    assert.deepEqual(setModeCalls(queries[0]), [BYPASS, 'acceptEdits'], 'the mode it had is stated again');
    assert.equal(ws.sent.some(m => m.type === 'error'), false);

    // The plan card's choice is refused the same way: the plan continues in Default.
    const pending = queries[0].options.canUseTool('ExitPlanMode', { plan: 'p' }, { signal: new AbortController().signal });
    await until(() => controlRequests(ws.sent).length === 1);
    client({ type: 'control_response', request_id: controlRequests(ws.sent)[0].request_id, response: { behavior: 'allow', planDecision: BYPASS } });
    await pending;
    await until(() => modeChanges(ws.sent).length === 2);
    assert.equal(modeChanges(ws.sent)[1].mode, 'default');
    assert.match(modeChanges(ws.sent)[1].reason, /turned off/);
    assert.equal(setModeCalls(queries[0]).at(-1), 'default');
  } finally { close(); shutdownAllBridges(); }
});

test('a tab that asked for Bypass and did not start in it is told, and is not in it', async () => {
  const { ws, queries, client, close } = await startPanelTurn({ permissionMode: BYPASS });
  try {
    // The user's settings turn Bypass off: the CLI starts in Default.
    queries[0].emit(init('default'));
    await until(() => modeChanges(ws.sent).length === 1);
    assert.equal(modeChanges(ws.sent)[0].mode, 'default');
    assert.match(modeChanges(ws.sent)[0].reason, /did not start this session in Bypass/);
    // From here Bypass is no longer the tab's mode: one that shows up is undone.
    queries[0].emit(status(BYPASS));
    await until(() => modeChanges(ws.sent).length === 2);
    assert.deepEqual(setModeCalls(queries[0]), ['default']);
    client({ type: 'abort' });
  } finally { close(); shutdownAllBridges(); }
});

test('where Claude Code cannot be launched with Bypass, the option is left out and the mode refused', async () => {
  const blocked = { bypassBlock: () => 'Bypass is not available: Claude Code refuses it when it runs as root.' };
  const { ws, queries, client, close } = await startPanelTurn({ permissionMode: BYPASS }, blocked);
  try {
    assert.equal('allowDangerouslySkipPermissions' in queries[0].options, false, 'the CLI would exit at start');
    assert.equal(queries[0].options.permissionMode, 'default');
    assert.equal(modeChanges(ws.sent)[0].mode, 'default');
    assert.match(modeChanges(ws.sent)[0].reason, /root/);
    queries[0].emit(init('default'));
    client({ type: 'set_permission_mode', mode: BYPASS });
    await until(() => modeChanges(ws.sent).length === 2);
    assert.equal(modeChanges(ws.sent)[1].mode, 'default');
    assert.deepEqual(setModeCalls(queries[0]), [], 'the CLI is not even asked');
    // The plan card's Bypass choice falls back to a plain approval.
    const pending = queries[0].options.canUseTool('ExitPlanMode', { plan: 'p' }, { signal: new AbortController().signal });
    await until(() => controlRequests(ws.sent).length === 1);
    client({ type: 'control_response', request_id: controlRequests(ws.sent)[0].request_id, response: { behavior: 'allow', planDecision: BYPASS } });
    await pending;
    await until(() => setModeCalls(queries[0]).length === 1);
    assert.deepEqual(setModeCalls(queries[0]), ['default']);
  } finally { close(); shutdownAllBridges(); }
});

// ── A session without the panel flag (the Assistant brain) ──

test('a session without the panel flag gets the bypass option only from its own opts, as before', () => {
  const plain = plainSession();
  try {
    plain.session.ensureQuery();
    assert.equal('allowDangerouslySkipPermissions' in plain.queries[0].options, false);
  } finally { plain.session.destroy(); }
  const brain = plainSession({ allowDangerouslySkipPermissions: true, permissionMode: BYPASS });
  try {
    brain.session.ensureQuery();
    assert.equal(brain.queries[0].options.allowDangerouslySkipPermissions, true);
    assert.equal(brain.queries[0].options.permissionMode, BYPASS);
  } finally { brain.session.destroy(); }
  // The block that applies to panel tabs is not consulted for it.
  const queries = configure({ bypassBlock: () => 'blocked' });
  const session = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send() {} }, { allowDangerouslySkipPermissions: true, permissionMode: BYPASS });
  try {
    session.ensureQuery();
    assert.equal(queries[0].options.allowDangerouslySkipPermissions, true);
    assert.equal(queries[0].options.permissionMode, BYPASS);
  } finally { session.destroy(); shutdownAllBridges(); }
});

test('a session without the panel flag passes mode reports and permission updates through untouched', async () => {
  const { session, queries, sent } = plainSession();
  try {
    session.ensureQuery();
    const first = init(BYPASS);
    const report = status(BYPASS);
    queries[0].emit(first);
    queries[0].emit(report);
    queries[0].emit(init(BYPASS));
    await until(() => systemEvents(sent, 'init').length === 2);
    assert.deepEqual(systemEvents(sent, 'init')[0], first);
    assert.deepEqual(systemEvents(sent, 'status')[0], report);
    assert.equal(session.permissionMode, 'default', 'its own record is not rewritten by a report');
    assert.deepEqual(setModeCalls(queries[0]), [], 'and nothing is switched back');
    assert.deepEqual(modeChanges(sent), []);

    const updates = [{ type: 'setMode', mode: BYPASS, destination: 'session' }];
    const pending = queries[0].options.canUseTool('Bash', { command: 'x' }, { signal: new AbortController().signal });
    await until(() => controlRequests(sent).length === 1);
    await session.handleMessage({ type: 'control_response', request_id: controlRequests(sent)[0].request_id, response: { behavior: 'allow', updatedPermissions: updates } });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { command: 'x' }, updatedPermissions: updates });
  } finally { session.destroy(); shutdownAllBridges(); }
});

test('a session without the panel flag switches modes and approves plans exactly as before', async () => {
  const refuse = (mode) => (mode === BYPASS ? 'bypass is not allowed here' : '');
  const { session, queries, sent } = plainSession({}, { refuse });
  try {
    session.ensureQuery();
    await session.handleMessage({ type: 'set_permission_mode', mode: BYPASS });
    assert.deepEqual(sent.at(-1), { type: 'error', message: 'Could not switch permission mode: bypass is not allowed here' });
    assert.equal(session.permissionMode, BYPASS, 'the record it kept before');
    assert.deepEqual(setModeCalls(queries[0]), [BYPASS], 'no second switch');
    assert.deepEqual(modeChanges(sent), []);

    // Without its own bypass opt-in a plan decision for Bypass continues in Default.
    const pending = queries[0].options.canUseTool('ExitPlanMode', { plan: 'p' }, { signal: new AbortController().signal });
    await until(() => controlRequests(sent).length === 1);
    await session.handleMessage({ type: 'control_response', request_id: controlRequests(sent)[0].request_id, response: { behavior: 'allow', planDecision: BYPASS } });
    await pending;
    await until(() => setModeCalls(queries[0]).length === 2);
    assert.deepEqual(setModeCalls(queries[0]), [BYPASS, 'default']);
    assert.equal(session.permissionMode, 'default');
  } finally { session.destroy(); shutdownAllBridges(); }

  // With it (the Assistant at a level that allows bypass), the decision is taken.
  const brain = plainSession({ allowDangerouslySkipPermissions: true });
  try {
    brain.session.ensureQuery();
    const pending = brain.queries[0].options.canUseTool('ExitPlanMode', { plan: 'p' }, { signal: new AbortController().signal });
    await until(() => controlRequests(brain.sent).length === 1);
    await brain.session.handleMessage({ type: 'control_response', request_id: controlRequests(brain.sent)[0].request_id, response: { behavior: 'allow', planDecision: BYPASS } });
    await pending;
    await until(() => setModeCalls(brain.queries[0]).length === 1);
    assert.deepEqual(setModeCalls(brain.queries[0]), [BYPASS]);
  } finally { brain.session.destroy(); shutdownAllBridges(); }
});

// ── The latest statement of the mode wins ──
// A switch that is still on its way (the plan approval's, 50 ms later; a call
// the CLI has not answered) is void once the mode is stated again or the
// process it was meant for is gone.

test('a mode switch sent right after a plan approval is not undone by the approval\'s delayed switch', async () => {
  const conn = await startPanelTurn({ permissionMode: 'plan' });
  try {
    const { pending, requestId } = await planCard(conn);
    conn.client({ type: 'control_response', request_id: requestId, response: { behavior: 'allow', planDecision: BYPASS } });
    assert.equal((await pending).behavior, 'allow');
    // Before the approval's own switch is sent, the user leaves Bypass.
    conn.client({ type: 'set_permission_mode', mode: 'default' });
    await until(() => modeChanges(conn.ws.sent).length >= 1);
    await settle(150);
    assert.deepEqual(setModeCalls(conn.queries[0]), ['default'], 'the approval\'s switch to Bypass is never sent');
    assert.deepEqual(modeChanges(conn.ws.sent), [{ type: 'mode_changed', mode: 'default' }], 'and the tab is never told Bypass');
    // The bridge's own record is Default: a Bypass the CLI reports now is not the tab's.
    conn.queries[0].emit(status(BYPASS));
    await until(() => setModeCalls(conn.queries[0]).length === 2);
    assert.deepEqual(setModeCalls(conn.queries[0]), ['default', 'default']);
  } finally { conn.close(); shutdownAllBridges(); }
});

test('a query that states a mode right after a plan approval makes the approval\'s switch void too', async () => {
  const conn = await startPanelTurn({ permissionMode: 'plan' });
  try {
    const { pending, requestId } = await planCard(conn);
    conn.client({ type: 'control_response', request_id: requestId, response: { behavior: 'allow', planDecision: BYPASS } });
    await pending;
    conn.client({ type: 'query', prompt: 'next', windowId: 'w-bypass', permissionMode: 'default' });
    await until(() => conn.queries[0].pushed.length === 2);
    await settle(150);
    assert.deepEqual(setModeCalls(conn.queries[0]), ['default']);
    assert.deepEqual(modeChanges(conn.ws.sent), []);
  } finally { conn.close(); shutdownAllBridges(); }
});

// A call to the CLI the test answers when it chooses to.
function heldCalls(when) {
  const calls = [];
  return {
    calls,
    hold: (mode) => (when(mode) ? new Promise((resolve, reject) => { calls.push({ mode, resolve, reject }); }) : null),
  };
}

test('a plan approval\'s switch the CLI answers after the mode was stated again assigns and announces nothing', async () => {
  const held = heldCalls(mode => mode === BYPASS);
  const conn = await startPanelTurn({ permissionMode: 'plan' }, {}, held);
  try {
    const { pending, requestId } = await planCard(conn);
    conn.client({ type: 'control_response', request_id: requestId, response: { behavior: 'allow', planDecision: BYPASS } });
    await pending;
    await until(() => held.calls.length === 1); // the approval's switch is with the CLI
    conn.client({ type: 'set_permission_mode', mode: 'default' });
    await until(() => modeChanges(conn.ws.sent).length === 1);
    held.calls[0].resolve();
    await settle();
    assert.deepEqual(modeChanges(conn.ws.sent), [{ type: 'mode_changed', mode: 'default' }], 'the tab is not told Bypass after Default');
    // And the session's record is Default: a Bypass the CLI reports is undone.
    conn.queries[0].emit(status(BYPASS));
    await until(() => setModeCalls(conn.queries[0]).length === 3);
    assert.deepEqual(setModeCalls(conn.queries[0]), [BYPASS, 'default', 'default']);
  } finally { conn.close(); shutdownAllBridges(); }
});

test('a switch to Bypass the CLI answers after a newer statement of the mode announces nothing', async () => {
  const held = heldCalls(mode => mode === BYPASS);
  const { ws, queries, client, close } = await startPanelTurn({ permissionMode: 'default' }, {}, held);
  try {
    queries[0].emit(init('default'));
    client({ type: 'set_permission_mode', mode: BYPASS });
    await until(() => held.calls.length === 1);
    // The next message of the tab states Default (the user left Bypass meanwhile).
    client({ type: 'query', prompt: 'next', windowId: 'w-bypass', sessionId: UUID, permissionMode: 'default' });
    await until(() => queries[0].pushed.length === 2);
    held.calls[0].resolve();
    await settle();
    assert.deepEqual(modeChanges(ws.sent), [], 'a mode_changed to Bypass would put the page back in it');
    assert.deepEqual(setModeCalls(queries[0]), [BYPASS, 'default'], 'the CLI was told Default last');
  } finally { close(); shutdownAllBridges(); }
});

test('a refusal that arrives for a process that was replaced puts no earlier mode back', async () => {
  const held = heldCalls(mode => mode === BYPASS);
  const { ws, queries, client, close } = await startPanelTurn({ permissionMode: 'acceptEdits' }, {}, held);
  try {
    queries[0].emit(init('acceptEdits'));
    await until(() => systemEvents(ws.sent, 'init').length === 1);
    client({ type: 'set_permission_mode', mode: BYPASS });
    await until(() => held.calls.length === 1);
    // The tool policy changes: the next message restarts the process, in the Bypass the tab is in.
    client({ type: 'query', prompt: 'next', windowId: 'w-bypass', sessionId: UUID, permissionMode: BYPASS, toolPolicy: 'read-only' });
    await until(() => queries.length === 2 && queries[1].pushed.length === 1);
    assert.equal(queries[1].options.permissionMode, BYPASS);
    held.calls[0].reject(new Error('the control channel closed'));
    await settle();
    assert.deepEqual(modeChanges(ws.sent), [], 'the old process\'s failure says nothing about this one');
    queries[1].emit(init(BYPASS));
    await until(() => systemEvents(ws.sent, 'init').length === 2);
    assert.equal(systemEvents(ws.sent, 'init')[1].permissionMode, BYPASS, 'the tab is in the Bypass it chose');
    assert.deepEqual(setModeCalls(queries[1]), []);
  } finally { close(); shutdownAllBridges(); }
});

test('after a plan card is answered, the user\'s settings no longer choose the mode of the next process', async () => {
  const { ws, queries, client, close } = await startPanelTurn({ modeFromSettings: true });
  try {
    queries[0].emit(init(BYPASS)); // permissions.defaultMode names Bypass
    await until(() => systemEvents(ws.sent, 'init').length === 1);
    const conn = { ws, queries };
    const { pending, requestId } = await planCard(conn);
    client({ type: 'control_response', request_id: requestId, response: { behavior: 'allow' } }); // a plain approval: Default
    await pending;
    await until(() => modeChanges(ws.sent).some(e => e.mode === 'default'));
    // The turn ends, the process is ended (its session rules are forgotten), and Compact starts the next one.
    queries[0].emit({ type: 'result', subtype: 'success', session_id: UUID, total_cost_usd: 0, usage: {}, result: 'ok' });
    await until(() => ws.sent.some(m => m.type === 'done'));
    client({ type: 'session_request', id: 'r1', what: 'forget_session_rules' });
    await until(() => ws.sent.some(m => m.type === 'session_response' && m.id === 'r1'));
    client({ type: 'compact' });
    await until(() => queries.length === 2);
    assert.equal(queries[1].options.permissionMode, 'default', 'started in the mode the plan card left the tab in');
    queries[1].emit(init(BYPASS));
    await until(() => systemEvents(ws.sent, 'init').length === 2);
    assert.equal(systemEvents(ws.sent, 'init')[1].permissionMode, 'default', 'a Bypass it starts in is not the tab\'s');
    assert.deepEqual(setModeCalls(queries[1]), ['default']);
  } finally { close(); shutdownAllBridges(); }
});

test('without the panel flag, a newer statement of the mode voids a plan approval\'s pending switch, and nothing else changed', async () => {
  // The race itself: plan approved, mode stated again before the 50 ms switch.
  const raced = plainSession({ allowDangerouslySkipPermissions: true, planExitMode: BYPASS });
  try {
    raced.session.ensureQuery();
    const pending = raced.queries[0].options.canUseTool('ExitPlanMode', { plan: 'p' }, { signal: new AbortController().signal });
    await until(() => controlRequests(raced.sent).length === 1);
    await raced.session.handleMessage({ type: 'control_response', request_id: controlRequests(raced.sent)[0].request_id, response: { behavior: 'allow' } });
    await pending;
    await raced.session.handleMessage({ type: 'set_permission_mode', mode: 'default' });
    await settle(150);
    assert.deepEqual(setModeCalls(raced.queries[0]), ['default']);
    assert.deepEqual(modeChanges(raced.sent), [{ type: 'mode_changed', mode: 'default' }]);
    assert.equal(raced.session.permissionMode, 'default');
  } finally { raced.session.destroy(); shutdownAllBridges(); }

  // No race: the approval's switch is sent, assigned and announced as it always was.
  const plain = plainSession({ allowDangerouslySkipPermissions: true, planExitMode: BYPASS });
  try {
    plain.session.ensureQuery();
    const pending = plain.queries[0].options.canUseTool('ExitPlanMode', { plan: 'p' }, { signal: new AbortController().signal });
    await until(() => controlRequests(plain.sent).length === 1);
    await plain.session.handleMessage({ type: 'control_response', request_id: controlRequests(plain.sent)[0].request_id, response: { behavior: 'allow' } });
    await pending;
    await until(() => modeChanges(plain.sent).length === 1);
    assert.deepEqual(setModeCalls(plain.queries[0]), [BYPASS]);
    assert.deepEqual(modeChanges(plain.sent), [{ type: 'mode_changed', mode: BYPASS }]);
    // A switch whose answer is overtaken still announces itself (panel sessions only skip it).
    await plain.session.handleMessage({ type: 'set_permission_mode', mode: 'acceptEdits' });
    assert.deepEqual(modeChanges(plain.sent).at(-1), { type: 'mode_changed', mode: 'acceptEdits' });
    assert.equal('allowDangerouslySkipPermissions' in plain.queries[0].options, true);
    assert.notEqual(plain.session._modeFromSettings, true, 'the settings never choose its mode');
  } finally { plain.session.destroy(); shutdownAllBridges(); }
});

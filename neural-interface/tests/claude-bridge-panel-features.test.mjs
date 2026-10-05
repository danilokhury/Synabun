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

// The bridge's ClaudeSession is shared: the sidepanel, the Assistant brain and
// anything else that constructs one run on the same class. Everything the panel
// gained for SDK parity is opt-in per session and switched on only by
// createClaudeBridge(). These tests pin both halves: what a panel session gets,
// and that a session built any other way keeps the options and events it had.

function scriptedQuery({ prompt, options }) {
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
  q.setPermissionMode = async (mode) => { q.calls.push(['setPermissionMode', mode]); };
  q.setModel = async (model) => { q.calls.push(['setModel', model]); };
  q.applyFlagSettings = async (settings) => { q.calls.push(['applyFlagSettings', settings]); };
  q.supportedCommands = async () => [{ name: 'usage', description: 'Show usage', argumentHint: '' }];
  q.mcpServerStatus = async () => [];
  q.initializationResult = async () => {
    q.calls.push(['initializationResult']);
    return {
      commands: [], agents: [{ name: 'Explore' }], output_style: 'default', available_output_styles: ['default', 'Explanatory'],
      models: [{ value: 'opus', displayName: 'Opus' }], account: { email: 'me@example.com', subscriptionType: 'max' }, fast_mode_state: 'off',
    };
  };
  q.reloadSkills = async () => { q.calls.push(['reloadSkills']); return { skills: [] }; };
  (async () => { for await (const m of prompt) q.pushed.push(m); finish(); })();
  options.abortController?.signal.addEventListener('abort', finish, { once: true });
  return q;
}

function configure() {
  const queries = [];
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(),
    includePartialMessages: false,
    queryFactory: (args) => { const q = scriptedQuery(args); queries.push(q); return q; },
    acquireSessionLock: () => ({ ok: true }),
    heartbeatLock: () => {},
    releaseAllLocks: () => {},
    getSessionCost: () => 0,
    addCost: () => {},
    maybeInjectSkillPrompt: (prompt) => ({ prompt }),
    toCliModelName: (model) => model,
    writePlanFile: () => ({ ok: false }),
  });
  return queries;
}

// A session the way the Assistant brain and the tests build one: no panel flag.
function plainSession(opts = {}) {
  const queries = configure();
  const sent = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (data) => sent.push(JSON.parse(data)) };
  return { session: new ClaudeSession(ws, opts), queries, sent };
}

// A sidepanel connection: the socket createClaudeBridge() serves.
function panelConnection() {
  const queries = configure();
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.bufferedAmount = 0;
  ws.sent = [];
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  ws.ping = () => {};
  ws.terminate = () => {};
  createClaudeBridge(ws);
  const client = (msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)));
  return { ws, queries, client, close: () => { ws.readyState = 3; ws.emit('close'); } };
}

async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 5));
  }
}

// The options a session passed to query() before the parity work, for a caller
// that sets nothing. A key that appears here for a non-panel session is a
// behaviour change for the Assistant.
const BASELINE_OPTION_KEYS = [
  'abortController', 'additionalDirectories', 'canUseTool', 'cwd', 'enableFileCheckpointing',
  'env', 'hooks', 'includePartialMessages', 'permissionMode', 'settingSources', 'stderr', 'systemPrompt',
];

test('the engine hello advertises what the bridge supports', () => {
  const { ws, close } = panelConnection();
  try {
    assert.equal(ws.sent[0].type, 'engine');
    assert.equal(ws.sent[0].engine, 'sdk');
    assert.deepEqual(ws.sent[0].capabilities, [...PANEL_CAPABILITIES]);
    assert.ok(PANEL_CAPABILITIES.includes('capabilities'));
    assert.ok(Object.isFrozen(PANEL_CAPABILITIES));
  } finally { close(); shutdownAllBridges(); }
});

test('a session built without the panel flag keeps the baseline query options', () => {
  const { session, queries } = plainSession();
  try {
    assert.equal(session.panel, false);
    session.ensureQuery();
    const options = queries[0].options;
    assert.deepEqual(Object.keys(options).sort(), BASELINE_OPTION_KEYS);
    assert.equal(options.permissionMode, 'default');
    assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
    assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code' });
    assert.equal(options.enableFileCheckpointing, true);
    assert.deepEqual(Object.keys(options.hooks).sort(), ['PreCompact', 'Stop']);
  } finally { session.destroy(); }
});

test('a sidepanel connection creates panel sessions', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'query', prompt: 'hello', windowId: 'w-panel' });
    await until(() => queries[0]?.pushed.length === 1);
    assert.equal(queries[0].pushed[0].message.content[0].text, 'hello');
    // Every option the baseline has is still there for a panel session.
    for (const key of BASELINE_OPTION_KEYS) assert.ok(key in queries[0].options, `${key} is still passed`);
    assert.ok(ws.sent.length >= 1);
  } finally { close(); shutdownAllBridges(); }
});

const INIT = { type: 'system', subtype: 'init', session_id: 's-info', tools: [], mcp_servers: [], slash_commands: [] };
const systemEvents = (sent, subtype) => sent.filter(p => p.type === 'event' && p.event?.type === 'system' && p.event.subtype === subtype).map(p => p.event);

test('a panel session announces the session info once per query', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'query', prompt: 'hello', windowId: 'w-info' });
    await until(() => queries.length === 1);
    queries[0].emit(INIT);
    await until(() => systemEvents(ws.sent, 'session_info').length === 1);
    const info = systemEvents(ws.sent, 'session_info')[0].info;
    assert.deepEqual(info.account, { email: 'me@example.com', subscriptionType: 'max' });
    assert.deepEqual(info.availableOutputStyles, ['default', 'Explanatory']);
    assert.deepEqual(info.models, [{ value: 'opus', displayName: 'Opus' }]);
    assert.deepEqual(info.agents, [{ name: 'Explore' }]);

    // init repeats at the start of every turn; the info does not.
    queries[0].emit(INIT);
    await until(() => systemEvents(ws.sent, 'commands_list').length === 2);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(systemEvents(ws.sent, 'session_info').length, 1);
    assert.equal(queries[0].calls.filter(c => c[0] === 'initializationResult').length, 1);
  } finally { close(); shutdownAllBridges(); }
});

test('a session without the panel flag sends no session info and ignores panel messages', async () => {
  const { session, queries, sent } = plainSession();
  try {
    session.ensureQuery();
    queries[0].emit(INIT);
    await until(() => systemEvents(sent, 'commands_list').length === 1);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(systemEvents(sent, 'session_info').length, 0);
    assert.equal(queries[0].calls.some(c => c[0] === 'initializationResult'), false);

    const before = sent.length;
    await session.handleMessage({ type: 'reload_skills' });
    assert.equal(queries[0].calls.some(c => c[0] === 'reloadSkills'), false);
    assert.equal(sent.length, before, 'nothing is answered either');
  } finally { session.destroy(); }
});

test('reload_skills refreshes the command list of a panel session', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    client({ type: 'query', prompt: 'hello', windowId: 'w-reload' });
    await until(() => queries.length === 1);
    client({ type: 'reload_skills' });
    await until(() => ws.sent.some(p => p.type === 'reload_result'));
    const result = ws.sent.find(p => p.type === 'reload_result');
    assert.deepEqual(result, { type: 'reload_result', what: 'skills', ok: true, count: 1 });
    assert.equal(queries[0].calls.filter(c => c[0] === 'reloadSkills').length, 1);
    assert.equal(systemEvents(ws.sent, 'commands_list').at(-1).commands[0].name, 'usage');
  } finally { close(); shutdownAllBridges(); }
});

test('reload_skills with no live query says so', async () => {
  const { ws, client, close } = panelConnection();
  try {
    client({ type: 'reload_skills' });
    await until(() => ws.sent.some(p => p.type === 'reload_result'));
    const result = ws.sent.find(p => p.type === 'reload_result');
    assert.equal(result.ok, false);
    assert.match(result.error, /No active session/);
  } finally { close(); shutdownAllBridges(); }
});

// ── K4: permissions, modes, tool policy, elicitation ──

const CONTEXT = {
  suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run:*' }], behavior: 'allow', destination: 'localSettings' }],
  title: 'Claude wants to run npm run build', displayName: 'Run command', description: 'In /repo',
  decisionReason: 'No matching allow rule', blockedPath: '/etc/hosts', mcpServer: { name: 'gh', source: 'user' },
  matchedAskRule: { source: 'userSettings', toolName: 'Bash' }, agentID: 'agent-1', toolUseID: 'toolu_9',
  defaultToNo: true, suppressAlwaysAllowRule: true, requestId: 'req-1',
};
const controlRequests = (sent) => sent.filter(p => p.type === 'control_request');

async function startPanelTurn(extra = {}) {
  const conn = panelConnection();
  conn.client({ type: 'query', prompt: 'go', windowId: 'w-k4', ...extra });
  await until(() => conn.queries.length === 1 && conn.queries[0].pushed.length === 1);
  return conn;
}

test('a panel permission request carries what the CLI said about it', async () => {
  const { ws, queries, client, close } = await startPanelTurn();
  try {
    const pending = queries[0].options.canUseTool('Bash', { command: 'npm run build' }, { ...CONTEXT, signal: new AbortController().signal });
    await until(() => controlRequests(ws.sent).length === 1);
    const { request, request_id } = controlRequests(ws.sent)[0];
    assert.equal(request.title, 'Claude wants to run npm run build');
    assert.equal(request.display_name, 'Run command');
    assert.equal(request.decision_reason, 'No matching allow rule');
    assert.equal(request.blocked_path, '/etc/hosts');
    assert.deepEqual(request.mcp_server, { name: 'gh', source: 'user' });
    assert.equal(request.agent_id, 'agent-1');
    assert.equal(request.tool_use_id, 'toolu_9');
    assert.deepEqual([request.default_to_no, request.suppress_always], [true, true]);
    assert.equal(request.suggestions.length, 1);

    // "Always": the rules go back as updatedPermissions, classified as permanent.
    const rules = [{ ...CONTEXT.suggestions[0], destination: 'session' }];
    client({ type: 'control_response', request_id, response: { subtype: 'success', request_id, response: { behavior: 'allow', updatedPermissions: rules } } });
    assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { command: 'npm run build' }, updatedPermissions: rules, toolUseID: 'toolu_9', decisionClassification: 'user_permanent' });
  } finally { close(); shutdownAllBridges(); }
});

test('a panel deny can stop the turn; a plain allow is classified as for this once', async () => {
  const { ws, queries, client, close } = await startPanelTurn();
  try {
    const signal = new AbortController().signal;
    const first = queries[0].options.canUseTool('Bash', { command: 'a' }, { signal, toolUseID: 'toolu_1' });
    await until(() => controlRequests(ws.sent).length === 1);
    let rid = controlRequests(ws.sent)[0].request_id;
    client({ type: 'control_response', request_id: rid, response: { behavior: 'deny', message: 'not here', interrupt: true } });
    assert.deepEqual(await first, { behavior: 'deny', message: 'not here', interrupt: true, toolUseID: 'toolu_1', decisionClassification: 'user_reject' });

    const second = queries[0].options.canUseTool('Bash', { command: 'b' }, { signal, toolUseID: 'toolu_2' });
    await until(() => controlRequests(ws.sent).length === 2);
    rid = controlRequests(ws.sent)[1].request_id;
    client({ type: 'control_response', request_id: rid, response: { behavior: 'allow' } });
    assert.deepEqual(await second, { behavior: 'allow', updatedInput: { command: 'b' }, toolUseID: 'toolu_2', decisionClassification: 'user_temporary' });
  } finally { close(); shutdownAllBridges(); }
});

test('a session without the panel flag asks and answers exactly as before', async () => {
  const { session, queries, sent } = plainSession();
  try {
    session.ensureQuery();
    const pending = queries[0].options.canUseTool('Bash', { command: 'x' }, { ...CONTEXT, signal: new AbortController().signal });
    await until(() => controlRequests(sent).length === 1);
    const { request, request_id } = controlRequests(sent)[0];
    assert.deepEqual(Object.keys(request).sort(), ['input', 'subtype', 'suggestions', 'tool_name'], 'no extra context keys');
    await session.handleMessage({ type: 'control_response', request_id, response: { behavior: 'deny', message: 'no', interrupt: true } });
    assert.deepEqual(await pending, { behavior: 'deny', message: 'no' }, 'no interrupt, no classification');

    const again = queries[0].options.canUseTool('Bash', { command: 'y' }, { signal: new AbortController().signal, toolUseID: 'toolu_3' });
    await until(() => controlRequests(sent).length === 2);
    await session.handleMessage({ type: 'control_response', request_id: controlRequests(sent)[1].request_id, response: { behavior: 'allow' } });
    assert.deepEqual(await again, { behavior: 'allow', updatedInput: { command: 'y' } });
    assert.equal('onElicitation' in queries[0].options, false);
  } finally { session.destroy(); }
});

test('Don\'t Ask and Auto are accepted from a panel tab only', async () => {
  const { ws, queries, client, close } = await startPanelTurn({ permissionMode: 'dontAsk' });
  try {
    assert.equal(queries[0].options.permissionMode, 'dontAsk');
    client({ type: 'set_permission_mode', mode: 'auto' });
    await until(() => queries[0].calls.some(c => c[0] === 'setPermissionMode' && c[1] === 'auto'));
    assert.ok(ws.sent.some(p => p.type === 'event' && p.event.type === 'mode_changed' && p.event.mode === 'auto'));
  } finally { close(); shutdownAllBridges(); }

  const { session, queries: plainQueries, sent } = plainSession();
  try {
    session.ensureQuery();
    await session.handleMessage({ type: 'set_permission_mode', mode: 'auto' });
    assert.equal(session.permissionMode, 'default');
    assert.equal(plainQueries[0].calls.length, 0);
    assert.equal(sent.some(p => p.event?.type === 'mode_changed'), false);
    session._handleQuery({ prompt: 'x', permissionMode: 'dontAsk', modeFromSettings: true, toolPolicy: 'read-only', features: ['elicitation'] });
    assert.equal(session.permissionMode, 'default', 'the newer modes are not for other callers');
    assert.equal(session.toolPolicy, undefined);
  } finally { session.destroy(); }
});

test('a tab that never picked a mode leaves it to the user\'s settings', async () => {
  const { queries, close } = await startPanelTurn({ modeFromSettings: true });
  try {
    assert.equal('permissionMode' in queries[0].options, false, 'omitted: the CLI reads permissions.defaultMode');
    queries[0].emit({ type: 'system', subtype: 'init', session_id: 's-mode', permissionMode: 'acceptEdits', tools: [], mcp_servers: [], slash_commands: [] });
    await new Promise(r => setTimeout(r, 20));
  } finally { close(); shutdownAllBridges(); }

  // An explicit mode wins, and a plain session always passes one.
  const explicit = await startPanelTurn({ permissionMode: 'acceptEdits', modeFromSettings: true });
  try { assert.equal(explicit.queries[0].options.permissionMode, 'acceptEdits'); } finally { explicit.close(); shutdownAllBridges(); }
  const { session, queries: plainQueries } = plainSession();
  try {
    session._handleQuery({ prompt: 'x', modeFromSettings: true });
    assert.equal(plainQueries[0].options.permissionMode, 'default');
  } finally { session.destroy(); }
});

test('a tool policy removes tools at start, and a change restarts the session with it', async () => {
  const { queries, client, close } = await startPanelTurn({ toolPolicy: 'read-only' });
  try {
    assert.deepEqual(queries[0].options.disallowedTools, ['Edit', 'Write', 'NotebookEdit', 'Bash']);
    client({ type: 'query', prompt: 'again', windowId: 'w-k4', toolPolicy: 'read-only' });
    await until(() => queries[0].pushed.length === 2);
    assert.equal(queries.length, 1, 'the same policy keeps the process');
    client({ type: 'query', prompt: 'now without the web', windowId: 'w-k4', toolPolicy: 'no-web' });
    await until(() => queries.length === 2 && queries[1].pushed.length === 1);
    assert.deepEqual(queries[1].options.disallowedTools, ['WebFetch', 'WebSearch']);
    client({ type: 'query', prompt: 'everything', windowId: 'w-k4', toolPolicy: 'full' });
    await until(() => queries.length === 3 && queries[2].pushed.length === 1);
    assert.equal('disallowedTools' in queries[2].options, false);
  } finally { close(); shutdownAllBridges(); }
});

test('MCP elicitation reaches a panel that can show it, and its answer goes back', async () => {
  const { ws, queries, client, close } = await startPanelTurn({ features: ['elicitation'] });
  try {
    assert.equal(typeof queries[0].options.onElicitation, 'function');
    const ac = new AbortController();
    const pending = queries[0].options.onElicitation({ serverName: 'github', message: 'Which repo?', mode: 'form', requestedSchema: { type: 'object', properties: { repo: { type: 'string' } } } }, { signal: ac.signal, requestId: 'r' });
    await until(() => controlRequests(ws.sent).length === 1);
    const { request, request_id } = controlRequests(ws.sent)[0];
    assert.deepEqual([request.subtype, request.server_name, request.message, request.mode], ['elicitation', 'github', 'Which repo?', 'form']);
    assert.deepEqual(request.requested_schema.properties, { repo: { type: 'string' } });
    client({ type: 'control_response', request_id, response: { subtype: 'success', request_id, response: { action: 'accept', content: { repo: 'o/r' } } } });
    assert.deepEqual(await pending, { action: 'accept', content: { repo: 'o/r' } });

    // A URL elicitation whose turn is interrupted is cancelled, and the card is told.
    const second = queries[0].options.onElicitation({ serverName: 'stripe', message: 'Sign in', mode: 'url', url: 'https://auth.example', elicitationId: 'e1' }, { signal: ac.signal, requestId: 'r2' });
    await until(() => controlRequests(ws.sent).length === 2);
    const urlReq = controlRequests(ws.sent)[1];
    assert.deepEqual([urlReq.request.mode, urlReq.request.url, urlReq.request.elicitation_id], ['url', 'https://auth.example', 'e1']);
    ac.abort();
    assert.deepEqual(await second, { action: 'cancel' });
    assert.ok(ws.sent.some(p => p.type === 'control_cancelled' && p.request_id === urlReq.request_id));

    // A session that ends with a form open answers it too (cancel, not a permission denial).
    const third = queries[0].options.onElicitation({ serverName: 'x', message: 'm' }, { signal: new AbortController().signal, requestId: 'r3' });
    await until(() => controlRequests(ws.sent).length === 3);
    client({ type: 'abort' });
    assert.deepEqual(await third, { action: 'cancel' });
  } finally { close(); shutdownAllBridges(); }
});

test('a panel that did not declare the feature gets no elicitation callback', async () => {
  const { queries, close } = await startPanelTurn();
  try { assert.equal('onElicitation' in queries[0].options, false, 'the CLI declines for it, as before'); } finally { close(); shutdownAllBridges(); }
});

test('question annotations survive for a panel session only', () => {
  const input = { questions: [{ question: 'Which layout?', options: [] }] };
  const answer = { questions: input.questions, answers: { 'Which layout?': 'Grid' }, annotations: { 'Which layout?': { notes: 'dense' } } };
  const { session } = plainSession();
  try { assert.deepEqual(session._normalizeAskInput(input, answer), { questions: input.questions, answers: { 'Which layout?': 'Grid' } }); } finally { session.destroy(); }
  const { session: panel } = plainSession({ panel: true });
  try { assert.deepEqual(panel._normalizeAskInput(input, answer).annotations, { 'Which layout?': { notes: 'dense' } }); } finally { panel.destroy(); }
});

// ── K5: per-tab session settings ──

test('a tab\'s session settings start the query with them; a start-level change restarts it', async () => {
  const session = { maxBudgetUsd: 5, maxTurns: 40, strictMcp: true, systemPromptAppend: 'Be brief.', thinking: 'off', fastMode: true, includeParentDir: false };
  const { queries, client, close } = await startPanelTurn({ session, effort: 'high' });
  try {
    const o = queries[0].options;
    assert.deepEqual([o.maxBudgetUsd, o.maxTurns, o.strictMcpConfig], [5, 40, true]);
    assert.deepEqual(o.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'Be brief.' });
    assert.deepEqual(o.thinking, { type: 'disabled' });
    assert.deepEqual(o.settings, { fastMode: true });
    assert.equal('additionalDirectories' in o, false, 'the parent directory grant was removed');
    assert.equal(o.effort, 'high', 'the typed option for panel sessions');
    assert.equal('extraArgs' in o, false);

    // Same settings: the process stays. A live setting: applied on it.
    client({ type: 'query', prompt: 'two', windowId: 'w-k4', effort: 'high', session: { ...session, outputStyle: 'Explanatory', fastMode: false } });
    await until(() => queries[0].pushed.length === 2);
    assert.equal(queries.length, 1);
    await until(() => queries[0].calls.some(c => c[0] === 'applyFlagSettings'));
    // Off is an explicit false (review R12): null would restore an inherited `fastMode: true`.
    assert.deepEqual(queries[0].calls.find(c => c[0] === 'applyFlagSettings')[1], { fastMode: false, outputStyle: 'Explanatory' });

    // A start-level setting: the session restarts with it.
    client({ type: 'query', prompt: 'three', windowId: 'w-k4', effort: 'high', session: { ...session, maxTurns: 10, outputStyle: 'Explanatory', fastMode: false } });
    await until(() => queries.length === 2 && queries[1].pushed.length === 1);
    assert.equal(queries[1].options.maxTurns, 10);
    assert.deepEqual(queries[1].options.settings, { fastMode: false, outputStyle: 'Explanatory' });
  } finally { close(); shutdownAllBridges(); }
});

test('a panel tab can go back to the default effort, and pick a model after starting on the default one', async () => {
  const { queries, client, close } = await startPanelTurn({ effort: 'high' });
  try {
    client({ type: 'query', prompt: 'two', windowId: 'w-k4', model: 'opus' });
    await until(() => queries[0].pushed.length === 2);
    await until(() => queries[0].calls.some(c => c[0] === 'applyFlagSettings') && queries[0].calls.some(c => c[0] === 'setModel'));
    assert.deepEqual(queries[0].calls.find(c => c[0] === 'applyFlagSettings')[1], { effortLevel: null }, 'no effort sent means the model default');
    assert.deepEqual(queries[0].calls.find(c => c[0] === 'setModel'), ['setModel', 'opus']);
    assert.equal(queries.length, 1, 'neither needs a new process');
  } finally { close(); shutdownAllBridges(); }
});

test('a session without the panel flag ignores session settings and keeps its effort flag', async () => {
  const { session, queries } = plainSession();
  try {
    session._handleQuery({ prompt: 'x', effort: 'high', session: { maxTurns: 5, fastMode: true, thinking: 'off' } });
    await until(() => queries.length === 1);
    const o = queries[0].options;
    assert.deepEqual(Object.keys(o).sort(), [...BASELINE_OPTION_KEYS, 'extraArgs'].sort());
    assert.deepEqual(o.extraArgs, { effort: 'high' });
    // No effort on a later message leaves the level alone, as before.
    session._handleQuery({ prompt: 'y' });
    await until(() => queries[0].pushed.length === 2);
    assert.equal(session.effort, 'high');
    assert.equal(queries[0].calls.length, 0);
  } finally { session.destroy(); }
});

test('reload_plugins refreshes commands, MCP status and the plugin list of a panel session', async () => {
  const { ws, queries, client, close } = await startPanelTurn();
  try {
    queries[0].reloadPlugins = async () => ({
      commands: [{ name: 'deploy', description: 'd', argumentHint: '' }], agents: [{ name: 'Plan', description: 'p' }],
      plugins: [{ name: 'acme', path: '/p', version: '1.0.0' }], mcpServers: [{ name: 'SynaBun', status: 'connected' }], error_count: 1,
    });
    client({ type: 'reload_plugins' });
    await until(() => ws.sent.some(p => p.type === 'reload_result'));
    assert.deepEqual(ws.sent.find(p => p.type === 'reload_result'), { type: 'reload_result', what: 'plugins', ok: true, count: 1, errorCount: 1 });
    assert.deepEqual(systemEvents(ws.sent, 'plugins_list')[0].plugins, [{ name: 'acme', version: '1.0.0', source: '' }]);
    assert.equal(systemEvents(ws.sent, 'commands_list').at(-1).commands[0].name, 'deploy');
  } finally { close(); shutdownAllBridges(); }
});

// ── K6: message streams, task control, provenance ──

test('a panel session turns on the message streams it renders; summaries stay opt-in', async () => {
  const { queries, close } = await startPanelTurn({ session: {}, features: ['elicitation', 'task_stop'] });
  try {
    const o = queries[0].options;
    assert.deepEqual([o.includeHookEvents, o.promptSuggestions, o.forwardSubagentText, o.perTaskStopAffordance], [true, true, true, true]);
    assert.equal('agentProgressSummaries' in o, false);
  } finally { close(); shutdownAllBridges(); }
  const off = await startPanelTurn({ session: { hookEvents: false, promptSuggestions: false, subagentText: false, agentSummaries: true } });
  try {
    const o = off.queries[0].options;
    assert.deepEqual(['includeHookEvents' in o, 'promptSuggestions' in o, 'forwardSubagentText' in o, o.agentProgressSummaries], [false, false, false, true]);
    assert.equal('perTaskStopAffordance' in o, false, 'only with a panel that has the stop control');
  } finally { off.close(); shutdownAllBridges(); }
  // A panel that sends no session object (an un-reloaded page) gets none of them.
  const old = await startPanelTurn();
  try { assert.equal('includeHookEvents' in old.queries[0].options, false); } finally { old.close(); shutdownAllBridges(); }
});

test('only a prompt marked as typed is stamped as human input', async () => {
  const { queries, client, close } = await startPanelTurn({ typed: true });
  try {
    assert.deepEqual(queries[0].pushed[0].origin, { kind: 'human' });
    client({ type: 'query', prompt: 'from the queue', windowId: 'w-k4' });
    await until(() => queries[0].pushed.length === 2);
    assert.equal('origin' in queries[0].pushed[1], false);
  } finally { close(); shutdownAllBridges(); }
  const { session, queries: plainQueries } = plainSession();
  try {
    session._handleQuery({ prompt: 'x', typed: true });
    await until(() => plainQueries[0]?.pushed.length === 1);
    assert.equal('origin' in plainQueries[0].pushed[0], false, 'other callers send what they always sent');
  } finally { session.destroy(); }
});

test('one background task can be stopped, and foreground work sent to the background', async () => {
  const { ws, queries, client, close } = await startPanelTurn();
  try {
    queries[0].stopTask = async (id) => { queries[0].calls.push(['stopTask', id]); };
    queries[0].backgroundTasks = async (id) => { queries[0].calls.push(['backgroundTasks', id]); return id !== 'nope'; };
    const results = () => ws.sent.filter(p => p.type === 'task_control_result');
    client({ type: 'stop_task', taskId: 't-7' });
    await until(() => results().length === 1);
    assert.deepEqual(results()[0], { type: 'task_control_result', action: 'stop_task', ok: true, taskId: 't-7' });
    client({ type: 'background_tasks', toolUseId: 'toolu_1' });
    await until(() => results().length === 2);
    assert.deepEqual(results()[1], { type: 'task_control_result', action: 'background_tasks', ok: true });
    client({ type: 'background_tasks', toolUseId: 'nope' });
    await until(() => results().length === 3);
    assert.equal(results()[2].ok, false);
    client({ type: 'stop_task' });
    await until(() => results().length === 4);
    assert.deepEqual([results()[3].ok, results()[3].error], [false, 'Missing task id']);
    assert.deepEqual(queries[0].calls.filter(c => c[0] === 'stopTask'), [['stopTask', 't-7']]);
  } finally { close(); shutdownAllBridges(); }

  const { session, queries: plainQueries, sent } = plainSession();
  try {
    session.ensureQuery();
    plainQueries[0].stopTask = async () => { throw new Error('must not be called'); };
    await session.handleMessage({ type: 'stop_task', taskId: 't' });
    assert.equal(sent.some(p => p.type === 'task_control_result'), false);
  } finally { session.destroy(); }
});

test('the wakeups scheduled for a panel session reach the panel when they change', async () => {
  const { ws, queries, close } = await startPanelTurn();
  try {
    const stop = queries[0].options.hooks.Stop[0].hooks[0];
    await stop({ session_crons: [{ id: 'c1', schedule: 'in 20m', recurring: false, prompt: 'check CI' }] });
    await stop({ session_crons: [{ id: 'c1', schedule: 'in 20m', recurring: false, prompt: 'check CI' }] });
    assert.equal(systemEvents(ws.sent, 'session_crons').length, 1, 'only on a change');
    assert.deepEqual(systemEvents(ws.sent, 'session_crons')[0].crons, [{ id: 'c1', schedule: 'in 20m', recurring: false, prompt: 'check CI' }]);
    await stop({ session_crons: [] });
    assert.deepEqual(systemEvents(ws.sent, 'session_crons')[1].crons, []);
  } finally { close(); shutdownAllBridges(); }
  const { session, queries: plainQueries, sent } = plainSession();
  try {
    session.ensureQuery();
    await plainQueries[0].options.hooks.Stop[0].hooks[0]({ session_crons: [{ id: 'c', schedule: 's', recurring: true, prompt: 'p' }] });
    assert.equal(session._sessionCrons.length, 1, 'the reaper still knows');
    assert.equal(systemEvents(sent, 'session_crons').length, 0, 'but no new event for other callers');
  } finally { session.destroy(); }
});

test('a session the CLI reports idle while a turn is still counted open is closed, for panel sessions', async () => {
  const { ws, queries, client, close } = await startPanelTurn();
  try {
    // Two prompts the CLI merged into one turn: one result, and nothing more is coming.
    client({ type: 'query', prompt: 'second', windowId: 'w-k4' });
    await until(() => queries[0].pushed.length === 2);
    await new Promise(r => setTimeout(r, 5));
    queries[0].emit({ type: 'result', subtype: 'success', session_id: 's-idle', total_cost_usd: 0, usage: {}, modelUsage: {} });
    await until(() => ws.sent.filter(p => p.type === 'done').length === 1);
    queries[0].emit({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
    await until(() => ws.sent.filter(p => p.type === 'done').length === 2, 4000);
    assert.deepEqual(ws.sent.filter(p => p.type === 'done').map(p => p.code), [0, 0]);
  } finally { close(); shutdownAllBridges(); }
});

// ── K7: session requests ──

test('a panel tab can ask its live session; any other caller cannot', async () => {
  const { ws, queries, client, close } = await startPanelTurn();
  try {
    queries[0].getContextUsage = async () => ({ totalTokens: 5000, maxTokens: 200000, categories: [], model: 'opus' });
    queries[0].mcpServerStatus = async () => [{ name: 'SynaBun', status: 'connected', tools: [{ name: 'recall' }] }];
    queries[0].toggleMcpServer = async (name, enabled) => { queries[0].calls.push(['toggleMcpServer', name, enabled]); };
    const responses = () => ws.sent.filter(p => p.type === 'session_response');
    client({ type: 'session_request', id: 'r1', what: 'context_usage', args: {} });
    await until(() => responses().length === 1);
    assert.deepEqual([responses()[0].id, responses()[0].ok, responses()[0].data.totalTokens], ['r1', true, 5000]);
    client({ type: 'session_request', id: 'r2', what: 'mcp_toggle', args: { serverName: 'stripe', enabled: false } });
    await until(() => responses().length === 2);
    assert.equal(responses()[1].data.servers[0].toolCount, 1);
    assert.deepEqual(queries[0].calls.find(c => c[0] === 'toggleMcpServer'), ['toggleMcpServer', 'stripe', false]);
    assert.equal(systemEvents(ws.sent, 'mcp_status').at(-1).servers[0].name, 'SynaBun', 'the statusline follows');
    client({ type: 'session_request', id: 'r3', what: 'usage' });
    await until(() => responses().length === 3);
    assert.deepEqual([responses()[2].ok, responses()[2].error], [false, 'Not supported by this Claude Code version']);
    client({ type: 'session_request', id: 'r4', what: 'something_else' });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(responses().length, 3, 'an unknown request is not answered');
  } finally { close(); shutdownAllBridges(); }

  const { session, queries: plainQueries, sent } = plainSession();
  try {
    session.ensureQuery();
    plainQueries[0].getContextUsage = async () => { throw new Error('must not be called'); };
    await session.handleMessage({ type: 'session_request', id: 'x', what: 'context_usage' });
    assert.equal(sent.some(p => p.type === 'session_response'), false);
  } finally { session.destroy(); }
});

test('a rewind reports what it changed to a panel session, and nothing new to others', async () => {
  const rewound = { canRewind: true, filesChanged: ['/a', '/b'], insertions: 3, deletions: 1 };
  const { ws, queries, client, close } = await startPanelTurn();
  try {
    queries[0].rewindFiles = async () => rewound;
    client({ type: 'rewind', userMessageUuid: 'u1' });
    await until(() => ws.sent.some(p => p.type === 'rewind_result'));
    assert.deepEqual(ws.sent.find(p => p.type === 'rewind_result'), { type: 'rewind_result', ok: true, userMessageUuid: 'u1', fileCount: 2, insertions: 3, deletions: 1, skippedLinks: 0 });
  } finally { close(); shutdownAllBridges(); }
  const { session, queries: plainQueries, sent } = plainSession();
  try {
    session.ensureQuery();
    plainQueries[0].rewindFiles = async () => rewound;
    await session.handleMessage({ type: 'rewind', userMessageUuid: 'u1' });
    assert.deepEqual(sent.find(p => p.type === 'rewind_result'), { type: 'rewind_result', ok: true, userMessageUuid: 'u1' });
  } finally { session.destroy(); }
});

// ── K8: titles, conversation rewind, cache cost ──

import { isSessionLive } from '../lib/claude-agent-bridge.js';

test('a new panel session takes the title the user gave the tab; a resumed one does not', async () => {
  const fresh = await startPanelTurn({ title: '  Fix the tests  ' });
  try { assert.equal(fresh.queries[0].options.title, 'Fix the tests'); } finally { fresh.close(); shutdownAllBridges(); }
  const resumed = await startPanelTurn({ title: 'Ignored', sessionId: 'existing-session' });
  try {
    assert.equal('title' in resumed.queries[0].options, false);
    assert.equal(resumed.queries[0].options.resume, 'existing-session');
    assert.equal(isSessionLive('existing-session'), true);
    assert.equal(isSessionLive('some-other-session'), false);
  } finally { resumed.close(); shutdownAllBridges(); }
  assert.equal(isSessionLive('existing-session'), false);
});

test('a conversation rewind restores the files, then restarts the session at the chosen entry', async () => {
  const { ws, queries, client, close } = await startPanelTurn({ sessionId: 'sess-rewind' });
  try {
    queries[0].rewindFiles = async (uuid) => { queries[0].calls.push(['rewindFiles', uuid]); return { canRewind: true, filesChanged: ['/a'], insertions: 1, deletions: 2 }; };
    const result = () => ws.sent.find(p => p.type === 'rewind_conversation_result');
    // Not while a turn runs.
    client({ type: 'rewind_conversation', messageUuid: 'entry-9', userMessageUuid: 'prompt-10' });
    await until(() => !!result());
    assert.deepEqual([result().ok, result().error], [false, 'Claude is still working. Stop the turn first.']);
    ws.sent.length = 0;
    queries[0].emit({ type: 'result', subtype: 'success', session_id: 'sess-rewind', total_cost_usd: 0, usage: {}, modelUsage: {}, queued_turn_count: 0 });
    await until(() => ws.sent.some(p => p.type === 'done'));

    client({ type: 'rewind_conversation', messageUuid: 'entry-9', userMessageUuid: 'prompt-10' });
    await until(() => !!result());
    assert.deepEqual(result(), { type: 'rewind_conversation_result', ok: true, messageUuid: 'entry-9', userMessageUuid: 'prompt-10', fileCount: 1, insertions: 1, deletions: 2 });
    assert.deepEqual(queries[0].calls.find(c => c[0] === 'rewindFiles'), ['rewindFiles', 'prompt-10']);
    assert.equal(queries.length, 2, 'the session restarted');
    assert.deepEqual([queries[1].options.resume, queries[1].options.resumeSessionAt], ['sess-rewind', 'entry-9']);

    // The truncation is asked for once: the next start is a plain resume.
    client({ type: 'query', prompt: 'again', windowId: 'w-k4', sessionId: 'sess-rewind', toolPolicy: 'no-web' });
    await until(() => queries.length === 3);
    assert.equal('resumeSessionAt' in queries[2].options, false);
  } finally { close(); shutdownAllBridges(); }
});

test('resuming on an expired prompt cache tells a panel session what re-caching costs', async () => {
  const { ws, queries, close } = await startPanelTurn();
  try {
    const start = queries[0].options.hooks.SessionStart[0].hooks[0];
    await start({ source: 'resume', prompt_cache_likely_expired: false, estimated_cache_write_usd: 0.4 });
    assert.equal(systemEvents(ws.sent, 'cache_cost').length, 0);
    await start({ source: 'resume', prompt_cache_likely_expired: true, estimated_cache_write_usd: 0.42, seconds_since_last_response: 7200 });
    assert.deepEqual(systemEvents(ws.sent, 'cache_cost')[0].estimated_cache_write_usd, 0.42);
  } finally { close(); shutdownAllBridges(); }
  const { session, queries: plainQueries } = plainSession();
  try {
    session.ensureQuery();
    assert.equal('SessionStart' in plainQueries[0].options.hooks, false, 'no extra hook for other callers');
  } finally { session.destroy(); }
});

// ── K9: accounts ──

import { panelCapabilities } from '../lib/claude-agent-bridge.js';

function configureWithAccounts() {
  const queries = [];
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(), includePartialMessages: false,
    queryFactory: (args) => { const q = scriptedQuery(args); queries.push(q); return q; },
    acquireSessionLock: () => ({ ok: true }), heartbeatLock: () => {}, releaseAllLocks: () => {},
    getSessionCost: () => 0, addCost: () => {}, maybeInjectSkillPrompt: (prompt) => ({ prompt }),
    toCliModelName: (model) => model, writePlanFile: () => ({ ok: false }),
    claudeAccountEnv: (id) => (id === 'work' ? { CLAUDE_CONFIG_DIR: '/home/me/.claude-accounts/work' } : {}),
  });
  return queries;
}

test('a panel tab can run under another Claude account; the default account changes nothing', async () => {
  const queries = configureWithAccounts();
  assert.ok(panelCapabilities().includes('accounts'), 'advertised only when the host wired accounts in');
  const ws = new EventEmitter();
  Object.assign(ws, { readyState: 1, bufferedAmount: 0, sent: [], ping() {}, terminate() {} });
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  createClaudeBridge(ws);
  const client = (msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)));
  try {
    assert.ok(ws.sent[0].capabilities.includes('accounts'));
    client({ type: 'query', prompt: 'hi', windowId: 'w-acc', accountId: 'default' });
    await until(() => queries[0]?.pushed.length === 1);
    assert.equal('CLAUDE_CONFIG_DIR' in queries[0].options.env, false);
    // Another account: a different process environment, so the session restarts.
    client({ type: 'query', prompt: 'as work', windowId: 'w-acc', accountId: 'work' });
    await until(() => queries.length === 2 && queries[1].pushed.length === 1);
    assert.equal(queries[1].options.env.CLAUDE_CONFIG_DIR, '/home/me/.claude-accounts/work');
    // An id that is not a plain name, or an account that is not set up, is
    // refused (review R08): it used to run under the default identity.
    client({ type: 'query', prompt: 'odd', windowId: 'w-acc', accountId: '../../etc' });
    await until(() => ws.sent.some(m => m.type === 'error' && m.code === 'account_unavailable'));
    assert.equal(queries.length, 2);
  } finally { ws.readyState = 3; ws.emit('close'); shutdownAllBridges(); }

  // Any other caller: the account of a message is ignored.
  const sent = [];
  const session = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send: (d) => sent.push(JSON.parse(d)) }, {});
  try {
    session._handleQuery({ prompt: 'x', accountId: 'work' });
    await until(() => queries.at(-1)?.pushed.length === 1);
    assert.equal('CLAUDE_CONFIG_DIR' in queries.at(-1).options.env, false);
  } finally { session.destroy(); configure(); }
  assert.equal(panelCapabilities().includes('accounts'), false);
});

// ── K9: warm start ──

function configureWithWarm() {
  const queries = [];
  const warms = [];
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(), includePartialMessages: false,
    queryFactory: (args) => { const q = scriptedQuery(args); q.cold = true; queries.push(q); return q; },
    // startup(): the process exists; query(prompt) binds the input to it.
    startupFactory: async ({ options }) => {
      const handle = { options, closed: false, close() { handle.closed = true; }, query(prompt) { const q = scriptedQuery({ prompt, options }); q.warm = true; queries.push(q); return q; } };
      warms.push(handle);
      return handle;
    },
    acquireSessionLock: () => ({ ok: true }), heartbeatLock: () => {}, releaseAllLocks: () => {},
    getSessionCost: () => 0, addCost: () => {}, maybeInjectSkillPrompt: (prompt) => ({ prompt }),
    toCliModelName: (model) => model, writePlanFile: () => ({ ok: false }),
  });
  const ws = new EventEmitter();
  Object.assign(ws, { readyState: 1, bufferedAmount: 0, sent: [], ping() {}, terminate() {} });
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  createClaudeBridge(ws);
  return { ws, queries, warms, client: (msg) => ws.emit('message', Buffer.from(JSON.stringify(msg))), close: () => { ws.readyState = 3; ws.emit('close'); shutdownAllBridges(); configure(); } };
}

test('a warm start runs the process ahead of the first message, which then adopts it', async () => {
  const { ws, queries, warms, client, close } = configureWithWarm();
  try {
    client({ type: 'warm', windowId: 'w-warm', model: 'opus', session: { maxTurns: 9 } });
    await until(() => warms.length === 1);
    assert.equal(warms[0].options.maxTurns, 9, 'started with the tab\'s configuration');
    assert.equal(queries.length, 0, 'no turn yet');
    assert.equal(ws.sent.some(p => p.type === 'error'), false, 'a warm start has no prompt and that is not an error');
    client({ type: 'warm', windowId: 'w-warm', model: 'opus', session: { maxTurns: 9 } });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(warms.length, 1, 'only one warm process per session');

    client({ type: 'query', prompt: 'hello', windowId: 'w-warm', model: 'opus', session: { maxTurns: 9 } });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    assert.equal(queries[0].warm, true, 'the message went to the warm process');
    assert.equal(warms[0].closed, false);
    assert.equal(queries[0].pushed[0].message.content[0].text, 'hello');
  } finally { close(); }
});

test('a warm process started for another configuration is closed, not used', async () => {
  const { queries, warms, client, close } = configureWithWarm();
  try {
    client({ type: 'warm', windowId: 'w-warm2', model: 'opus' });
    await until(() => warms.length === 1);
    client({ type: 'query', prompt: 'hello', windowId: 'w-warm2', model: 'haiku' });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    assert.equal(queries[0].cold, true);
    assert.equal(queries[0].options.model, 'haiku');
    assert.equal(warms[0].closed, true);
  } finally { close(); }
});

test('a tab that closes takes its warm process with it; other callers cannot warm', async () => {
  const { warms, client, close } = configureWithWarm();
  client({ type: 'warm', windowId: 'w-warm3' });
  await until(() => warms.length === 1);
  close();
  assert.equal(warms[0].closed, true);

  const { session, queries } = plainSession();
  try {
    await session.handleMessage({ type: 'warm', windowId: 'w' });
    assert.equal(queries.length, 0);
    assert.equal(session._warm, undefined);
  } finally { session.destroy(); }
});

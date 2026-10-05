// Review 1 of the Claude panel parity build: the bridge-side findings
// (R03 capability, R05, R07, R08, R12), each failing without its fix, plus the
// proof that a session built without the panel flag is untouched by them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ClaudeSession, PANEL_CAPABILITIES, configureClaudeBridge, createClaudeBridge, shutdownAllBridges, panelCapabilities } from '../lib/claude-agent-bridge.js';
import { normalizePanelSession, applyPanelSessionOptions, liveSettingsPatch } from '../lib/claude-panel-session.js';

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
  q.setPermissionMode = async () => {};
  q.setModel = async () => {};
  q.applyFlagSettings = async (settings) => { q.calls.push(['applyFlagSettings', settings]); };
  q.supportedCommands = async () => [];
  q.mcpServerStatus = async () => [];
  q.initializationResult = async () => ({ commands: [], agents: [], models: [] });
  (async () => { for await (const m of prompt) q.pushed.push(m); finish(); })();
  options.abortController?.signal.addEventListener('abort', finish, { once: true });
  return q;
}

const ACCOUNTS = { work: '/home/me/.claude-accounts/work' };

function configure(extra = {}) {
  const queries = [];
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(), includePartialMessages: false,
    queryFactory: (args) => { const q = scriptedQuery(args); queries.push(q); return q; },
    acquireSessionLock: () => ({ ok: true }), heartbeatLock: () => {}, releaseAllLocks: () => {},
    getSessionCost: () => 0, addCost: () => {}, maybeInjectSkillPrompt: (prompt) => ({ prompt }),
    toCliModelName: (model) => model, writePlanFile: () => ({ ok: false }),
    ...extra,
  });
  return queries;
}
const withAccounts = { claudeAccountEnv: (id) => (ACCOUNTS[id] ? { CLAUDE_CONFIG_DIR: ACCOUNTS[id] } : {}) };

function panelConnection(extra = {}) {
  const queries = configure(extra);
  const ws = new EventEmitter();
  Object.assign(ws, { readyState: 1, bufferedAmount: 0, sent: [], ping() {}, terminate() {} });
  ws.send = (data) => ws.sent.push(JSON.parse(data));
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
const settle = (ms = 40) => new Promise(r => setTimeout(r, ms));
const errors = (sent) => sent.filter(m => m.type === 'error');
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

// ── R03 ──

test('R03: session_ops is advertised only by a host that serves the session routes', () => {
  configure();
  assert.equal(panelCapabilities().includes('session_ops'), false);
  assert.equal(PANEL_CAPABILITIES.includes('session_ops'), false, 'not part of the static list: it depends on the host');
  configure({ sessionOps: true });
  assert.equal(panelCapabilities().includes('session_ops'), true);
  const { ws, close } = panelConnection({ sessionOps: true });
  try { assert.ok(ws.sent[0].capabilities.includes('session_ops')); } finally { close(); shutdownAllBridges(); }
});

// ── R05 ──

test('R05: a reattach hands back the background tasks and the scheduled wakeups in full', async () => {
  const queries = configure();
  const session = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send: () => {} }, { panel: true });
  try {
    session.windowId = 'w1';
    session._handleQuery({ prompt: 'go' });
    await until(() => queries[0]?.pushed.length === 1);
    queries[0].emit({ type: 'system', subtype: 'init', session_id: 's1' });
    queries[0].emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', task_type: 'local_agent', description: 'Explore the repo' }] });
    await queries[0].options.hooks.Stop[0].hooks[0]({ session_crons: [{ id: 'c1', schedule: 'in 20m', recurring: false, prompt: 'check CI', secret: 'x' }] });
    await until(() => session._bgTasks.size === 1);
    assert.equal(session.detach(), true);
    const sent = [];
    session.reattach({ readyState: 1, bufferedAmount: 0, send: (data) => sent.push(JSON.parse(data)) });
    await until(() => sent.length >= 1);
    assert.equal(sent[0].type, 'reattach_result');
    assert.deepEqual(sent[0].backgroundTasks, [{ task_id: 't1', task_type: 'local_agent', description: 'Explore the repo', ambient: false }]);
    assert.deepEqual(sent[0].sessionCronList, [{ id: 'c1', schedule: 'in 20m', recurring: false, prompt: 'check CI' }], 'the details, not only a count');
    assert.equal(sent[0].sessionCrons, 1);
  } finally { session.destroy(); }

  // Any other caller: the reattach result is what it was.
  const plainQueries = configure();
  const plain = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send: () => {} }, {});
  try {
    plain.windowId = 'w2';
    plain._pushUserText('go');
    plainQueries[0].emit({ type: 'system', subtype: 'init', session_id: 's2' });
    await plainQueries[0].options.hooks.Stop[0].hooks[0]({ session_crons: [{ id: 'c', schedule: 's', recurring: true, prompt: 'p' }] });
    await until(() => plain.sessionId === 's2');
    plain.detach();
    const sent = [];
    plain.reattach({ readyState: 1, bufferedAmount: 0, send: (data) => sent.push(JSON.parse(data)) });
    await until(() => sent.length >= 1);
    assert.deepEqual(Object.keys(sent[0]).sort(), ['backgroundTasks', 'ok', 'running', 'sessionId', 'type']);
  } finally { plain.destroy(); }
});

// ── R07 ──

test('R07: an account change with an unchanged tool policy still restarts the session', async () => {
  const { ws, queries, client, close } = panelConnection(withAccounts);
  try {
    // A normal panel query carries both fields, every time.
    client({ type: 'query', prompt: 'hi', windowId: 'w-r7', accountId: 'default', toolPolicy: 'full', session: {} });
    await until(() => queries[0]?.pushed.length === 1);
    assert.equal('CLAUDE_CONFIG_DIR' in queries[0].options.env, false);
    // No conversation yet (no init): the tab picks another account before its first reply.
    client({ type: 'query', prompt: 'as work', windowId: 'w-r7', accountId: 'work', toolPolicy: 'full', session: {} });
    await until(() => queries.length === 2 && queries[1].pushed.length === 1);
    assert.equal(queries[1].options.env.CLAUDE_CONFIG_DIR, ACCOUNTS.work, 'the new process runs under the new account');
    assert.equal(errors(ws.sent).length, 0);
  } finally { close(); shutdownAllBridges(); }
});

test('R07: a conversation keeps the account it started under', async () => {
  const { ws, queries, client, close } = panelConnection(withAccounts);
  try {
    client({ type: 'query', prompt: 'hi', windowId: 'w-r7b', accountId: 'default', toolPolicy: 'full' });
    await until(() => queries[0]?.pushed.length === 1);
    queries[0].emit({ type: 'system', subtype: 'init', session_id: UUID });
    await until(() => ws.sent.some(m => m.type === 'event' && m.event?.subtype === 'init'));
    client({ type: 'query', prompt: 'switch', windowId: 'w-r7b', sessionId: UUID, accountId: 'work', toolPolicy: 'full' });
    await until(() => errors(ws.sent).length === 1);
    assert.equal(errors(ws.sent)[0].code, 'account_change_refused');
    assert.match(errors(ws.sent)[0].message, /belongs to the account it started under/);
    await settle();
    assert.equal(queries.length, 1, 'no restart under another identity');
    assert.equal(queries[0].pushed.length, 1, 'and the prompt was not sent');
    // The same conversation under its own account keeps working.
    client({ type: 'query', prompt: 'again', windowId: 'w-r7b', sessionId: UUID, accountId: 'default', toolPolicy: 'full' });
    await until(() => queries[0].pushed.length === 2);
    // A new chat in the same tab may start under another account.
    client({ type: 'query', prompt: 'fresh', windowId: 'w-r7b', accountId: 'work', toolPolicy: 'full' });
    await until(() => queries.length === 2 && queries[1].pushed.length === 1);
    assert.equal(queries[1].options.env.CLAUDE_CONFIG_DIR, ACCOUNTS.work);
  } finally { close(); shutdownAllBridges(); }
});

// ── R08 ──

test('R08: an account that is no longer set up is an error, never the default identity', async () => {
  const { ws, queries, client, close } = panelConnection(withAccounts);
  try {
    client({ type: 'query', prompt: 'hi', windowId: 'w-r8', accountId: 'removed-profile', toolPolicy: 'full' });
    await until(() => errors(ws.sent).length === 1);
    assert.equal(errors(ws.sent)[0].code, 'account_unavailable');
    assert.match(errors(ws.sent)[0].message, /no longer set up/);
    await settle();
    assert.equal(queries.length, 0, 'nothing ran under the ambient account');
    // An id that is not a plain name is refused the same way.
    client({ type: 'query', prompt: 'odd', windowId: 'w-r8', accountId: '../../etc' });
    await until(() => errors(ws.sent).length === 2);
    assert.equal(errors(ws.sent)[1].code, 'account_unavailable');
    assert.equal(queries.length, 0);
    // A warm start for it is dropped without a process.
    client({ type: 'warm', windowId: 'w-r8', accountId: 'removed-profile' });
    await settle();
    assert.equal(queries.length, 0);
    // The default account, and a known one, run.
    client({ type: 'query', prompt: 'ok', windowId: 'w-r8', accountId: 'default' });
    await until(() => queries.length === 1 && queries[0].pushed.length === 1);
    assert.equal('CLAUDE_CONFIG_DIR' in queries[0].options.env, false);
  } finally { close(); shutdownAllBridges(); }
});

test('R08: a registry that throws is an unavailable account too', async () => {
  const { ws, queries, client, close } = panelConnection({ claudeAccountEnv: () => { throw new Error('registry unreadable'); } });
  try {
    client({ type: 'query', prompt: 'hi', windowId: 'w-r8b', accountId: 'work' });
    await until(() => errors(ws.sent).length === 1);
    assert.equal(errors(ws.sent)[0].code, 'account_unavailable');
    assert.equal(queries.length, 0);
  } finally { close(); shutdownAllBridges(); }
});

test('R07/R08: a session without the panel flag ignores accounts exactly as before', async () => {
  const queries = configure(withAccounts);
  const sent = [];
  const session = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send: (d) => sent.push(JSON.parse(d)) }, {});
  try {
    session._handleQuery({ prompt: 'x', accountId: 'removed-profile', toolPolicy: 'read-only' });
    await until(() => queries[0]?.pushed.length === 1);
    assert.equal('CLAUDE_CONFIG_DIR' in queries[0].options.env, false);
    assert.equal(errors(sent).length, 0);
    assert.equal('disallowedTools' in queries[0].options, false);
    assert.equal('settings' in queries[0].options, false);
  } finally { session.destroy(); }
});

// ── R12 ──

test('R12: fast mode Off is an explicit false, at start and on a live session', async () => {
  const options = {};
  applyPanelSessionOptions(options, normalizePanelSession({}), {});
  assert.deepEqual(options.settings, { fastMode: false }, 'Off overrides fastMode:true in the user settings at start');
  const on = {};
  applyPanelSessionOptions(on, normalizePanelSession({ fastMode: true, outputStyle: 'Explanatory' }), {});
  assert.deepEqual(on.settings, { fastMode: true, outputStyle: 'Explanatory' });
  const none = {};
  applyPanelSessionOptions(none, null, {});
  assert.equal('settings' in none, false, 'a query that sent no session settings gets no overlay');

  const off = { fastMode: false, outputStyle: '', agent: '' };
  assert.deepEqual(liveSettingsPatch({ ...off, fastMode: true }, off), { fastMode: false }, 'null would restore the inherited value');
  assert.deepEqual(liveSettingsPatch(off, { ...off, fastMode: true }), { fastMode: true });
  assert.equal(liveSettingsPatch(off, off), null);

  const { queries, client, close } = panelConnection();
  try {
    client({ type: 'query', prompt: 'one', windowId: 'w-r12', session: { fastMode: true } });
    await until(() => queries[0]?.pushed.length === 1);
    assert.deepEqual(queries[0].options.settings, { fastMode: true });
    client({ type: 'query', prompt: 'two', windowId: 'w-r12', session: { fastMode: false } });
    await until(() => queries[0].pushed.length === 2);
    assert.deepEqual(queries[0].calls.find(c => c[0] === 'applyFlagSettings')[1], { fastMode: false });
  } finally { close(); shutdownAllBridges(); }
});

// ── R06 ──

test('R06: a conversation rewind resumes at the entry the transcript says the prompt follows', async () => {
  const asked = [];
  let answer = 'carrier-uuid';
  const { ws, queries, client, close } = panelConnection({ transcriptParentOf: async (q) => { asked.push(q); if (answer instanceof Error) throw answer; return answer; } });
  const results = () => ws.sent.filter(p => p.type === 'rewind_conversation_result');
  try {
    client({ type: 'query', prompt: 'go', windowId: 'w-r6', cwd: process.cwd() });
    await until(() => queries[0]?.pushed.length === 1);
    queries[0].emit({ type: 'system', subtype: 'init', session_id: UUID });
    queries[0].emit({ type: 'result', subtype: 'success', session_id: UUID, total_cost_usd: 0, usage: {} });
    await until(() => ws.sent.some(m => m.type === 'done'));
    queries[0].rewindFiles = async () => ({ canRewind: true, filesChanged: [] });

    // The panel's guess is the assistant row it rendered; the transcript says the turn ended on a carrier.
    client({ type: 'rewind_conversation', messageUuid: 'assistant-row-uuid', userMessageUuid: 'prompt-uuid' });
    await until(() => results().length === 1);
    assert.deepEqual(asked[0], { sessionId: UUID, uuid: 'prompt-uuid', cwd: process.cwd(), accountId: '' });
    assert.equal(results()[0].ok, true);
    assert.equal(results()[0].messageUuid, 'carrier-uuid');
    await until(() => queries.length === 2);
    assert.equal(queries[1].options.resumeSessionAt, 'carrier-uuid');

    // The first prompt: nothing to go back to, and nothing is restarted.
    answer = '';
    client({ type: 'rewind_conversation', messageUuid: 'x', userMessageUuid: 'first-prompt' });
    await until(() => results().length === 2);
    assert.equal(results()[1].ok, false);
    assert.match(results()[1].error, /first message/);
    assert.equal(queries.length, 2);

    // The transcript cannot say: the rewind is refused (review 3, T07). This
    // asserted the panel's own value was used instead; that value can cut the
    // kept turn short, so nothing is rewound and nothing restarted.
    let rewound = 0;
    queries[1].rewindFiles = async () => { rewound++; return { canRewind: true, filesChanged: [] }; };
    answer = new Error('ENOENT');
    client({ type: 'rewind_conversation', messageUuid: 'panel-guess', userMessageUuid: 'prompt-uuid' });
    await until(() => results().length === 3);
    assert.equal(results()[2].ok, false);
    assert.match(results()[2].error, /transcript/i);
    assert.equal(rewound, 0);
    assert.equal(queries.length, 2);
  } finally { close(); shutdownAllBridges(); }
});

// ═══ Run 2 gaps ═══

const controlRequests = (sent) => sent.filter(m => m.type === 'control_request');
const responses = (sent, what) => sent.filter(m => m.type === 'session_response' && m.what === what);
const CONTEXT = { toolUseID: 'toolu_1', suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] }] };

// ── C39 ──

test('C39: the bridge keeps what "Always" granted, hands it back on reattach, and can forget the session rules', async () => {
  const { ws, queries, client, close } = panelConnection();
  try {
    assert.ok(ws.sent[0].capabilities.includes('permission_rules'));
    client({ type: 'query', prompt: 'go', windowId: 'w-c39', cwd: process.cwd() });
    await until(() => queries[0]?.pushed.length === 1);
    queries[0].emit({ type: 'system', subtype: 'init', session_id: UUID });
    const answer = async (updates) => {
      const before = controlRequests(ws.sent).length;
      const pending = queries.at(-1).options.canUseTool('Bash', { command: 'npm test' }, { ...CONTEXT, signal: new AbortController().signal });
      await until(() => controlRequests(ws.sent).length === before + 1);
      client({ type: 'control_response', request_id: controlRequests(ws.sent).at(-1).request_id, response: { behavior: 'allow', updatedPermissions: updates } });
      return pending;
    };
    const sessionRule = { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], junk: { x: 1 } };
    const fileRule = { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Read', ruleContent: '//tmp/**' }] };
    assert.deepEqual((await answer([sessionRule])).updatedPermissions, [sessionRule], 'the CLI gets the update untouched');
    await answer([fileRule]);

    client({ type: 'session_request', id: 'r1', what: 'permission_rules' });
    await until(() => responses(ws.sent, 'permission_rules').length === 1);
    assert.deepEqual(responses(ws.sent, 'permission_rules')[0].data.granted, [
      { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] },
      { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Read', ruleContent: '//tmp/**' }] },
    ]);

    // Forgetting the session rules needs an idle session; it ends the process (they live in it).
    client({ type: 'session_request', id: 'r2', what: 'forget_session_rules' });
    await until(() => responses(ws.sent, 'forget_session_rules').length === 1);
    assert.equal(responses(ws.sent, 'forget_session_rules')[0].ok, false, 'not in the middle of a turn');
    queries[0].emit({ type: 'result', subtype: 'success', session_id: UUID, total_cost_usd: 0, usage: {} });
    await until(() => ws.sent.some(m => m.type === 'done'));
    client({ type: 'session_request', id: 'r3', what: 'forget_session_rules' });
    await until(() => responses(ws.sent, 'forget_session_rules').length === 2);
    const forgot = responses(ws.sent, 'forget_session_rules')[1];
    assert.equal(forgot.ok, true);
    assert.deepEqual(forgot.data.granted.map(u => u.destination), ['localSettings'], 'rules written to a settings file are not the session\'s to forget');
    assert.equal(forgot.data.restarted, true);
    // The next message resumes the conversation in a new process.
    client({ type: 'query', prompt: 'again', windowId: 'w-c39', sessionId: UUID, cwd: process.cwd() });
    await until(() => queries.length === 2 && queries[1].pushed.length === 1);
    assert.equal(queries[1].options.resume, UUID);
  } finally { close(); shutdownAllBridges(); }

  // Any other caller: no record, no new requests, and the whole-tool Always it had.
  const plainQueries = configure();
  const sent = [];
  const plain = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send: (d) => sent.push(JSON.parse(d)) }, {});
  try {
    plain._pushUserText('go');
    const pending = plainQueries[0].options.canUseTool('Bash', { command: 'ls' }, { ...CONTEXT, signal: new AbortController().signal });
    await until(() => controlRequests(sent).length === 1);
    plain._resolvePermission(controlRequests(sent)[0].request_id, { behavior: 'allow', updatedPermissions: CONTEXT.suggestions });
    await pending;
    assert.equal(plain._grantedRules.length, 0);
    await plain.handleMessage({ type: 'session_request', id: 'x', what: 'permission_rules' });
    assert.equal(sent.some(m => m.type === 'session_response'), false);
  } finally { plain.destroy(); }
});

// ── C82 ──

test('C82: panel sessions ask the CLI for its session-state events; nobody else does', async () => {
  const { queries, client, close } = panelConnection();
  try {
    client({ type: 'query', prompt: 'go', windowId: 'w-c82' });
    await until(() => queries[0]?.pushed.length === 1);
    assert.equal(queries[0].options.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1', 'the CLI emits session_state_changed only with this set');
  } finally { close(); shutdownAllBridges(); }
  const plainQueries = configure();
  const plain = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send: () => {} }, {});
  try {
    plain._pushUserText('go');
    assert.equal('CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS' in plainQueries[0].options.env, false);
  } finally { plain.destroy(); }
});

// ── C54 ──

test('C54: a model change reports what re-caching the conversation costs (panel sessions only)', async () => {
  const { ws, queries, client, close } = panelConnection();
  const costs = () => ws.sent.filter(m => m.type === 'event' && m.event?.subtype === 'cache_cost').map(m => m.event);
  try {
    client({ type: 'query', prompt: 'go', windowId: 'w-c54' });
    await until(() => queries[0]?.pushed.length === 1);
    const hook = queries[0].options.hooks.PostModelSwitch[0].hooks[0];
    const input = { hook_event_name: 'PostModelSwitch', from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', requested_model: 'sonnet', source: 'sdk', context_tokens: 84000, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 0.31, pricing: 'catalog' };
    assert.deepEqual(await hook(input), {}, 'the hook decides nothing');
    assert.deepEqual(costs()[0], { type: 'system', subtype: 'cache_cost', session_id: null, source: 'model_switch', from_model: 'claude-opus-5-5', to_model: 'claude-sonnet-5-5', context_tokens: 84000, prompt_cache_warm: true, estimated_cache_write_usd: 0.31 });
    await hook({ ...input, estimated_cache_write_usd: 0 });
    await hook({ ...input, source: 'resume' });
    assert.equal(costs().length, 1, 'nothing to say when it is free, and a resume has its own notice');
  } finally { close(); shutdownAllBridges(); }
  const plainQueries = configure();
  const plain = new ClaudeSession({ readyState: 1, bufferedAmount: 0, send: () => {} }, {});
  try {
    plain._pushUserText('go');
    assert.equal('PostModelSwitch' in plainQueries[0].options.hooks, false);
  } finally { plain.destroy(); }
});

// ── C33 ──

test('C33: a tab changes its MCP servers on the live session; SynaBun is always in the set', async () => {
  const { ws, queries, client, close } = panelConnection({ mcpUrl: 'http://localhost:3344/mcp' });
  try {
    assert.ok(ws.sent[0].capabilities.includes('mcp_dynamic'));
    client({ type: 'query', prompt: 'go', windowId: 'w-c33', session: {} });
    await until(() => queries[0]?.pushed.length === 1);
    const q = queries[0];
    assert.deepEqual(Object.keys(q.options.mcpServers), ['SynaBun']);
    q.setMcpServers = async (servers) => { q.calls.push(['setMcpServers', servers]); return { added: ['docs'], removed: [], errors: { docs: 'x'.repeat(500) } }; };
    q.mcpServerStatus = async () => [{ name: 'SynaBun', status: 'connected' }, { name: 'docs', status: 'failed', error: 'refused' }];
    q.setMcpPermissionModeOverride = async (name, mode) => { q.calls.push(['override', name, mode]); return name === 'typo' ? { warning: 'no such server' } : {}; };

    client({ type: 'session_request', id: 'm1', what: 'mcp_set_servers', args: { servers: [
      { name: 'docs', url: 'https://mcp.example.com/mcp', alwaysLoad: true },
      { name: 'SynaBun', url: 'https://evil.example/mcp' },
      { name: 'shell', type: 'stdio', command: 'rm', url: 'file:///x' },
    ] } });
    await until(() => responses(ws.sent, 'mcp_set_servers').length === 1);
    const sent = q.calls.find(c => c[0] === 'setMcpServers')[1];
    assert.deepEqual(Object.keys(sent), ['SynaBun', 'docs'], 'the host entry is re-included, the tab cannot replace it, stdio is not accepted');
    assert.equal(sent.SynaBun.url, 'http://localhost:3344/mcp');
    assert.deepEqual(sent.docs, { type: 'http', url: 'https://mcp.example.com/mcp', alwaysLoad: true });
    const data = responses(ws.sent, 'mcp_set_servers')[0].data;
    assert.deepEqual([data.added, data.removed, data.errors.docs.length], [['docs'], [], 300]);
    assert.deepEqual(data.applied, [{ name: 'docs', type: 'http', url: 'https://mcp.example.com/mcp', alwaysLoad: true, timeoutMs: 0 }]);
    assert.deepEqual(data.servers.map(s => s.name), ['SynaBun', 'docs']);

    // The next message carries the same servers in its session settings: no restart.
    queries[0].emit({ type: 'result', subtype: 'success', session_id: UUID, total_cost_usd: 0, usage: {} });
    await until(() => ws.sent.some(m => m.type === 'done'));
    client({ type: 'query', prompt: 'again', windowId: 'w-c33', sessionId: UUID, session: { mcpServers: data.applied } });
    await until(() => queries[0].pushed.length === 2);
    assert.equal(queries.length, 1);

    // Removing them all leaves SynaBun.
    client({ type: 'session_request', id: 'm2', what: 'mcp_set_servers', args: { servers: [] } });
    await until(() => responses(ws.sent, 'mcp_set_servers').length === 2);
    assert.deepEqual(Object.keys(q.calls.filter(c => c[0] === 'setMcpServers')[1][1]), ['SynaBun']);

    // Per-server prompts.
    client({ type: 'session_request', id: 'p1', what: 'mcp_permission_mode', args: { serverName: 'docs', mode: 'default' } });
    client({ type: 'session_request', id: 'p2', what: 'mcp_permission_mode', args: { serverName: 'typo', mode: 'bypassPermissions' } });
    await until(() => responses(ws.sent, 'mcp_permission_mode').length === 2);
    assert.deepEqual(q.calls.filter(c => c[0] === 'override'), [['override', 'docs', 'default'], ['override', 'typo', null]], 'only default / auto / clear');
    assert.equal(responses(ws.sent, 'mcp_permission_mode')[1].data.warning, 'no such server');
  } finally { close(); shutdownAllBridges(); }

  // Without a live session the servers are not "set": they start with the session.
  const idle = panelConnection({ mcpUrl: 'http://localhost:3344/mcp' });
  try {
    idle.client({ type: 'session_request', id: 'm3', what: 'mcp_set_servers', args: { servers: [] } });
    await until(() => responses(idle.ws.sent, 'mcp_set_servers').length === 1);
    assert.equal(responses(idle.ws.sent, 'mcp_set_servers')[0].ok, false);
  } finally { idle.close(); shutdownAllBridges(); }
});

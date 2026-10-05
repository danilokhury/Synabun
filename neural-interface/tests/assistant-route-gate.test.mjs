import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { claudeRouteAvailability, createRouteGate, gateStateFor, isExemptTool, mcpStatusRouteAvailability, toolBaseName, ROUTE_GATE_MAX_REFUSALS } from '../lib/assistant-route-gate.js';
import { codexGateHookFlags, codexGateTrust, codexNeedsShell, codexRouteGateBootstrap, findGateHook, CODEX_GATE_HOOK_PATH } from '../lib/assistant-route-gate-codex.js';
import { patchOpenCodeAssistantConfig, OPENCODE_ROUTE_GATE_PLUGIN } from '../lib/assistant-brains/opencode.js';
import { createCodexBrain } from '../lib/assistant-brains/codex.js';
import { createAssistantRuntime } from '../lib/assistant-runtime.js';
import routeGatePlugin from '../lib/assistant-brains/opencode-route-gate.js';
import { createRemotePolicyRegistry } from '../lib/remote-policy.js';
import { homedir } from 'node:os';

// Timers on the paths these tests wait for are unref'd on purpose, so a pending
// call never holds the server open. With nothing else on the loop Node 22
// drains it before they fire, and the remaining tests of the file are cancelled
// with "Promise resolution is still pending but the event loop has already
// resolved". Hold the loop open for the length of the file.
const keepAlive = setInterval(() => {}, 60_000);
after(() => clearInterval(keepAlive));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const approved = (target, extra = {}) => ({ ok: true, status: 'approved', routeId: 'route-abc', target, continuation: false, ...extra });

// ── state machine ────────────────────────────────────────────────────────────
test('exempt tools match by base name whatever the host prefix', () => {
  for (const name of ['mcp__SynaBun__recall', 'SynaBun_remember', 'SynaBun.agent_dispatch', 'mcp__SynaBun__agent_usage', 'agent_route', 'AskUserQuestion', 'SynaBun_choice', 'question', 'ToolSearch', 'TodoWrite', 'mcp__SynaBun__image_staged', 'SynaBun_computer_status', 'profile']) assert.ok(isExemptTool(name), name);
  for (const name of ['Bash', 'Read', 'mcp__SynaBun__browser_navigate', 'SynaBun_computer', 'mcp__other__recall', 'edit', 'Task']) assert.equal(isExemptTool(name), false, name);
  assert.equal(toolBaseName('mcp__SynaBun__agent_wait'), 'agent_wait');
});

test('unrouted refuses; approved direct opens; dispatch / pending / continuation / declined hold with the next step', () => {
  const gate = createRouteGate({ sessionId: 'assistant-1', routeTool: () => 'mcp__SynaBun__agent_route' });
  gate.startTurn();
  const refused = gate.check('Bash');
  assert.equal(refused.allow, false);
  assert.match(refused.reason, /not routed\. Call mcp__SynaBun__agent_route first/);
  assert.match(refused.reason, /assistant_session_id "assistant-1"/);
  assert.equal(gate.check('mcp__SynaBun__recall').allow, true);
  assert.equal(gate.check('SynaBun_agent_usage').allow, true);
  gate.onRouteResult(approved({ kind: 'direct', provider: 'opencode', model: 'm' }));
  assert.equal(gate.check('Bash').allow, true);
  const cases = [
    [approved({ kind: 'dispatch', provider: 'claude-code', model: 'opus[1m]' }), /Routed to claude-code\/opus\[1m\]: call agent_dispatch with route_id route-abc; do not do this task here/],
    [{ ok: true, status: 'pending', routeId: 'route-p' }, /Waiting for the user's route choice: end your turn/],
    [approved({ kind: 'direct', provider: 'opencode', model: 'big', label: 'Big', continuation: true }, { continuation: true }), /Continuing on Big: end your turn/],
    [{ ok: true, status: 'declined', routeId: 'route-d' }, /declined this route/],
  ];
  for (const [result, message] of cases) {
    gate.startTurn();
    gate.onRouteResult(result);
    assert.equal(gate.snapshot().state, 'held');
    const r = gate.check('Read');
    assert.equal(r.allow, false);
    assert.match(r.reason, message);
    assert.equal(gate.check('SynaBun_agent_dispatch').allow, true, 'agent_* stays allowed');
  }
});

test('another agent_route in the same turn re-evaluates; a router error fails open; a new turn resets', () => {
  const gate = createRouteGate();
  gate.startTurn();
  gate.onRouteResult(approved({ kind: 'dispatch', provider: 'codex', model: 'x' }));
  assert.equal(gate.check('Bash').allow, false);
  gate.onRouteResult(approved({ kind: 'direct', provider: 'codex', model: 'y' }));
  assert.equal(gate.check('Bash').allow, true, 'the second subtask is routed here');
  gate.startTurn();
  assert.equal(gate.check('Bash').allow, false);
  gate.onRouteError(new Error('catalog down'));
  assert.equal(gate.check('Bash').allow, true);
  assert.equal(gateStateFor({ ok: false, error: 'x' }).state, 'failed');
  gate.startTurn({ open: true });
  assert.equal(gate.check('Edit').allow, true, 'continuation and route_decided-here turns start open');
});

test('a "chat" route unlocks nothing: the refusal says to answer in text or route the real class', () => {
  const gate = createRouteGate();
  gate.startTurn();
  gate.onRouteResult(approved({ kind: 'direct', provider: 'claude-code', model: 'default' }), { taskClass: 'chat' });
  assert.equal(gate.snapshot().state, 'held');
  const refused = gate.check('Bash');
  assert.equal(refused.allow, false);
  assert.match(refused.reason, /chat route unlocks no tools/);
  assert.equal(gate.check('mcp__SynaBun__recall').allow, true);
  gate.onRouteResult(approved({ kind: 'direct', provider: 'claude-code', model: 'default' }), { taskClass: 'quick' });
  assert.equal(gate.check('Bash').allow, true, 'routing the real class opens it');
  assert.equal(gateStateFor(approved({ kind: 'direct', provider: 'x' }), { taskClass: 'CHAT' }).state, 'held');
});

test('a brain that cannot reach agent_route is not gated, across turns, until it can again', () => {
  const gate = createRouteGate();
  gate.startTurn();
  gate.setUnavailable('its SynaBun MCP server is failed');
  const allowed = gate.check('Bash');
  assert.equal(allowed.allow, true);
  assert.equal(allowed.unavailable, true);
  gate.startTurn();
  assert.equal(gate.check('Edit').allow, true, 'survives a new turn');
  assert.equal(gate.snapshot().refusals, 0, 'nothing counts toward the loop guard');
  gate.setUnavailable(null);
  assert.equal(gate.check('Edit').allow, false);
});

test('routing reach: Claude init and OpenCode / Codex MCP status', () => {
  const init = (status, tools) => ({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'context7', status: 'connected' }, ...(status ? [{ name: 'SynaBun', status }] : [])], tools });
  assert.deepEqual(claudeRouteAvailability(init('connected', ['Bash', 'mcp__SynaBun__agent_route'])), { available: true });
  assert.equal(claudeRouteAvailability(init('connected', ['Bash', 'mcp__SynaBun__recall'])).available, false, 'connected without the assistant role');
  assert.match(claudeRouteAvailability(init('failed', [])).reason, /SynaBun MCP server is failed/);
  assert.equal(claudeRouteAvailability(init('needs-auth', [])).available, false);
  assert.equal(claudeRouteAvailability(init('pending', [])), null, 'still connecting: cannot tell');
  assert.equal(claudeRouteAvailability(init(null, ['Bash'])).available, false, 'no SynaBun server at all');
  assert.equal(claudeRouteAvailability({ type: 'system', subtype: 'init' }), null);
  // OpenCode: GET /mcp → { name: { status } }
  assert.deepEqual(mcpStatusRouteAvailability({ SynaBun: { status: 'connected' } }), { available: true });
  assert.equal(mcpStatusRouteAvailability({ SynaBun: { status: 'failed', error: 'x' } }).available, false);
  assert.equal(mcpStatusRouteAvailability({ SynaBun: { status: 'disabled' } }).available, false);
  assert.equal(mcpStatusRouteAvailability({ other: { status: 'failed' } }), null);
  // Codex: mcpServer/startupStatus/updated → [{ name, status }]
  assert.deepEqual(mcpStatusRouteAvailability([{ name: 'SynaBun', status: 'ready' }]), { available: true });
  assert.equal(mcpStatusRouteAvailability([{ name: 'SynaBun', status: 'failed', error: 'boom' }]).available, false);
  assert.equal(mcpStatusRouteAvailability([{ name: 'SynaBun', status: 'starting' }]), null);
  assert.equal(mcpStatusRouteAvailability([]), null);
});

test('loop guard: the refusal that reaches the limit asks for an abort, once', () => {
  const gate = createRouteGate();
  gate.startTurn();
  const results = Array.from({ length: ROUTE_GATE_MAX_REFUSALS + 2 }, () => gate.check('Bash'));
  assert.equal(results.filter((r) => r.abort).length, 1);
  assert.equal(results[ROUTE_GATE_MAX_REFUSALS - 1].abort, true);
  gate.startTurn({ carry: true });
  assert.equal(gate.check('Bash').refusals, ROUTE_GATE_MAX_REFUSALS + 3, 'carry keeps counting');
});

// ── runtime: turn starts, Claude hook, OpenCode/Codex check, reactive fallback ─
function fakeRouter() {
  return { owns: () => false, pendingCards: () => [], cancelForSession() {}, stamp: () => ({ text: '', changed: false, commit() {} }) };
}
function harness(t, { provider = 'claude-code', memory = null, gateMode = null, config = {}, remotePolicy = createRemotePolicyRegistry() } = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'asst-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = [];
  const factory = ({ session, sink, deps, hooks }) => {
    let busy = false;
    log.push(['create', hooks, deps]);
    const brain = {
      kind: session.brain.provider, gateMode, sink,
      async start() {},
      async sendUserTurn({ text }) { log.push(['turn', text]); busy = true; setTimeout(() => { busy = false; sink.send({ type: 'done', code: 0 }); }, 5); },
      async abort() { log.push(['abort']); busy = false; sink.send({ type: 'aborted' }); },
      isBusy: () => busy, identity: () => ({ providerSessionId: 'oc-main' }), async dispose() {},
    };
    return brain;
  };
  const runtime = createAssistantRuntime({
    dataDir: dir, brainFactories: { 'claude-code': factory, opencode: factory, codex: factory }, router: fakeRouter(), memory,
    catalog: { peek: () => ({ models: {} }), brainInfo: () => null, hiddenId: () => null }, gateUrl: 'http://127.0.0.1:1/api/assistant/route-gate/check',
    codexGateBootstrap: async (args) => { log.push(['codex-bootstrap', args]); return { flags: ['-c', 'hooks.PreToolUse=[]'], env: {} }; },
    config, remotePolicy,
  });
  t.after(() => runtime.shutdown());
  return { runtime, log, remotePolicy };
}

test('Claude brain: the PreToolUse hook denies until routed, lets subagents through, and keeps the memory hooks', async (t) => {
  const memory = { claudeHooks: () => ({ UserPromptSubmit: [{ hooks: [async () => ({})] }], PreToolUse: [{ matcher: 'x', hooks: [async () => ({})] }] }) };
  const { runtime, log } = harness(t, { memory });
  const session = await runtime.createSession({ brain: { provider: 'claude-code' } });
  const live = runtime._internals.sessions.get(session.id);
  await runtime._internals.runQuery(live, { text: 'fix the bug' });
  const hooks = log.find(([k]) => k === 'create')[1];
  assert.equal(hooks.UserPromptSubmit.length, 1);
  assert.equal(hooks.PreToolUse.length, 3, 'memory matcher + gate matcher + browser policy');
  const gateHook = hooks.PreToolUse[1].hooks[0];
  const denied = await gateHook({ tool_name: 'Bash' });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /mcp__SynaBun__agent_route/);
  assert.deepEqual(await gateHook({ tool_name: 'mcp__SynaBun__recall' }), {});
  assert.deepEqual(await gateHook({ tool_name: 'Bash', agent_id: 'sub-1' }), {});
  runtime.routerRouted(session.id, approved({ kind: 'direct', provider: 'claude-code', model: 'sonnet' }));
  assert.deepEqual(await gateHook({ tool_name: 'Bash' }), {});
  // A turn the CLI starts itself resets the gate.
  live.running = false;
  runtime._internals.onBrainPacket(live, { type: 'turn_started' });
  assert.equal((await gateHook({ tool_name: 'Bash' })).hookSpecificOutput.permissionDecision, 'deny');
});

test('Claude brain: the hook is installed even without memory hooks; the loop guard aborts with a visible error', async (t) => {
  const { runtime, log } = harness(t);
  const session = await runtime.createSession({ brain: { provider: 'claude-code' } });
  const live = runtime._internals.sessions.get(session.id);
  const sent = [];
  live.sockets.add({ readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) });
  await runtime._internals.runQuery(live, { text: 'go' });
  const gateHook = log.find(([k]) => k === 'create')[1].PreToolUse[0].hooks[0];
  for (let i = 0; i < ROUTE_GATE_MAX_REFUSALS; i++) await gateHook({ tool_name: 'Bash' });
  await wait(10);
  assert.ok(log.some(([k]) => k === 'abort'));
  assert.ok(sent.some((p) => p.type === 'error' && p.code === 'ROUTE_GATE_LOOP' && /kept working without routing/.test(p.message)));
});

test('Claude brain: a chat route keeps the hook denying; an init without agent_route turns the gate off with one status line', async (t) => {
  const { runtime, log } = harness(t);
  const session = await runtime.createSession({ brain: { provider: 'claude-code' } });
  const live = runtime._internals.sessions.get(session.id);
  const sent = [];
  live.sockets.add({ readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) });
  await runtime._internals.runQuery(live, { text: 'what is 2+2' });
  const gateHook = log.find(([k]) => k === 'create')[1].PreToolUse[0].hooks[0];
  runtime.routerRouted(session.id, approved({ kind: 'direct', provider: 'claude-code', model: 'default' }), { taskClass: 'chat' });
  assert.match((await gateHook({ tool_name: 'Bash' })).hookSpecificOutput.permissionDecisionReason, /chat route unlocks no tools/);
  const status = () => sent.filter((p) => p.type === 'event' && p.event?.subtype === 'status').map((p) => p.event.text);
  const init = (tools) => ({ type: 'event', event: { type: 'system', subtype: 'init', session_id: 's1', mcp_servers: [{ name: 'SynaBun', status: 'connected' }], tools } });
  runtime._internals.onBrainPacket(live, init(['Bash', 'mcp__SynaBun__recall']));
  runtime._internals.onBrainPacket(live, init(['Bash', 'mcp__SynaBun__recall']));
  assert.deepEqual(await gateHook({ tool_name: 'Bash' }), {}, 'a brain that cannot route is not locked out');
  assert.equal(status().length, 1, 'said once');
  assert.match(status()[0], /Route gate off for this brain: agent_route is missing/);
  runtime._internals.onBrainPacket(live, init(['Bash', 'mcp__SynaBun__agent_route']));
  assert.match(status()[1], /Route gate back on/);
  assert.equal((await gateHook({ tool_name: 'Bash' })).hookSpecificOutput.permissionDecision, 'deny');
});

test('OpenCode brain: reactive until the plugin says hello, then the plugin gates; a failed SynaBun server turns it off', async (t) => {
  const { runtime, log } = harness(t, { provider: 'opencode' });
  const session = await runtime.createSession({ brain: { provider: 'opencode' } });
  const live = runtime._internals.sessions.get(session.id);
  await runtime._internals.runQuery(live, { text: 'build it' });
  await wait(20);
  const token = log.find(([k]) => k === 'create')[2].routeGate.token;
  const toolUse = { type: 'event', event: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] } } };
  live.running = true;
  runtime._internals.onBrainPacket(live, toolUse);
  await wait(40);
  assert.ok(log.some(([k]) => k === 'abort'), 'no hello: the unrouted tool start interrupts the turn');
  assert.match(log.filter(([k]) => k === 'turn').at(-1)[1], /\[SynaBun Router\] Your last tool call was stopped/);
  await wait(20);
  assert.deepEqual(runtime.gateCheck({ session: session.id, token, hello: true }), { ok: true, hello: true });
  const aborts = log.filter(([k]) => k === 'abort').length;
  live.running = true;
  runtime._internals.onBrainPacket(live, toolUse);
  await wait(20);
  assert.equal(log.filter(([k]) => k === 'abort').length, aborts, 'after hello the plugin refuses before the tool runs; no interrupt');
  assert.equal(runtime.gateCheck({ session: session.id, token, tool: 'bash', providerSessionId: 'oc-main' }).allow, false);
  runtime._internals.onBrainPacket(live, { type: 'event', event: { type: 'system', subtype: 'mcp_status', servers: { SynaBun: { status: 'failed', error: 'spawn node ENOENT' } } } });
  assert.equal(runtime.gateCheck({ session: session.id, token, tool: 'bash', providerSessionId: 'oc-main' }).allow, true, 'cannot route → not gated');
  await runtime._internals.disposeBrain(live, 'idle');
  assert.equal(live.gatePluginAt, null, 'the next serve says hello again');
  assert.equal(live.gate.snapshot().unavailable, null, 'the next brain reports its own reach');
});

test('continuation turns and route_decided "here" mailbox turns start open; other turns start unrouted', async (t) => {
  const { runtime } = harness(t, { provider: 'opencode' });
  const session = await runtime.createSession({ brain: { provider: 'opencode' } });
  const live = runtime._internals.sessions.get(session.id);
  await runtime._internals.runQuery(live, { text: 'hello' });
  assert.equal(live.gate.snapshot().state, 'unrouted');
  await wait(20);
  runtime.routerContinue(session.id, { target: { kind: 'direct', provider: 'opencode', model: 'big' }, route: { summary: 's' } });
  await wait(120);
  assert.equal(live.gate.snapshot().state, 'open');
  await wait(20);
  runtime._internals.enqueueMailbox(live, { kind: 'route_decided', route: { routeId: 'route-1', target: { kind: 'direct', provider: 'opencode', model: 'm' } }, runIds: [] });
  await runtime._internals.deliverMailbox(live);
  assert.equal(live.gate.snapshot().state, 'open');
  await wait(20);
  runtime._internals.enqueueMailbox(live, { kind: 'route_decided', route: { routeId: 'route-2', target: { kind: 'dispatch', provider: 'codex', model: 'x' } }, runIds: [] });
  await runtime._internals.deliverMailbox(live);
  assert.equal(live.gate.snapshot().state, 'unrouted');
});

test('gateCheck (OpenCode plugin / Codex hook): token required, subagent sessions pass, refusals carry the reason', async (t) => {
  const { runtime, log } = harness(t, { provider: 'opencode' });
  const session = await runtime.createSession({ brain: { provider: 'opencode' } });
  const live = runtime._internals.sessions.get(session.id);
  await runtime._internals.runQuery(live, { text: 'do it' });
  const deps = log.find(([k]) => k === 'create')[2];
  assert.deepEqual(Object.keys(deps.routeGate).sort(), ['session', 'token', 'url']);
  assert.throws(() => runtime.gateCheck({ session: session.id, token: 'wrong', tool: 'bash' }), (e) => e.code === 'ROUTE_GATE_UNKNOWN');
  const refused = runtime.gateCheck({ session: session.id, token: deps.routeGate.token, tool: 'bash', providerSessionId: 'oc-main' });
  assert.equal(refused.allow, false);
  assert.match(refused.reason, /SynaBun_agent_route/);
  assert.equal(runtime.gateCheck({ session: session.id, token: deps.routeGate.token, tool: 'bash', providerSessionId: 'oc-child' }).allow, true);
  assert.equal(runtime.gateCheck({ session: session.id, token: deps.routeGate.token, tool: 'SynaBun_recall', providerSessionId: 'oc-main' }).allow, true);
  runtime.routerRouteFailed(session.id, new Error('router down'));
  assert.equal(runtime.gateCheck({ session: session.id, token: deps.routeGate.token, tool: 'bash' }).allow, true, 'fail open');
});

test('Codex reactive fallback: an ungated tool start interrupts the turn and a system turn tells the brain to route', async (t) => {
  const { runtime, log } = harness(t, { provider: 'codex', gateMode: 'reactive' });
  const session = await runtime.createSession({ brain: { provider: 'codex' } });
  const live = runtime._internals.sessions.get(session.id);
  await runtime._internals.runQuery(live, { text: 'build it' });
  await wait(20);
  live.running = true;
  runtime._internals.onBrainPacket(live, { type: 'event', event: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } } });
  await wait(40);
  assert.ok(log.some(([k]) => k === 'abort'));
  const nudge = log.filter(([k]) => k === 'turn').at(-1)[1];
  assert.match(nudge, /\[SynaBun Router\] Your last tool call was stopped/);
  assert.match(nudge, /SynaBun_agent_route/);
  assert.equal(live.gate.snapshot().refusals, 1, 'the follow-up turn keeps counting toward the loop guard');
});

// ── OpenCode: plugin config + plugin behaviour ───────────────────────────────
async function gateServer(t, reply) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      // The OpenCode plugin's hello (fire-and-forget at load) is kept apart from the tool checks.
      if (parsed.hello) reply.hello = parsed; else reply.seen = parsed;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(parsed.hello ? { ok: true, hello: true } : reply.value));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/api/assistant/route-gate/check`;
}

test('OpenCode: the assistant serve config gets the plugin entry (with options) only when a gate is given', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'oc-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'opencode'), { recursive: true });
  const path = resolve(root, 'opencode', 'config.json');
  writeFileSync(path, JSON.stringify({ plugin: ['user-plugin'], mcp: { SynaBun: { environment: {} } } }));
  const gate = { url: 'http://127.0.0.1:3344/api/assistant/route-gate/check', session: 'assistant-1', token: 'tok' };
  patchOpenCodeAssistantConfig(root, { persona: 'p', routeGate: gate });
  patchOpenCodeAssistantConfig(root, { persona: 'p', routeGate: gate });
  const config = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(config.plugin, ['user-plugin', [OPENCODE_ROUTE_GATE_PLUGIN, gate]]);
  assert.match(OPENCODE_ROUTE_GATE_PLUGIN, /^file:\/\/.*opencode-route-gate\.js$/);
  patchOpenCodeAssistantConfig(root, { persona: 'p' });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).plugin, ['user-plugin']);
});

test('OpenCode plugin: a refusal throws (a tool error, the loop goes on); allow and an unreachable server pass', async (t) => {
  const reply = { value: { allow: false, reason: 'SynaBun route gate: bash was refused.' } };
  const url = await gateServer(t, reply);
  const hooks = await routeGatePlugin({}, { url, session: 'assistant-1', token: 'tok' });
  await assert.rejects(hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_1', callID: 'c' }, { args: { command: 'git status', description: 'x', timeout: 5 } }), /bash was refused/);
  // The call's whole arguments travel (the remote denylist reads paths from them), marked complete.
  assert.deepEqual(reply.seen, { session: 'assistant-1', token: 'tok', host: 'opencode', tool: 'bash', providerSessionId: 'ses_1', input: { command: 'git status', description: 'x', timeout: 5 }, inputComplete: true });
  await wait(20);
  assert.deepEqual(reply.hello, { session: 'assistant-1', token: 'tok', host: 'opencode', hello: true }, 'loading the plugin says hello');
  reply.value = { allow: true };
  await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_1' }, { args: {} });
  const offline = await routeGatePlugin({}, { url: 'http://127.0.0.1:9/x', session: 's', token: 't' });
  await offline['tool.execute.before']({ tool: 'bash' }, { args: {} });
  assert.deepEqual(await routeGatePlugin({}, {}), {}, 'no options → no hooks');
});

// ── Codex: session-flag hook, trust, hook script, bootstrap ──────────────────
test('Codex: the hook flags install and trust one PreToolUse command hook; hooks/list gives the trust key', async () => {
  const flags = codexGateHookFlags('node "/x/hook.mjs"', { key: '/<session-flags>/config.toml:pre_tool_use:0:0', hash: 'sha256:ab' });
  assert.deepEqual(flags.filter((f) => f !== '-c'), [
    'features.hooks=true',
    'hooks.PreToolUse=[{matcher="*", hooks=[{type="command", command="node \\"/x/hook.mjs\\"", timeout=15}]}]',
    'hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="sha256:ab"}}',
  ]);
  const listed = { data: [{ cwd: '/tmp', hooks: [{ key: '/<session-flags>/config.toml:pre_tool_use:0:0', eventName: 'preToolUse', command: 'node "/x/hook.mjs"', source: 'sessionFlags', currentHash: 'sha256:ab', trustStatus: 'untrusted' }] }] };
  assert.deepEqual(findGateHook(listed, 'node "/x/hook.mjs"'), { key: '/<session-flags>/config.toml:pre_tool_use:0:0', hash: 'sha256:ab', trustStatus: 'untrusted' });
  assert.equal(findGateHook(listed, 'other'), null);
  const bin = '/opt/homebrew/bin/codex';
  const boot = await codexRouteGateBootstrap({ url: 'http://u', session: 's', token: 't', codexBin: bin, trust: async () => ({ key: 'k', hash: 'h' }) });
  assert.deepEqual(boot.env, { SYNABUN_ROUTE_GATE_URL: 'http://u', SYNABUN_ROUTE_GATE_SESSION: 's', SYNABUN_ROUTE_GATE_TOKEN: 't' });
  assert.ok(boot.flags.some((f) => f.startsWith('hooks.state=')));
  assert.equal(await codexRouteGateBootstrap({ url: 'http://u', session: 's', token: 't', codexBin: bin, trust: async () => null }), null, 'no trust → reactive fallback');
});

test('Codex: a binary spawned through a shell gets no hook (the shell would mangle its -c flags) → reactive', async () => {
  assert.equal(codexNeedsShell('codex', 'darwin'), true);
  assert.equal(codexNeedsShell('/opt/homebrew/bin/codex', 'darwin'), false);
  assert.equal(codexNeedsShell('/x/codex.js', 'darwin'), false, 'a .js entry runs through node');
  let trusted = 0;
  const trust = async () => { trusted += 1; return { key: 'k', hash: 'h' }; };
  assert.equal(await codexRouteGateBootstrap({ url: 'http://u', session: 's', token: 't', codexBin: 'codex', trust }), null);
  assert.equal(trusted, 0, 'no probe either');
  let spawned = 0;
  assert.equal(await codexGateTrust({ codexBin: 'codex-bare-name', spawnImpl: () => { spawned += 1; throw new Error('never'); } }), null);
  assert.equal(spawned, 0);
});

test('Codex hook script: deny with the reason when refused, nothing when allowed or offline', async (t) => {
  const reply = { value: { allow: false, reason: 'SynaBun route gate: Bash was refused.' } };
  const url = await gateServer(t, reply);
  const runAsync = (env) => new Promise((done) => {
    const child = spawn(process.execPath, [CODEX_GATE_HOOK_PATH], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', (code) => done({ code, out }));
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }));
  });
  const env = { SYNABUN_ROUTE_GATE_URL: url, SYNABUN_ROUTE_GATE_SESSION: 'assistant-1', SYNABUN_ROUTE_GATE_TOKEN: 'tok' };
  const denied = await runAsync(env);
  assert.equal(denied.code, 0);
  assert.deepEqual(JSON.parse(denied.out), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'SynaBun route gate: Bash was refused' } }, 'no final period: Codex appends ". Command: …"');
  assert.equal(reply.seen.tool, 'Bash');
  reply.value = { allow: true };
  assert.equal((await runAsync(env)).out, '');
  assert.equal((await runAsync({ ...env, SYNABUN_ROUTE_GATE_URL: 'http://127.0.0.1:9/x' })).out, '');
});

test('Codex brain: the bootstrap carries the gate hook (assistant role); no hook → reactive mode', async () => {
  const boots = [];
  const make = (routeGate) => createCodexBrain({
    session: { id: 'assistant-1', brain: { provider: 'codex' } }, sink: { send() {} },
    deps: { routeGate, handleCodexSkinWebSocket: (socket) => { socket.onClientMessage = null; const original = socket.receive; socket.receive = (m) => { if (m.type === 'bootstrap') { boots.push(m); queueMicrotask(() => socket.send?.({ type: 'ready' })); } return original?.call(socket, m); }; } },
  });
  const hooked = make(async () => ({ flags: ['-c', 'features.hooks=true'], env: { SYNABUN_ROUTE_GATE_URL: 'u' } }));
  hooked.start().catch(() => {});
  await wait(20);
  assert.deepEqual(boots[0].routeGate.flags, ['-c', 'features.hooks=true']);
  assert.equal(boots[0].role, 'assistant');
  assert.equal(hooked.gateMode, 'hook');
  const reactive = make(async () => null);
  reactive.start().catch(() => {});
  await wait(20);
  assert.equal(boots[1].routeGate, undefined);
  assert.equal(reactive.gateMode, 'reactive');
  await hooked.dispose(); await reactive.dispose();
});

// ── WhatsApp (remote) sessions on Codex / OpenCode: read-only, whole arguments, fail closed ──
const REMOTE_ASK = { remote: { channel: 'whatsapp', level: 'ask' } };
const REMOTE_AUTO = () => ({ remote: { channel: 'whatsapp', level: 'autonomous', autonomousUntil: Date.now() + 3600_000 } });

test('a WhatsApp session on an OpenCode or Codex brain runs read-only whatever its level; on Claude the level holds', async (t) => {
  for (const provider of ['opencode', 'codex']) {
    const { runtime, log, remotePolicy } = harness(t, { provider });
    const session = await runtime.createSession({ brain: { provider } }, REMOTE_AUTO());
    assert.equal(session.remoteLevel, 'read-only', provider);
    assert.equal(remotePolicy.getSessionPolicy(session.id).brainProvider, provider, 'every reader of the registry sees the brain');
    const live = runtime._internals.sessions.get(session.id);
    await runtime._internals.ensureBrain(live);
    const deps = log.find(([k]) => k === 'create')[2];
    assert.equal(deps.remoteReadOnly, true, `${provider}: the brain is built read-only`);
    if (provider === 'opencode') {
      assert.equal(deps.routeGate.remote, true, 'the plugin fails closed');
      runtime.gateCheck({ session: session.id, token: deps.routeGate.token, hello: true });
    } else {
      assert.equal(log.find(([k]) => k === 'codex-bootstrap')?.[1]?.remote, undefined, 'bootstrap runs lazily');
      await deps.routeGate();
      assert.equal(log.find(([k]) => k === 'codex-bootstrap')[1].remote, true, 'the hook fails closed');
    }
    const turn = await runtime._internals.runQuery(live, { text: 'look around', origin: 'whatsapp' });
    assert.equal(turn.ok, true, provider);
    assert.equal(live.record.brain.planMode, true, `${provider}: plan mode, the read-only policy`);
  }
  const claude = harness(t);
  const s = await claude.runtime.createSession({ brain: { provider: 'claude-code' } }, REMOTE_ASK);
  assert.equal(s.remoteLevel, 'ask');
  assert.equal(claude.runtime.routerSession(s.id).remote, true, 'the router gives a remote session one dispatch per card');
  assert.equal(claude.runtime.routerSession((await claude.runtime.createSession({ brain: { provider: 'claude-code' } })).id).remote, false);
  const live = claude.runtime._internals.sessions.get(s.id);
  await claude.runtime._internals.ensureBrain(live);
  assert.equal(claude.log.find(([k]) => k === 'create')[2].remoteReadOnly, false);
  // Switching the WhatsApp session's brain to Codex lowers it at once.
  await claude.runtime.updateSession(s.id, { brain: { provider: 'codex' } });
  assert.equal(claude.runtime.getSession(s.id).remoteLevel, 'read-only');
  assert.equal(claude.remotePolicy.getSessionPolicy(s.id).brainProvider, 'codex');
});

test('a WhatsApp session on OpenCode refuses to run a turn until its gate plugin is loaded (fail closed)', async (t) => {
  const { runtime } = harness(t, { provider: 'opencode', config: { remoteGateHelloMs: 30 } });
  const session = await runtime.createSession({ brain: { provider: 'opencode' } }, REMOTE_ASK);
  const live = runtime._internals.sessions.get(session.id);
  const refused = await runtime._internals.runQuery(live, { text: 'hi', origin: 'whatsapp' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'REMOTE_GATE_MISSING');
  // A desktop OpenCode session is not held (the reactive fallback stays).
  const desk = await runtime.createSession({ brain: { provider: 'opencode' } });
  assert.equal((await runtime._internals.runQuery(runtime._internals.sessions.get(desk.id), { text: 'hi' })).ok, true);
});

test('gateCheck of a WhatsApp OpenCode session: web fetch / search refused, arguments required, credentials refused, plan mode read-only', async (t) => {
  const { runtime, log } = harness(t, { provider: 'opencode' });
  const session = await runtime.createSession({ brain: { provider: 'opencode' } }, REMOTE_AUTO());
  const live = runtime._internals.sessions.get(session.id);
  await runtime._internals.ensureBrain(live);
  const { token } = log.find(([k]) => k === 'create')[2].routeGate;
  runtime.gateCheck({ session: session.id, token, hello: true });
  await runtime._internals.runQuery(live, { text: 'look', origin: 'whatsapp' });
  const check = (tool, input, extra = {}) => runtime.gateCheck({ session: session.id, token, tool, input, inputComplete: true, providerSessionId: 'oc-main', host: 'opencode', ...extra });
  for (const tool of ['webfetch', 'websearch', 'codesearch']) {
    const r = check(tool, { url: 'https://example.com/?q=x' });
    assert.equal(r.allow, false, tool);
    assert.match(r.reason, /web/i, tool);
  }
  assert.equal(check('webfetch', { url: 'https://example.com' }, { providerSessionId: 'oc-child' }).allow, false, 'a subagent session too');
  assert.match(check('read', { filePath: `${homedir()}/.ssh/id_rsa` }).reason, /SSH keys/);
  assert.match(check('bash', { command: 'ls' }, { inputComplete: false }).reason, /could not see this call's arguments/);
  assert.equal(check('SynaBun_recall', {}, { inputComplete: false }).allow, true, 'coordination tools need no arguments');
  assert.equal(check('edit', { filePath: '/work/app/a.js', oldString: 'a', newString: 'b' }).allow, false, 'plan mode refuses edits');
  assert.equal(check('read', { filePath: '/work/app/a.js' }).allow, true);
  // Codex hook calls without their arguments are refused too.
  assert.match(runtime.gateCheck({ session: session.id, token, tool: 'Bash', input: {}, host: 'codex' }).reason, /could not see/);
});

test('Codex hook: forwards the whole tool_input (inputComplete); a WhatsApp session denies when SynaBun cannot answer', async (t) => {
  const reply = { value: { allow: true } };
  const url = await gateServer(t, reply);
  const run = (env, payload) => new Promise((done) => {
    const child = spawn(process.execPath, [CODEX_GATE_HOOK_PATH], { env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', (code) => done({ code, out }));
    child.stdin.end(JSON.stringify(payload));
  });
  const env = { SYNABUN_ROUTE_GATE_URL: url, SYNABUN_ROUTE_GATE_SESSION: 'assistant-1', SYNABUN_ROUTE_GATE_TOKEN: 'tok' };
  await run(env, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/work/a.js', offset: 2 } });
  assert.deepEqual(reply.seen.input, { file_path: '/work/a.js', offset: 2 });
  assert.equal(reply.seen.inputComplete, true);
  await run(env, { hook_event_name: 'PreToolUse', tool_name: 'mcp__SynaBun__browser_upload', tool_input: { action: 'x', paths: ['/a'] } });
  assert.deepEqual(reply.seen.input, { action: 'x', paths: ['/a'] });
  await run(env, { hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  assert.equal(reply.seen.inputComplete, false, 'no tool_input from the host');
  await run(env, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/work/big.txt', content: 'x'.repeat(300_000) } });
  assert.equal(reply.seen.inputComplete, false, 'too big to send: marked incomplete');
  assert.deepEqual(reply.seen.input, {}, 'only the command / action subset travels');
  const offline = { ...env, SYNABUN_ROUTE_GATE_URL: 'http://127.0.0.1:9/x' };
  assert.equal((await run(offline, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } })).out, '', 'a desktop session: unreachable allows (unchanged)');
  const denied = await run({ ...offline, SYNABUN_ROUTE_GATE_REMOTE: '1' }, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(JSON.parse(denied.out).hookSpecificOutput.permissionDecision, 'deny', 'a WhatsApp session: unreachable denies');
});

test('OpenCode plugin: whole arguments travel; with remote on, an unreachable gate refuses the call', async (t) => {
  const reply = { value: { allow: true } };
  const url = await gateServer(t, reply);
  const hooks = await routeGatePlugin({}, { url, session: 'assistant-1', token: 'tok', remote: true });
  await hooks['tool.execute.before']({ tool: 'read', sessionID: 'ses_1' }, { args: { filePath: '/work/a.js', offset: 3 } });
  assert.deepEqual(reply.seen.input, { filePath: '/work/a.js', offset: 3 });
  assert.equal(reply.seen.inputComplete, true);
  const offline = await routeGatePlugin({}, { url: 'http://127.0.0.1:9/x', session: 's', token: 't', remote: true });
  await assert.rejects(offline['tool.execute.before']({ tool: 'bash' }, { args: { command: 'ls' } }), /could not check/);
  const bad = await routeGatePlugin({}, { url, session: 's', token: 't', remote: true });
  reply.value = 'not json';
  await assert.rejects(bad['tool.execute.before']({ tool: 'bash' }, { args: { command: 'ls' } }), /could not check/, 'a bad reply too');
});

test('contracts: the route-gate endpoint passes inputComplete; server.js runs a Codex turn read-only (network off) when asked', () => {
  const api = readFileSync(new URL('../lib/assistant-api.js', import.meta.url), 'utf8');
  assert.match(api, /inputComplete: body\.inputComplete === true/);
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const policy = server.slice(server.indexOf('function buildCodexSandboxPolicy('), server.indexOf('function buildCodexSandboxPolicy(') + 600);
  assert.match(policy, /mode === 'read-only'[\s\S]*networkAccess: false/);
  assert.match(server, /sandboxMode: msg\.sandboxMode === 'read-only' \? 'read-only' : null/);
  assert.match(server, /buildCodexSandboxPolicy\(cwd, isPlanModeTurn \|\| opts\.sandboxMode === 'read-only' \? 'read-only'/);
});

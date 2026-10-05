import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  ClaudeSession,
  PANEL_CAPABILITIES,
  configureClaudeBridge,
  createClaudeBridge,
  shutdownAllBridges,
  bridgeStats,
} from '../lib/claude-agent-bridge.js';
import {
  TEMPORARY_ENV,
  TEMPORARY_NOTICE,
  SYNABUN_STORE_TOOLS,
  temporaryToolRefusal,
  temporaryDisallowedTools,
} from '../lib/claude-temporary.js';
import * as temporary from '../lib/claude-temporary.js';

// A temporary chat: a panel conversation that leaves nothing behind
// (docs/claude-sidepanel.md, "Temporary chat"). These tests pin what the bridge
// launches for one, that every other session is launched as it was, and that a
// temporary session never outlives its page.

function scriptedQuery({ prompt, options }) {
  const queue = [];
  let wake = null;
  let ended = false;
  const wakeUp = () => { const w = wake; wake = null; w?.(); };
  const finish = () => { if (q.held) return; ended = true; wakeUp(); };
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
  q.end = finish; // the process went away by itself
  q.held = false; // true: it takes its time to end (a write under way); exit() lets it
  q.exit = () => { q.held = false; finish(); };
  q.interrupt = async () => { q.calls.push(['interrupt']); };
  q.setPermissionMode = async (mode) => { q.calls.push(['setPermissionMode', mode]); };
  q.setModel = async (model) => { q.calls.push(['setModel', model]); };
  q.applyFlagSettings = async (settings) => { q.calls.push(['applyFlagSettings', settings]); };
  q.rewindFiles = async (uuid) => { q.calls.push(['rewindFiles', uuid]); return { canRewind: true }; };
  q.supportedCommands = async () => [];
  q.mcpServerStatus = async () => [];
  q.initializationResult = async () => ({});
  (async () => { for await (const m of prompt) q.pushed.push(m); finish(); })();
  options.abortController?.signal.addEventListener('abort', finish, { once: true });
  return q;
}

function configure(extra = {}) {
  const queries = [];
  const calls = { addCost: [], getSessionCost: [], lock: [], plan: [] };
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(),
    includePartialMessages: false,
    mcpUrl: 'http://localhost:1/mcp',
    queryFactory: (args) => { const q = scriptedQuery(args); queries.push(q); return q; },
    acquireSessionLock: (...a) => { calls.lock.push(a); return { ok: true }; },
    heartbeatLock: () => {},
    releaseAllLocks: () => {},
    getSessionCost: (...a) => { calls.getSessionCost.push(a); return 0; },
    addCost: (...a) => { calls.addCost.push(a); },
    maybeInjectSkillPrompt: (prompt) => ({ prompt }),
    toCliModelName: (model) => model,
    writePlanFile: (...a) => { calls.plan.push(a); return { ok: true, path: '/tmp/x.md', name: 'x.md' }; },
    ...extra,
  });
  return { queries, calls };
}

// One sidepanel socket, as createClaudeBridge() serves it.
function connect() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.bufferedAmount = 0;
  ws.sent = [];
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  ws.ping = () => {};
  ws.terminate = () => {};
  createClaudeBridge(ws);
  return {
    ws,
    client: (msg) => ws.emit('message', Buffer.from(JSON.stringify(msg))),
    close: () => { ws.readyState = 3; ws.emit('close'); },
    of: (type) => ws.sent.filter(m => m.type === type),
  };
}

async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 5));
  }
}
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

const init = (id) => ({ type: 'system', subtype: 'init', session_id: id, tools: [], mcp_servers: [], slash_commands: [] });

// What a query's options look like, without the parts that are not data.
function shape(o) {
  return Object.fromEntries(Object.keys(o).sort().map(k => [k,
    k === 'env' ? Object.keys(o.env).filter(e => !(e in process.env)).sort()
      : k === 'hooks' ? Object.keys(o.hooks).sort()
        : typeof o[k] === 'function' ? 'fn'
          : k === 'abortController' ? 'ac'
            : k === 'mcpServers' ? Object.fromEntries(Object.entries(o.mcpServers).map(([n, s]) => [n, Object.keys(s.headers || {}).sort()]))
              : k === 'cwd' || k === 'additionalDirectories' ? 'path'
                : o[k]]));
}

// Two launches compared: every option whose shape is not the same in both, as
// [in the first, in the second]. An ordinary launch is always one produced in
// the same test, so nothing here says what an ordinary launch looks like: only
// what a temporary chat changes in it.
function differences(a, b) {
  const sa = shape(a);
  const sb = shape(b);
  const out = {};
  for (const key of [...new Set([...Object.keys(sa), ...Object.keys(sb)])].sort()) {
    if (!isDeepStrictEqual(sa[key], sb[key])) out[key] = [sa[key], sb[key]];
  }
  return out;
}
// Exactly what a temporary chat changes in the launch `ordinary` (applyTemporaryOptions), and nothing else.
function temporaryDifferences(ordinary) {
  const o = shape(ordinary);
  return {
    disallowedTools: [undefined, temporaryDisallowedTools()],
    enableFileCheckpointing: [true, false],
    env: [o.env, [...o.env, ...[TEMPORARY_ENV, 'SYNABUN_TYPESAFE'].filter(k => !(k in process.env))].sort()],
    hooks: [o.hooks, [...o.hooks, 'PreToolUse'].sort()],
    persistSession: [undefined, false],
    settings: [undefined, { autoMemoryEnabled: false }],
    systemPrompt: [{ type: 'preset', preset: 'claude_code' }, { type: 'preset', preset: 'claude_code', append: TEMPORARY_NOTICE }],
  };
}
// Nothing of a temporary chat is in this launch.
function assertOrdinary(o, what) {
  assert.ok(!('persistSession' in o), `${what}: the transcript is kept`);
  assert.equal(o.enableFileCheckpointing, true, `${what}: file checkpoints`);
  assert.ok(!(TEMPORARY_ENV in o.env), `${what}: no marker for the hooks`);
  assert.equal(o.env.SYNABUN_TYPESAFE, process.env.SYNABUN_TYPESAFE, `${what}: judgments as the server has them`);
  assert.ok(!o.settings || !('autoMemoryEnabled' in o.settings), `${what}: Claude Code's memory as configured`);
  assert.ok(!(o.disallowedTools || []).some(t => /^mcp__/.test(t)), `${what}: SynaBun's tools are all there`);
  assert.ok(!String(o.systemPrompt?.append || '').includes(TEMPORARY_NOTICE), `${what}: no notice`);
}

test('the hello announces the temporary chat', () => {
  configure();
  const { ws, close } = connect();
  try {
    assert.ok(PANEL_CAPABILITIES.includes('temporary_chat'));
    assert.ok(ws.sent[0].capabilities.includes('temporary_chat'));
  } finally { close(); shutdownAllBridges(); }
});

test('a temporary session is launched to leave nothing behind', async () => {
  const { queries, calls } = configure();
  const { client, close } = connect();
  try {
    client({ type: 'query', prompt: 'hello', windowId: 'w-temp', cwd: process.cwd(), temporary: true, title: 'A name', session: { debug: true } });
    await until(() => queries.length === 1);
    const o = queries[0].options;
    assert.equal(o.persistSession, false, 'no transcript');
    assert.equal(o.enableFileCheckpointing, false, 'no file checkpoints');
    assert.equal(o.env[TEMPORARY_ENV], '1', 'the marker SynaBun\'s hooks read');
    assert.equal(o.env.SYNABUN_TYPESAFE, 'off', 'no judgment of this session\'s hooks is asked for or logged');
    assert.equal(o.settings.autoMemoryEnabled, false, 'Claude Code\'s own memory is neither read nor written');
    assert.ok(!('resume' in o) && !('title' in o) && !('resumeSessionAt' in o) && !('debugFile' in o) && !('debug' in o));
    for (const tool of ['remember', 'reflect', 'forget', 'restore', 'sync', 'whiteboard_add', 'card_open']) {
      assert.ok(o.disallowedTools.includes(`mcp__SynaBun__${tool}`), `${tool} is removed from the session`);
    }
    // A tool that also reads stays, and its writing actions are refused below.
    for (const tool of ['recall', 'memories', 'category', 'style_guide']) assert.ok(!o.disallowedTools.includes(`mcp__SynaBun__${tool}`), tool);
    assert.equal(o.systemPrompt.preset, 'claude_code');
    assert.ok(o.systemPrompt.append.includes(TEMPORARY_NOTICE));
    // The session is not named to SynaBun's memory server by a conversation id.
    assert.match(o.mcpServers.SynaBun.headers['X-Synabun-Memory-Session'], /^sidepanel-/);
    // The refusal that holds whatever the permission rules and the mode say.
    const pre = o.hooks.PreToolUse.at(-1).hooks[0];
    const denied = await pre({ tool_name: 'mcp__SynaBun__category', tool_input: { action: 'create', name: 'x' } });
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /temporary chat/i);
    assert.deepEqual(await pre({ tool_name: 'mcp__SynaBun__category', tool_input: { action: 'list' } }), {});
    assert.deepEqual(await pre({ tool_name: 'mcp__SynaBun__recall', tool_input: { query: 'x' } }), {});
    assert.deepEqual(await pre({ tool_name: 'Bash', tool_input: { command: 'ls' } }), {});
    assert.equal(calls.lock.length, 0, 'no session lock is taken');
  } finally { close(); shutdownAllBridges(); }
});

test('a temporary launch differs from an ordinary one in exactly what the feature changes, and no other session is touched', async () => {
  const { queries } = configure();
  const a = connect();
  const b = connect();
  const c = connect();
  const sent = [];
  const socket = () => ({ readyState: 1, bufferedAmount: 0, send: (d) => sent.push(JSON.parse(d)) });
  const plain = new ClaudeSession(socket(), {});
  const plainAsked = new ClaudeSession(socket(), {});
  try {
    a.client({ type: 'query', prompt: 'hello', windowId: 'w-a', cwd: process.cwd() });
    await until(() => queries.length === 1);
    const ordinary = queries[0].options;
    assertOrdinary(ordinary, 'an ordinary panel session');
    // The same message with `temporary: true`: the differences are the feature's own, all of them and no other.
    c.client({ type: 'query', prompt: 'hello', windowId: 'w-c', cwd: process.cwd(), temporary: true });
    await until(() => queries.length === 2);
    assert.deepEqual(differences(ordinary, queries[1].options), temporaryDifferences(ordinary));
    // The comparison is not satisfied by less: take any one of the feature's differences away from the
    // temporary launch (or all of them), and it no longer holds.
    const wanted = temporaryDifferences(ordinary);
    for (const key of Object.keys(wanted)) {
      const without = { ...queries[1].options, [key]: ordinary[key] };
      if (!(key in ordinary)) delete without[key];
      assert.ok(!isDeepStrictEqual(differences(ordinary, without), wanted), `a temporary launch without its ${key} would not pass`);
    }
    assert.ok(!isDeepStrictEqual(differences(ordinary, ordinary), wanted));
    // Only `true` asks for one.
    b.client({ type: 'query', prompt: 'hello', windowId: 'w-b', cwd: process.cwd(), temporary: 'yes' });
    await until(() => queries.length === 3);
    assert.deepEqual(differences(ordinary, queries[2].options), {});
    assertOrdinary(queries[2].options, 'a panel session that did not say `true`');
    // A session without the panel flag (the Assistant brain) cannot be made temporary by a message:
    // told to be one, it is launched exactly as one that was not told.
    plain._handleQuery({ prompt: 'x', cwd: process.cwd() });
    await until(() => queries.length === 4);
    plainAsked._handleQuery({ prompt: 'x', cwd: process.cwd(), temporary: true });
    await until(() => queries.length === 5);
    assert.deepEqual(differences(queries[3].options, queries[4].options), {});
    assert.ok(!plainAsked.temporary);
    assertOrdinary(queries[3].options, 'a session without the panel flag');
    assertOrdinary(queries[4].options, 'a session without the panel flag that was told to be temporary');
    // …and it is still kept for a reattach while it works, as before.
    plainAsked.windowId = 'w-plain';
    queries[4].emit(init('s-plain'));
    await until(() => plainAsked.sessionId === 's-plain');
    assert.equal(plainAsked.detach(), true);
    assert.equal(bridgeStats().detached, 1);
  } finally { plain.destroy(); plainAsked.destroy(); a.close(); b.close(); c.close(); shutdownAllBridges(); }
});

test('a temporary session whose page is gone is ended and cannot be reattached', async () => {
  const { queries } = configure();
  const first = connect();
  const normal = connect();
  try {
    first.client({ type: 'query', prompt: 'hello', windowId: 'w-gone', temporary: true });
    normal.client({ type: 'query', prompt: 'hello', windowId: 'w-kept' });
    await until(() => queries.length === 2);
    queries[0].emit(init('s-temp'));
    queries[1].emit(init('s-kept'));
    await until(() => first.of('event').length && normal.of('event').length);
    // Both are in a turn. The page goes away.
    first.close();
    normal.close();
    assert.equal(queries[0].options.abortController.signal.aborted, true, 'the temporary session\'s process is ended');
    assert.equal(queries[1].options.abortController.signal.aborted, false, 'any other session is kept for the reattach');
    assert.equal(bridgeStats().detached, 1);
    // A page that comes back finds nothing to reclaim…
    const back = connect();
    back.client({ type: 'reattach', windowId: 'w-gone', sessionId: 's-temp' });
    assert.deepEqual(back.of('reattach_result'), [{ type: 'reattach_result', ok: false }]);
    // …and cannot go on with the conversation: nothing is started in its name.
    back.client({ type: 'query', prompt: 'and then?', windowId: 'w-gone', sessionId: 's-temp', temporary: true });
    await tick();
    assert.equal(queries.length, 2);
    assert.equal(back.of('error')[0].code, 'temporary_ended');
    assert.equal(back.of('done').length, 1);
    back.close();
  } finally { shutdownAllBridges(); }
});

test('the choice is fixed with the first message', async () => {
  const { queries } = configure();
  const started = connect();
  const temp = connect();
  try {
    // A conversation that has started cannot be made temporary.
    started.client({ type: 'query', prompt: 'hello', windowId: 'w-1' });
    await until(() => queries.length === 1);
    queries[0].emit(init('s-1'));
    queries[0].emit({ type: 'result', subtype: 'success', session_id: 's-1', queued_turn_count: 0 });
    await until(() => started.of('done').length === 1);
    started.client({ type: 'query', prompt: 'now in private', windowId: 'w-1', sessionId: 's-1', temporary: true });
    await tick();
    assert.equal(started.of('error').at(-1).code, 'temporary_refused');
    assert.equal(queries.length, 1);
    assert.equal(queries[0].pushed.length, 1, 'the prompt was not sent');
    assert.equal(queries[0].options.abortController.signal.aborted, false);

    // A temporary one stays temporary whatever a later message says.
    temp.client({ type: 'query', prompt: 'hello', windowId: 'w-2', temporary: true });
    await until(() => queries.length === 2);
    queries[1].emit(init('s-t'));
    queries[1].emit({ type: 'result', subtype: 'success', session_id: 's-t', queued_turn_count: 0 });
    await until(() => temp.of('done').length === 1);
    temp.client({ type: 'query', prompt: 'more', windowId: 'w-2', sessionId: 's-t' });
    await until(() => queries[1].pushed.length === 2);
    assert.equal(queries.length, 2, 'the same process');

    // New chat in the same tab is a normal conversation again…
    temp.client({ type: 'query', prompt: 'a new chat', windowId: 'w-2' });
    await until(() => queries.length === 3);
    assert.equal(queries[1].options.abortController.signal.aborted, true);
    assert.deepEqual(differences(queries[0].options, queries[2].options), {}, 'launched as the ordinary session of this test was');
    assert.deepEqual(differences(queries[0].options, queries[1].options), temporaryDifferences(queries[0].options));
    queries[2].emit(init('s-n'));
    await until(() => temp.of('event').some(m => m.event?.session_id === 's-n'));
    // …unless it is chosen again.
    temp.client({ type: 'query', prompt: 'another', windowId: 'w-2', temporary: true });
    await until(() => queries.length === 4);
    assert.equal(queries[3].options.persistSession, false);
    assert.ok(!('resume' in queries[3].options));
  } finally { started.close(); temp.close(); shutdownAllBridges(); }
});

test('until the first message the latest word decides, and a process kept ready for the other kind is not used', async () => {
  const warmed = [];
  const closed = [];
  const { queries } = configure({
    startupFactory: async ({ options }) => {
      warmed.push(options);
      return { query: (prompt) => { const q = scriptedQuery({ prompt, options }); queries.push(q); return q; }, close: () => closed.push(options) };
    },
  });
  const a = connect();
  const b = connect();
  const c = connect();
  try {
    // Typed with Temporary on, then switched off before sending: an ordinary conversation.
    a.client({ type: 'warm', windowId: 'w-a', cwd: process.cwd(), temporary: true });
    await until(() => warmed.length === 1);
    assert.equal(warmed[0].persistSession, false);
    await tick();
    a.client({ type: 'query', prompt: 'hello', windowId: 'w-a', cwd: process.cwd() });
    await until(() => queries.length === 1);
    assert.deepEqual(differences(queries[0].options, warmed[0]), temporaryDifferences(queries[0].options), 'not the process that was kept ready');
    assert.deepEqual(closed, [warmed[0]], 'the process kept ready as a temporary one is ended, not used');

    // Typed first, then switched on: the ordinary process kept ready is not the one that answers.
    b.client({ type: 'warm', windowId: 'w-b', cwd: process.cwd() });
    await until(() => warmed.length === 2);
    assert.deepEqual(differences(queries[0].options, warmed[1]), {}, 'an ordinary process kept ready is launched as the ordinary session above');
    await tick();
    b.client({ type: 'query', prompt: 'hello', windowId: 'w-b', cwd: process.cwd(), temporary: true });
    await until(() => queries.length === 2);
    assert.equal(queries[1].options.persistSession, false);
    assert.deepEqual(closed, [warmed[0], warmed[1]]);

    // Chosen and kept: the process kept ready is the temporary one, and it is used.
    c.client({ type: 'warm', windowId: 'w-c', cwd: process.cwd(), temporary: true });
    await until(() => warmed.length === 3);
    await tick();
    c.client({ type: 'query', prompt: 'hello', windowId: 'w-c', cwd: process.cwd(), temporary: true });
    await until(() => queries.length === 3);
    assert.equal(queries[2].options, warmed[2]);
    assert.equal(closed.length, 2);
  } finally { a.close(); b.close(); c.close(); shutdownAllBridges(); }
});

test('what a temporary chat cannot do is refused with the reason, and it goes on', async () => {
  const { queries } = configure();
  const { client, close, of } = connect();
  try {
    client({ type: 'query', prompt: 'hello', windowId: 'w-r', temporary: true });
    await until(() => queries.length === 1);
    queries[0].emit(init('s-r'));
    queries[0].emit({ type: 'result', subtype: 'success', session_id: 's-r', queued_turn_count: 0 });
    await until(() => of('done').length === 1);

    client({ type: 'rewind', userMessageUuid: 'u-1' });
    client({ type: 'rewind_conversation', messageUuid: 'm-1', userMessageUuid: 'u-1' });
    client({ type: 'session_request', id: 'r-1', what: 'rewind_preview', args: { userMessageUuid: 'u-1' } });
    client({ type: 'session_request', id: 'r-2', what: 'forget_session_rules' });
    await until(() => of('rewind_result').length && of('rewind_conversation_result').length && of('session_response').length === 2);
    for (const answer of [of('rewind_result')[0], of('rewind_conversation_result')[0], ...of('session_response')]) {
      assert.equal(answer.ok, false);
      assert.equal(answer.code, 'temporary');
      assert.match(answer.error, /temporary chat/i);
    }
    assert.deepEqual(queries[0].calls.filter(c => c[0] === 'rewindFiles'), []);

    // A setting that is fixed when the process starts cannot change: the
    // restart it needs would lose the conversation.
    client({ type: 'query', prompt: 'restricted now', windowId: 'w-r', sessionId: 's-r', temporary: true, toolPolicy: 'read-only' });
    await tick();
    assert.equal(of('error').at(-1).code, 'temporary_restart');
    assert.equal(queries.length, 1);
    assert.equal(queries[0].options.abortController.signal.aborted, false);
    assert.equal(queries[0].pushed.length, 1);
    // The next message, as the conversation was started, is answered by the same process.
    client({ type: 'query', prompt: 'as before', windowId: 'w-r', sessionId: 's-r', temporary: true });
    await until(() => queries[0].pushed.length === 2);
    assert.equal(queries.length, 1);
  } finally { close(); shutdownAllBridges(); }
});

test('nothing of SynaBun names it: no cost row, no lock, no plan file', async () => {
  const { queries, calls } = configure();
  const temp = connect();
  const normal = connect();
  try {
    temp.client({ type: 'query', prompt: 'hello', windowId: 'w-c', temporary: true });
    normal.client({ type: 'query', prompt: 'hello', windowId: 'w-n' });
    await until(() => queries.length === 2);
    for (const [q, id] of [[queries[0], 's-c'], [queries[1], 's-n']]) {
      q.emit(init(id));
      q.options.canUseTool('ExitPlanMode', { plan: '# Plan\n\nDo it.' }, {});
      q.emit({ type: 'result', subtype: 'success', session_id: id, queued_turn_count: 0, total_cost_usd: 0.25 });
    }
    await until(() => temp.of('done').length === 1 && normal.of('done').length === 1);
    // The money is counted; the session is not named.
    assert.deepEqual([...calls.addCost].sort((a, b) => String(a[1]).localeCompare(String(b[1]))), [[0.25, null], [0.25, 's-n']]);
    assert.deepEqual(calls.getSessionCost, [['s-n']]);
    assert.equal(calls.plan.length, 1, 'only the normal session\'s plan is written to SynaBun\'s plans');
    assert.ok(temp.of('control_request').length === 1, 'the plan card is still shown');
    assert.ok(!temp.of('event').some(m => m.event?.subtype === 'plan_file_written'));
    // A later message of the tab names the session: still no lock.
    calls.lock.length = 0;
    temp.client({ type: 'query', prompt: 'more', windowId: 'w-c', sessionId: 's-c', temporary: true });
    temp.client({ type: 'heartbeat', windowId: 'w-c', sessionId: 's-c' });
    await until(() => queries[0].pushed.length === 2);
    assert.deepEqual(calls.lock, []);
  } finally { temp.close(); normal.close(); shutdownAllBridges(); }
});

test('the plan file Claude Code wrote for it is removed when it ends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-temp-'));
  const plans = join(dir, 'plans');
  mkdirSync(plans);
  const old = join(plans, 'someone-elses.md');
  const outside = join(dir, 'notes.md');
  writeFileSync(old, 'an older plan');
  await tick(40);
  const { queries } = configure({ claudeAccountEnv: (id) => (id === 'work' ? { CLAUDE_CONFIG_DIR: dir } : null) });
  const { client, close, of } = connect();
  try {
    client({ type: 'query', prompt: 'plan it', windowId: 'w-p', temporary: true, accountId: 'work' });
    await until(() => queries.length === 1);
    const mine = join(plans, 'plan-it-quiet-otter.md');
    writeFileSync(mine, '# Plan');
    writeFileSync(outside, 'not a plan');
    queries[0].emit(init('s-p'));
    queries[0].emit({ type: 'assistant', session_id: 's-p', parent_tool_use_id: null, message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't-1', name: 'Write', input: { file_path: mine, content: '# Plan' } },
      { type: 'tool_use', id: 't-2', name: 'Write', input: { file_path: outside, content: 'x' } },
      { type: 'tool_use', id: 't-3', name: 'ExitPlanMode', input: { plan: '# Plan', planFilePath: old } },
    ] } });
    await until(() => of('event').some(m => m.event?.type === 'assistant'));
    close();
    await until(() => !existsSync(mine));
    assert.equal(existsSync(old), true, 'a plan that was there before it started is not touched');
    assert.equal(existsSync(outside), true, 'nothing outside the plans folder is touched');
  } finally { shutdownAllBridges(); rmSync(dir, { recursive: true, force: true }); }
});

test('it lives as long as its tab: no idle reap, no restart after a stall', async () => {
  const { queries } = configure();
  const sent = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (d) => sent.push(JSON.parse(d)) };
  const temp = new ClaudeSession(ws, { panel: true });
  const normal = new ClaudeSession(ws, { panel: true });
  try {
    temp._handleQuery({ prompt: 'hello', windowId: 'w-i', temporary: true });
    normal._handleQuery({ prompt: 'hello', windowId: 'w-j' });
    await until(() => queries.length === 2);
    queries[0].emit(init('s-i'));
    queries[1].emit(init('s-j'));
    await until(() => temp.sessionId === 's-i' && normal.sessionId === 's-j');
    for (const s of [temp, normal]) { s.inTurn = false; s.pendingTurns = 0; s.lastActivity = 0; s._maybeReapIdle(); }
    assert.ok(temp.q, 'a temporary chat is not reaped: its conversation could not be resumed');
    assert.equal(normal.q, null, 'any other idle session still is');

    // A stalled stream: the turn is stopped and said so; the process is kept.
    sent.length = 0;
    temp.inTurn = true; temp.pendingTurns = 1; temp.bootComplete = true; temp.lastEventTime = 0; temp._lastPushAt = Date.now();
    temp._checkStall();
    await until(() => sent.some(m => m.type === 'done'));
    assert.deepEqual(queries[0].calls.filter(c => c[0] === 'interrupt'), [['interrupt']]);
    assert.equal(queries.length, 2, 'no process was started in its place');
    assert.ok(temp.q);
    assert.match(sent.find(m => m.type === 'error').message, /temporary chat/i);
    assert.ok(!sent.some(m => m.type === 'event' && m.event?.subtype === 'retry'));
  } finally { temp.destroy(); normal.destroy(); shutdownAllBridges(); }
});

test('when its process ends the chat is over, and the page is told', async () => {
  const { queries } = configure();
  const { client, close, of } = connect();
  try {
    client({ type: 'query', prompt: 'hello', windowId: 'w-e', temporary: true });
    await until(() => queries.length === 1);
    queries[0].emit(init('s-e'));
    queries[0].emit({ type: 'result', subtype: 'success', session_id: 's-e', queued_turn_count: 0 });
    await until(() => of('done').length === 1);
    queries[0].end();
    await until(() => of('temporary_ended').length === 1);
    client({ type: 'query', prompt: 'still there?', windowId: 'w-e', sessionId: 's-e', temporary: true });
    client({ type: 'compact', config: { windowId: 'w-e', sessionId: 's-e', temporary: true } });
    await tick();
    assert.equal(queries.length, 1, 'nothing is started in its place');
    assert.deepEqual(of('error').map(m => m.code), ['temporary_ended', 'temporary_ended']);
    assert.equal(of('temporary_ended').length, 1, 'said once');
  } finally { close(); shutdownAllBridges(); }
});

test('SynaBun\'s tools are sorted into reading, acting and storing', () => {
  const refused = (name, input) => temporaryToolRefusal(`mcp__SynaBun__${name}`, input);
  // Storing: refused whatever the input.
  for (const tool of SYNABUN_STORE_TOOLS) assert.ok(refused(tool, {}), `${tool} is refused`);
  for (const tool of ['remember', 'reflect', 'forget', 'restore', 'sync', 'whiteboard_add', 'whiteboard_update', 'whiteboard_remove', 'card_open', 'card_close', 'card_update', 'tictactoe']) {
    assert.ok(SYNABUN_STORE_TOOLS.includes(tool), `${tool} is on the list`);
  }
  // Reading.
  for (const tool of ['recall', 'whiteboard_read', 'whiteboard_screenshot', 'card_list', 'card_screenshot', 'choice']) assert.equal(refused(tool, {}), '', tool);
  // One tool, both: the action decides, and an action nobody listed is refused.
  assert.equal(refused('memories', { action: 'recent' }), '');
  assert.equal(refused('memories', { action: 'get', id: 'x' }), '');
  assert.ok(refused('memories', { action: 'undo' }));
  assert.ok(refused('memories', { action: 'feedback' }));
  assert.ok(refused('memories', { action: 'triage' }));
  assert.ok(refused('memories', { action: 'maintenance', operation: 'pause' }));
  assert.equal(refused('memories', { action: 'maintenance' }), '');
  assert.equal(refused('memories', { action: 'maintenance', operation: 'status' }), '');
  assert.equal(refused('category', { action: 'list' }), '');
  for (const action of ['create', 'update', 'delete', undefined, 'LIST ']) assert.ok(refused('category', { action }), `category ${action}`);
  assert.equal(refused('style_guide', {}), '', 'its default action is get');
  assert.equal(refused('style_guide', { action: 'tokens' }), '');
  assert.ok(refused('style_guide', { action: 'propose' }));
  assert.ok(refused('style_guide', { action: 'export' }));
  assert.equal(refused('fb_groups', { action: 'worklist' }), '');
  assert.ok(refused('fb_groups', { action: 'mark' }));
  // (No action of `loop` stores nothing, its status included: test E.)
  for (const action of ['status', 'start', 'stop']) assert.ok(refused('loop', { action }), `loop ${action}`);
  assert.equal(refused('morelogin', { action: 'list' }), '');
  assert.ok(refused('morelogin', { action: 'use_default' }));
  // Acting on the outside world is what Bash and Edit do too: not SynaBun's store.
  for (const tool of ['browser_navigate', 'browser_click', 'bluesky_post', 'discord_message', 'gsc_inspect_url', 'youtube_download', 'leonardo_browser_generate', 'computer', 'computer_ax', 'git']) assert.equal(refused(tool, {}), '', tool);
  // A tool nobody sorted is refused: a new one that stores is closed before it is known.
  assert.ok(refused('brand_new_tool', {}));
  assert.ok(refused('agent_dispatch', { task: 'x' }));
  // The server under another name or spelling is the same server.
  assert.ok(temporaryToolRefusal('mcp__synabun__remember', {}));
  assert.ok(temporaryToolRefusal('mcp__plugin_synabun_SynaBun__reflect', {}));
  // Nothing else is this module's business.
  assert.equal(temporaryToolRefusal('Bash', { command: 'ls' }), '');
  assert.equal(temporaryToolRefusal('mcp__github__create_issue', {}), '');
  // The list the session is launched without: every tool that only stores.
  assert.deepEqual(temporaryDisallowedTools(), SYNABUN_STORE_TOOLS.map(t => `mcp__SynaBun__${t}`));
});

// ── Review of 2026-10-04 ─────────────────────────────────────────────────────

// Every tool SynaBun's MCP server registers, read from its source.
function registeredTools() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'mcp-server', 'src');
  const names = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { walk(join(dir, entry.name)); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      for (const m of readFileSync(join(dir, entry.name), 'utf8').matchAll(/\.tool\(\s*'([a-z0-9_]+)'/g)) names.add(m[1]);
    }
  };
  walk(root);
  return names;
}

test('R4: a tool a temporary chat may call stores nothing in SynaBun', () => {
  const refused = (name, input) => temporaryToolRefusal(`mcp__SynaBun__${name}`, input);
  // Found by reading the handlers (mcp-server/src/tools): each writes into SynaBun's stores as a side effect.
  // youtube_upload records the upload as a memory in youtube-videos, and can create that category.
  assert.match(refused('youtube_upload', { filePath: '/x.mp4', title: 'A trailer', game: 'A game' }), /temporary chat/i);
  assert.match(refused('youtube_upload', { filePath: '/x.mp4', title: 'A trailer' }), /temporary chat/i, 'with or without the identity it records');
  assert.ok(SYNABUN_STORE_TOOLS.includes('youtube_upload'), 'and it is not in the session at all');
  // leonardo_browser_reference deletes the staged images from SynaBun's image store unless told not to.
  assert.match(refused('leonardo_browser_reference', { type: 'image_reference', filePaths: ['/x.png'] }), /autoClear/);
  assert.ok(refused('leonardo_browser_reference', { filePaths: ['/x.png'], autoClear: true }));
  assert.equal(refused('leonardo_browser_reference', { filePaths: ['/x.png'], autoClear: false }), '');
  // profile `set` writes the runtime's profile; `get` reads it.
  assert.match(refused('profile', { action: 'set', profile: 'full' }), /temporary chat/i);
  assert.ok(refused('profile', {}), 'an action nobody named is not a reading one');
  assert.equal(refused('profile', { action: 'get' }), '');

  // The allowed list is a list of names, each put there after its handler was read:
  // no tool is allowed for how its name begins.
  const allowed = temporary.temporaryAllowedTools();
  const byInput = temporary.temporaryToolsByInput();
  for (const storing of ['youtube_upload', 'leonardo_browser_reference', 'profile', ...SYNABUN_STORE_TOOLS]) assert.ok(!allowed.includes(storing), `${storing} is not on the allowed list`);
  for (const invented of ['browser_brand_new', 'youtube_brand_new', 'bluesky_brand_new', 'discord_brand_new', 'gsc_brand_new', 'leonardo_brand_new', 'computer_brand_new', 'git_push']) {
    assert.ok(refused(invented, {}), `${invented} is refused until someone reads its handler`);
  }
  for (const name of allowed) assert.equal(refused(name, {}), '', name);
  for (const name of byInput) assert.ok(refused(name, { action: 'something-nobody-listed', autoClear: true }), `${name} depends on what it is asked`);
  // The list was sorted against the tools the server really has: no name on it is a stale one,
  // and a tool of the server that nobody sorted is refused.
  const registered = registeredTools();
  assert.ok(registered.size > 100, 'the server\'s tools were found');
  for (const name of [...allowed, ...byInput, ...SYNABUN_STORE_TOOLS]) assert.ok(registered.has(name), `${name} is a tool of SynaBun's server`);
  for (const name of registered) {
    if (allowed.includes(name) || byInput.includes(name)) continue;
    assert.ok(refused(name, {}), `${name} is not sorted, so it is refused`);
  }
});

test('R5: SynaBun\'s server gets the same rules under any name, for the session and for a subagent', async () => {
  const { queries } = configure();
  const { client, close } = connect();
  const SYNABUN = { type: 'http', url: 'http://localhost:1/mcp' }; // deps.mcpUrl of configure()
  try {
    // The tab added the same endpoint itself, as "Memory" (the /mcp editor), next to another server.
    client({ type: 'query', prompt: 'hello', windowId: 'w-5', cwd: process.cwd(), temporary: true,
      session: { mcpServers: [{ name: 'Memory', url: 'http://127.0.0.1:1/mcp' }, { name: 'tickets', url: 'https://tickets.example/mcp' }] } });
    await until(() => queries.length === 1);
    const q = queries[0];
    const o = q.options;
    // Known at launch by its address: its storing tools are not in the session, as SynaBun's are not.
    for (const tool of SYNABUN_STORE_TOOLS) {
      assert.ok(o.disallowedTools.includes(`mcp__Memory__${tool}`), `mcp__Memory__${tool} is removed from the session`);
      assert.ok(!o.disallowedTools.includes(`mcp__tickets__${tool}`), 'another server is left alone');
    }
    const pre = o.hooks.PreToolUse.at(-1).hooks[0];
    const denied = async (input) => (await pre(input)).hookSpecificOutput?.permissionDecision === 'deny';
    const reason = async (input) => (await pre(input)).hookSpecificOutput?.permissionDecisionReason || '';

    // What the process reports about its connections (the SDK's MCP status): the name each
    // server gave in the MCP handshake, and where it connects.
    q.mcpServerStatus = async () => [
      { name: 'SynaBun', status: 'connected', serverInfo: { name: 'claude-memory', version: '2.0.0' }, config: SYNABUN },
      { name: 'Memory', status: 'connected', serverInfo: { name: 'claude-memory', version: '2.0.0' }, config: { type: 'http', url: 'http://127.0.0.1:1/mcp' } },
      { name: 'Notes', status: 'connected', serverInfo: { name: 'claude-memory', version: '2.0.0' }, config: { type: 'stdio', command: 'node', args: ['/somewhere/run.mjs'] } },
      { name: 'plugin:kb:store', status: 'connected', serverInfo: { name: 'claude-memory', version: '2.0.0' }, config: { type: 'http', url: 'https://tunnel.example/mcp' } },
      { name: 'Local', status: 'connected', config: { type: 'http', url: 'http://[::1]:1/mcp/' } },
      { name: 'tickets', status: 'connected', serverInfo: { name: 'ticket-desk', version: '1.0.0' }, config: { type: 'http', url: 'https://tickets.example/mcp' } },
      { name: 'silent', status: 'connected', config: { type: 'stdio', command: 'x' } },
      { name: 'claude.ai Docs Hub', status: 'connected', serverInfo: { name: 'docs', version: '1' }, config: { type: 'claudeai-proxy', url: 'https://mcp.example/docs', id: 'x' } },
    ];
    // The reviewer's sequence: the same server as "Memory". Storing is refused, for the session…
    assert.ok(await denied({ tool_name: 'mcp__Memory__remember', tool_input: { content: 'x' } }));
    assert.match(await reason({ tool_name: 'mcp__Memory__reflect', tool_input: {} }), /temporary chat/i);
    // …and for a subagent that uses the connection.
    assert.ok(await denied({ tool_name: 'mcp__Memory__remember', tool_input: { content: 'x' }, agent_id: 'agent-1', agent_type: 'general-purpose' }));
    assert.ok(await denied({ tool_name: 'mcp__Memory__category', tool_input: { action: 'create', name: 'x' }, agent_id: 'agent-1', agent_type: 'general-purpose' }));
    // The same rules, not a closed door: reading works under that name too.
    assert.deepEqual(await pre({ tool_name: 'mcp__Memory__recall', tool_input: { query: 'x' } }), {});
    assert.deepEqual(await pre({ tool_name: 'mcp__Memory__category', tool_input: { action: 'list' }, agent_id: 'agent-1' }), {});
    // Known by the handshake alone (a stdio entry, a tunnel, a plugin's server), or by the address alone.
    assert.ok(await denied({ tool_name: 'mcp__Notes__remember', tool_input: {} }));
    assert.ok(await denied({ tool_name: 'mcp__plugin_kb_store__forget', tool_input: {}, mcp_server: { name: 'plugin:kb:store', source: 'plugin' } }));
    assert.ok(await denied({ tool_name: 'mcp__plugin_kb_store__forget', tool_input: {} }), 'also without the provenance field');
    assert.ok(await denied({ tool_name: 'mcp__Local__remember', tool_input: {} }));
    assert.deepEqual(await pre({ tool_name: 'mcp__Local__recall', tool_input: {} }), {});
    // A server that is not SynaBun's is none of this module's business.
    assert.deepEqual(await pre({ tool_name: 'mcp__tickets__create_issue', tool_input: {} }), {});
    assert.deepEqual(await pre({ tool_name: 'mcp__tickets__remember', tool_input: {} }), {}, 'a tool of another server that happens to be called remember');
    assert.deepEqual(await pre({ tool_name: 'mcp__claude_ai_Docs_Hub__batch', tool_input: {} }), {});
    assert.deepEqual(await pre({ tool_name: 'Bash', tool_input: { command: 'ls' } }), {});
    // A connection that cannot be identified when its tool is called: refused, whatever the tool.
    assert.match(await reason({ tool_name: 'mcp__silent__anything', tool_input: {} }), /cannot be identified/i);
    assert.match(await reason({ tool_name: 'mcp__nobody__remember', tool_input: {} }), /cannot be identified/i);
    assert.ok(await denied({ tool_name: 'mcp__nobody__remember', tool_input: {}, agent_id: 'agent-2' }));
    // The process does not answer, or answers nonsense: what was seen before still closes
    // SynaBun's server, and nothing is cleared on a guess.
    q.mcpServerStatus = async () => { throw new Error('closed'); };
    assert.ok(await denied({ tool_name: 'mcp__Memory__remember', tool_input: {} }));
    assert.deepEqual(await pre({ tool_name: 'mcp__Memory__recall', tool_input: {} }), {}, 'the connection it knew as SynaBun\'s keeps SynaBun\'s rules');
    assert.match(await reason({ tool_name: 'mcp__tickets__create_issue', tool_input: {} }), /cannot be identified/i);
    q.mcpServerStatus = async () => 'nonsense';
    assert.match(await reason({ tool_name: 'mcp__tickets__create_issue', tool_input: {} }), /cannot be identified/i);
    // A check that fails for a reason of its own never lets the call through.
    q.mcpServerStatus = async () => [{ name: 'tickets', status: 'connected', get serverInfo() { throw new Error('broken'); } }];
    assert.ok(await denied({ tool_name: 'mcp__tickets__create_issue', tool_input: {} }));
    assert.deepEqual(await pre({ tool_name: 'Read', tool_input: { file_path: '/x' } }), {}, 'a tool that is not an MCP tool is never held up');
    // SynaBun's own entry needs no question: recall works whatever the process answers.
    assert.deepEqual(await pre({ tool_name: 'mcp__SynaBun__recall', tool_input: { query: 'x' } }), {});
    assert.ok(await denied({ tool_name: 'mcp__SynaBun__remember', tool_input: {} }));
  } finally { close(); shutdownAllBridges(); }
});

test('R5: a connection is told by what it is, never by what it is called', () => {
  const at = { mcpUrl: 'http://localhost:3344/mcp' };
  const id = (entry) => temporary.identifyMcpServer(entry, at);
  assert.equal(temporary.SYNABUN_SERVER_NAME, 'claude-memory');
  assert.match(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'mcp-server', 'src', 'index.ts'), 'utf8'), /new McpServer\(\s*\{ name: 'claude-memory'/, 'the name SynaBun\'s server gives in the handshake');
  // The handshake.
  assert.equal(id({ name: 'Memory', status: 'connected', serverInfo: { name: 'claude-memory', version: '2.0.0' } }), 'synabun');
  // The address: the same port and path on this machine, however the host is written.
  for (const url of ['http://localhost:3344/mcp', 'http://127.0.0.1:3344/mcp', 'http://[::1]:3344/mcp/', 'http://LOCALHOST:3344/mcp?x=1']) {
    assert.equal(id({ name: 'x', status: 'connected', config: { type: 'http', url } }), 'synabun', url);
  }
  assert.equal(id({ name: 'x', status: 'pending', config: { type: 'sse', url: 'http://localhost:3344/mcp' } }), 'synabun', 'before it has connected, too');
  // Another server: only one that said who it is.
  assert.equal(id({ name: 'synabun-like', status: 'connected', serverInfo: { name: 'other', version: '1' }, config: { type: 'http', url: 'http://localhost:9999/mcp' } }), 'other');
  assert.equal(id({ name: 'x', status: 'connected', serverInfo: { name: 'other', version: '1' }, config: { type: 'http', url: 'http://localhost:3344/other' } }), 'other');
  // Not known: no handshake name and no address of SynaBun's.
  for (const entry of [null, {}, { name: 'x', status: 'connected' }, { name: 'x', status: 'connected', config: { type: 'http', url: 'http://localhost:9999/mcp' } }, { name: 'x', status: 'failed', serverInfo: {} }]) {
    assert.equal(id(entry), '', JSON.stringify(entry));
  }
  // The server a tool belongs to: Claude Code's spelling of the configured name, the longest match.
  const servers = [{ name: 'a' }, { name: 'a__b' }, { name: 'plugin:kb:store' }, { name: 'claude.ai Docs Hub' }];
  assert.deepEqual(temporary.mcpServerOfTool('mcp__a__b__remember', servers), { entry: servers[1], tool: 'remember' });
  assert.deepEqual(temporary.mcpServerOfTool('mcp__a__recall', servers), { entry: servers[0], tool: 'recall' });
  assert.deepEqual(temporary.mcpServerOfTool('mcp__plugin_kb_store__query-docs', servers), { entry: servers[2], tool: 'query-docs' });
  assert.deepEqual(temporary.mcpServerOfTool('mcp__claude_ai_Docs_Hub__batch', servers), { entry: servers[3], tool: 'batch' });
  // What Claude Code itself says about a call (the hook's `mcp_server`) decides, however it spelled the name.
  assert.deepEqual(temporary.mcpServerOfTool('mcp__some_other_spelling__remember', servers, { name: 'plugin:kb:store', source: 'plugin' }), { entry: servers[2], tool: 'remember' });
  assert.deepEqual(temporary.mcpServerOfTool('mcp__a__b__remember', servers, { name: 'a', source: 'user' }), { entry: servers[0], tool: 'b__remember' });
  assert.equal(temporary.mcpServerOfTool('mcp__a__recall', servers, { name: 'not-in-the-status', source: 'user' }), null);
  assert.equal(temporary.mcpServerOfTool('mcp__unknown__tool', servers), null);
});

// A temporary chat that wrote one plan file, under a Claude config folder of its own.
async function planSession({ cwd, settings } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cp-temp-')));
  const plans = join(dir, 'plans');
  mkdirSync(plans);
  if (settings) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  const { queries } = configure({ claudeAccountEnv: (id) => (id === 'work' ? { CLAUDE_CONFIG_DIR: dir } : null) });
  const page = connect();
  page.client({ type: 'query', prompt: 'plan it', windowId: `w-${Math.random()}`, temporary: true, accountId: 'work', ...(cwd ? { cwd } : {}) });
  await until(() => queries.length === 1);
  const q = queries[0];
  q.emit(init('s-plan'));
  const wrote = async (file) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# Plan');
    const seen = page.of('event').length;
    q.emit({ type: 'assistant', session_id: 's-plan', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t-${Math.random()}`, name: 'Write', input: { file_path: file, content: '# Plan' } }] } });
    await until(() => page.of('event').length > seen);
  };
  return { dir, plans, q, page, wrote, cleanup: () => { shutdownAllBridges(); rmSync(dir, { recursive: true, force: true }); } };
}

test('R7: a plan file is removed after the session\'s process has ended, not before', async () => {
  const s = await planSession();
  try {
    const mine = join(s.plans, 'plan-it-quiet-otter.md');
    await s.wrote(mine);
    // The page goes away while the process is still writing: it takes its time to end.
    s.q.held = true;
    s.page.close();
    assert.equal(s.q.options.abortController.signal.aborted, true, 'the process was told to end');
    await tick(40);
    assert.equal(existsSync(mine), true, 'nothing is removed while the process may still write');
    writeFileSync(mine, '# Plan, written again by the write that was under way');
    s.q.exit();
    await until(() => !existsSync(mine));
  } finally { s.cleanup(); }
});

test('R7: a plan file that cannot be removed is kept on the list and removed at the next chance', async () => {
  const s = await planSession();
  const mine = join(s.plans, 'plan-it-stuck.md');
  try {
    await s.wrote(mine);
    chmodSync(s.plans, 0o555); // the folder refuses the removal
    s.page.close();
    await tick(60);
    assert.equal(existsSync(mine), true, 'the removal failed');
    chmodSync(s.plans, 0o755);
    // The next chance: the server shuts down.
    shutdownAllBridges();
    assert.equal(existsSync(mine), false, 'it was not forgotten');
  } finally { try { chmodSync(s.plans, 0o755); } catch {} s.cleanup(); }
});

// ── Second round (the confirmation review of 2026-10-04): rules D and E ──

test('D: a plan file written late is still removed', async () => {
  const s = await planSession();
  try {
    const mine = join(s.plans, 'plan-it-slow-heron.md');
    await s.wrote(mine);
    // The chat ends and the pump of its process settles: the first removal.
    s.page.close();
    await until(() => !existsSync(mine));
    const removedAt = Date.now();
    // The SDK's own cleanup stops waiting for the process after two seconds; the process is signalled then
    // and may live up to five more. A write that was slow puts the file back three seconds after the removal.
    await tick(3000);
    writeFileSync(mine, '# Plan, by the write that was slow');
    // The path is still owed: one more sweep runs after the longest time the SDK lets the process live.
    const gone = await until(() => !existsSync(mine), 7000).then(() => true, () => false);
    assert.equal(gone, true, 'the plan file written three seconds after the first removal is removed by the second sweep');
    // After that sweep the path is owed no longer: a file of that name written later is someone else's.
    // (Nine seconds after the first removal: the SDK lets the process live seven, and any sweep before the
    // path's own last one, another session's included, removes the file and keeps the path.)
    await tick(Math.max(0, removedAt + 9000 - Date.now()));
    writeFileSync(mine, '# A plan of another conversation');
    shutdownAllBridges();
    assert.equal(existsSync(mine), true, 'nothing is removed for a session whose process can no longer be alive');
  } finally { s.cleanup(); }
});

test('D: a plan file that was not there at the first removal is removed when it appears, and at shutdown at the latest', async () => {
  const s = await planSession();
  try {
    const mine = join(s.plans, 'plan-it-late-wren.md');
    await s.wrote(mine);
    rmSync(mine); // the tool call named it, the write has not landed yet
    s.page.close();
    await tick(60); // the first removal found nothing
    writeFileSync(mine, '# Plan, by the write that was slow');
    // The server shuts down before the second sweep: the path was not forgotten.
    shutdownAllBridges();
    assert.equal(existsSync(mine), false, 'a removal that found nothing does not forget the path');
  } finally { s.cleanup(); }
});

test('E: the loop tool is not one that stores nothing, so a temporary chat does not have it', async () => {
  const refused = (name, input) => temporaryToolRefusal(`mcp__SynaBun__${name}`, input);
  // Its status action creates SynaBun's loop data folder when that does not exist (handleStatus →
  // resolveSessionId → ensureLoopDir in mcp-server/src/tools/loop.ts); start and stop write the loop's state.
  for (const input of [{ action: 'status' }, { action: 'status', session_id: 's-1' }, { action: 'start', task: 'x' }, { action: 'stop' }, {}]) {
    assert.match(refused('loop', input), /temporary chat/i, JSON.stringify(input));
  }
  assert.match(refused('loop', { action: 'status' }), /loop data/i, 'with its reason');
  assert.ok(!temporary.temporaryAllowedTools().includes('loop') && !temporary.temporaryToolsByInput().includes('loop'), 'on no list of what it may call');
  assert.ok(SYNABUN_STORE_TOOLS.includes('loop'), 'it is with the tools that store');
  assert.match(temporary.synabunToolRefusal('loop', { action: 'status' }), /temporary chat/i, 'under any name of the connection');
  // And it is not in the session at all.
  const { queries } = configure();
  const { client, close } = connect();
  try {
    client({ type: 'query', prompt: 'hello', windowId: 'w-loop', temporary: true });
    await until(() => queries.length === 1);
    assert.ok(queries[0].options.disallowedTools.includes('mcp__SynaBun__loop'));
    const pre = queries[0].options.hooks.PreToolUse.at(-1).hooks[0];
    const denied = await pre({ tool_name: 'mcp__SynaBun__loop', tool_input: { action: 'status' } });
    assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny');
  } finally { close(); shutdownAllBridges(); }
});

test('R7: plan files are removed from the folder the Claude settings name', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'cp-temp-project-')));
  mkdirSync(join(project, '.claude'));
  writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ plansDirectory: 'docs/plans' }));
  const s = await planSession({ cwd: project });
  try {
    const mine = join(project, 'docs', 'plans', 'plan-it.md');
    const older = join(project, 'docs', 'plans', 'someone-elses.md');
    const elsewhere = join(project, 'docs', 'notes.md');
    mkdirSync(dirname(mine), { recursive: true });
    writeFileSync(older, 'an older plan');
    const { utimesSync } = await import('node:fs');
    void utimesSync;
    await s.wrote(mine);
    await s.wrote(elsewhere);
    s.q.emit({ type: 'assistant', session_id: 's-plan', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't-exit', name: 'ExitPlanMode', input: { plan: '# Plan', planFilePath: mine } }] } });
    s.page.close();
    await until(() => !existsSync(mine));
    assert.equal(existsSync(elsewhere), true, 'a file next to the plans folder is not a plan');
    assert.equal(existsSync(older), true);
  } finally { s.cleanup(); rmSync(project, { recursive: true, force: true }); }

  // Where Claude Code writes plans for a process: its own plans folder, and the folder a settings file
  // names instead (relative to the project root, and only inside it), whichever layer names it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cp-temp-root-')));
  const config = realpathSync(mkdtempSync(join(tmpdir(), 'cp-temp-config-')));
  try {
    const env = { CLAUDE_CONFIG_DIR: config };
    assert.deepEqual(temporary.plansDirsOf(env, { cwd: root }), [join(config, 'plans')]);
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ plansDirectory: 'from-user' }));
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ plansDirectory: './from-project/' }));
    writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({ plansDirectory: '../outside-the-project' }));
    assert.deepEqual(temporary.plansDirsOf(env, { cwd: root, settings: { plansDirectory: 'from-flags' } }).sort(),
      [join(config, 'plans'), join(root, 'from-user'), join(root, 'from-project'), join(root, 'from-flags')].sort());
    // A settings file that is not JSON, or names something that is not a folder name, changes nothing.
    writeFileSync(join(root, '.claude', 'settings.json'), '{ not json');
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ plansDirectory: 42 }));
    assert.deepEqual(temporary.plansDirsOf(env, { cwd: root }), [join(config, 'plans')]);
    // The plan file of a tool call: a Markdown file directly in one of those folders.
    const dirs = [join(config, 'plans'), join(root, 'from-project')];
    mkdirSync(dirs[0]); mkdirSync(dirs[1]);
    const call = (file_path) => ({ type: 'tool_use', name: 'Write', input: { file_path } });
    assert.equal(temporary.planFileOfToolCall(call(join(dirs[1], 'p.md')), dirs), join(dirs[1], 'p.md'));
    assert.equal(temporary.planFileOfToolCall(call(join(dirs[0], 'p.md')), dirs), join(dirs[0], 'p.md'));
    assert.equal(temporary.planFileOfToolCall(call(join(root, 'p.md')), dirs), '');
    assert.equal(temporary.planFileOfToolCall(call(join(dirs[1], 'sub', 'p.md')), dirs), '');
    assert.equal(temporary.planFileOfToolCall(call(join(dirs[1], 'p.txt')), dirs), '');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(config, { recursive: true, force: true }); }
});

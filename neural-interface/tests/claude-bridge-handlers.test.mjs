import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { ClaudeSession, configureClaudeBridge } from '../lib/claude-agent-bridge.js';

// The bridge's message handlers that had no test by name: compact, permission
// mode, MCP status, the session lock, skill injection, cost accounting, the
// generic permission answer, abort. Run on a session built without the panel
// flag: this is the behaviour every caller of ClaudeSession relies on. Plus the
// public API the Assistant brain uses instead of the session's fields.

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
  q.interrupt = async () => { q.calls.push(['interrupt']); };
  q.setPermissionMode = async (mode) => { q.calls.push(['setPermissionMode', mode]); if (mode === 'bypassPermissions') throw new Error('bypass is not allowed here'); };
  q.setModel = async (model) => { q.calls.push(['setModel', model]); if (model === 'no-such-model') throw new Error('unknown model'); };
  q.applyFlagSettings = async (s) => { q.calls.push(['applyFlagSettings', s]); };
  q.supportedCommands = async () => [];
  q.mcpServerStatus = async () => [{ name: 'SynaBun', status: 'connected' }];
  (async () => { for await (const m of prompt) q.pushed.push(m); finish(); })();
  options.abortController?.signal.addEventListener('abort', finish, { once: true });
  return q;
}

function harness(overrides = {}, opts = {}) {
  const queries = [];
  const cost = { added: [], stored: 0 };
  const locks = [];
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(),
    includePartialMessages: false,
    queryFactory: (args) => { const q = scriptedQuery(args); queries.push(q); return q; },
    acquireSessionLock: (sid, wid) => { locks.push([sid, wid]); return { ok: true }; },
    heartbeatLock: (sid, wid) => { locks.push(['beat', sid, wid]); },
    releaseAllLocks: () => {},
    getSessionCost: () => cost.stored,
    addCost: (delta, sid) => cost.added.push([Number(delta.toFixed(4)), sid]),
    maybeInjectSkillPrompt: (prompt) => ({ prompt }),
    toCliModelName: (model) => model.split(':').pop(),
    writePlanFile: () => ({ ok: false }),
    ...overrides,
  });
  const sent = [];
  const ws = { readyState: 1, bufferedAmount: 0, send: (data) => sent.push(JSON.parse(data)) };
  return { session: new ClaudeSession(ws, opts), queries, sent, cost, locks };
}

async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 5));
  }
}
const events = (sent, type, subtype) => sent.filter(p => p.type === 'event' && p.event?.type === type && (!subtype || p.event.subtype === subtype)).map(p => p.event);
const result = (extra = {}) => ({ type: 'result', subtype: 'success', session_id: 's1', usage: {}, modelUsage: {}, queued_turn_count: 0, ...extra });

test('compact announces itself and sends /compact as a turn', async () => {
  const { session, queries, sent } = harness();
  try {
    await session.handleMessage({ type: 'compact' });
    await until(() => queries[0]?.pushed.length === 1);
    assert.equal(queries[0].pushed[0].message.content[0].text, '/compact');
    assert.equal(events(sent, 'system', 'compact_started').length, 1);
    assert.equal(session.inTurn, true);
  } finally { session.destroy(); }
});

test('set_permission_mode: applied live, announced, an unknown mode ignored, a refusal reported', async () => {
  const { session, queries, sent } = harness();
  try {
    await session.handleMessage({ type: 'set_permission_mode', mode: 'acceptEdits' });
    assert.equal(session.permissionMode, 'acceptEdits', 'kept for the next query when none is live');
    assert.deepEqual(sent.at(-1), { type: 'event', event: { type: 'mode_changed', mode: 'acceptEdits' } });

    session.ensureQuery();
    await session.handleMessage({ type: 'set_permission_mode', mode: 'plan' });
    assert.deepEqual(queries[0].calls.at(-1), ['setPermissionMode', 'plan']);
    const before = sent.length;
    await session.handleMessage({ type: 'set_permission_mode', mode: 'yolo' });
    assert.equal(sent.length, before);
    assert.equal(session.permissionMode, 'plan');

    await session.handleMessage({ type: 'set_permission_mode', mode: 'bypassPermissions' });
    assert.deepEqual(sent.at(-1), { type: 'error', message: 'Could not switch permission mode: bypass is not allowed here' });
  } finally { session.destroy(); }
});

test('mcp_status answers from the live query, and with an empty list without one', async () => {
  const { session, sent } = harness();
  try {
    await session.handleMessage({ type: 'mcp_status' });
    assert.deepEqual(events(sent, 'system', 'mcp_status')[0].servers, []);
    session.ensureQuery();
    await session.handleMessage({ type: 'mcp_status' });
    assert.deepEqual(events(sent, 'system', 'mcp_status')[1].servers, [{ name: 'SynaBun', status: 'connected' }]);
  } finally { session.destroy(); }
});

test('a session locked by another window refuses the prompt; a heartbeat keeps the lock', async () => {
  const { session, queries, sent, locks } = harness({ acquireSessionLock: () => ({ ok: false, owner: 'other-window' }) });
  try {
    session._handleQuery({ prompt: 'hello', sessionId: 's-locked', windowId: 'w1' });
    assert.deepEqual(sent.at(-1), { type: 'error', message: 'Session locked by another window' });
    assert.equal(queries.length, 0, 'nothing was started');
    await session.handleMessage({ type: 'heartbeat', windowId: 'w1', sessionId: 's-locked' });
    assert.deepEqual(locks.at(-1), ['beat', 's-locked', 'w1']);
  } finally { session.destroy(); }
});

test('a prompt needs content; a SynaBun skill command is expanded before it is sent', async () => {
  const { session, queries, sent } = harness({
    maybeInjectSkillPrompt: (prompt) => (prompt.startsWith('/synabun') ? { command: 'synabun', skill: { dir: '/skills/synabun' }, prompt: 'EXPANDED SKILL PROMPT' } : { prompt }),
  });
  try {
    session._handleQuery({});
    assert.deepEqual(sent.at(-1), { type: 'error', message: 'No prompt provided' });
    session._handleQuery({ prompt: '/synabun audit', model: 'anthropic:opus' });
    await until(() => queries[0]?.pushed.length === 1);
    assert.equal(queries[0].pushed[0].message.content[0].text, 'EXPANDED SKILL PROMPT');
    assert.equal(queries[0].options.model, 'opus', 'a provider-prefixed model id is reduced to the CLI name');
    session._handleQuery({ prompt: '/doctor' });
    await until(() => queries[0].pushed.length === 2);
    assert.equal(queries[0].pushed[1].message.content[0].text, '/doctor', 'an unknown slash command passes through to the CLI');
  } finally { session.destroy(); }
});

test('cost: the cumulative total is booked as deltas, and a counter that restarted is booked whole', async () => {
  const { session, queries, sent, cost } = harness();
  try {
    session._handleQuery({ prompt: 'one' });
    await until(() => queries[0]?.pushed.length === 1);
    queries[0].emit(result({ total_cost_usd: 0.10 }));
    await until(() => sent.filter(p => p.type === 'done').length === 1);
    // (A later prompt names its session: one without an id is a new chat.)
    session._handleQuery({ prompt: 'two', sessionId: 's1' });
    queries[0].emit(result({ total_cost_usd: 0.25 }));
    await until(() => sent.filter(p => p.type === 'done').length === 2);
    assert.deepEqual(cost.added, [[0.1, 's1'], [0.15, 's1']]);
    // A new process reports from zero again.
    session._handleQuery({ prompt: 'three', sessionId: 's1' });
    queries[0].emit(result({ total_cost_usd: 0.05 }));
    await until(() => sent.filter(p => p.type === 'done').length === 3);
    assert.deepEqual(cost.added.at(-1), [0.05, 's1']);
    assert.deepEqual(sent.filter(p => p.type === 'done').map(p => p.code), [0, 0, 0]);
  } finally { session.destroy(); }
});

test('cost: a resumed session starts from what was already booked for it', async () => {
  const { session, queries, sent, cost } = harness();
  cost.stored = 2.00;
  try {
    session._handleQuery({ prompt: 'resume', sessionId: 's1' });
    await until(() => queries[0]?.pushed.length === 1);
    queries[0].emit(result({ total_cost_usd: 2.30 }));
    await until(() => sent.some(p => p.type === 'done'));
    assert.deepEqual(cost.added, [[0.3, 's1']]);
  } finally { session.destroy(); }
});

test('an error result ends the turn with code 1 and is forwarded', async () => {
  const { session, queries, sent } = harness();
  try {
    session._handleQuery({ prompt: 'x' });
    await until(() => queries[0]?.pushed.length === 1);
    queries[0].emit(result({ subtype: 'error_max_turns', errors: [], num_turns: 40 }));
    await until(() => sent.some(p => p.type === 'done'));
    assert.equal(sent.find(p => p.type === 'done').code, 1);
    assert.equal(events(sent, 'result')[0].subtype, 'error_max_turns');
  } finally { session.destroy(); }
});

test('a permission prompt: allow with an edited input, deny with a reason, and the session-wide Always of other callers', async () => {
  const { session, queries, sent } = harness();
  try {
    session.ensureQuery();
    const ask = (input) => queries[0].options.canUseTool('Bash', input, { signal: new AbortController().signal });
    const requestId = () => sent.filter(p => p.type === 'control_request').at(-1).request_id;

    const first = ask({ command: 'ls' });
    await until(() => sent.some(p => p.type === 'control_request'));
    await session.handleMessage({ type: 'control_response', request_id: requestId(), response: { subtype: 'success', response: { behavior: 'allow', updatedInput: { command: 'ls -la' } } } });
    assert.deepEqual(await first, { behavior: 'allow', updatedInput: { command: 'ls -la' } });

    const second = ask({ command: 'rm -rf x' });
    await until(() => sent.filter(p => p.type === 'control_request').length === 2);
    await session.handleMessage({ type: 'control_response', request_id: requestId(), response: { behavior: 'deny', message: 'too risky' } });
    assert.deepEqual(await second, { behavior: 'deny', message: 'too risky' });

    const third = ask({ command: 'pwd' });
    await until(() => sent.filter(p => p.type === 'control_request').length === 3);
    await session.handleMessage({ type: 'control_response', request_id: requestId(), response: { behavior: 'allow', always: true } });
    await third;
    assert.deepEqual(await ask({ command: 'whoami' }), { behavior: 'allow', updatedInput: { command: 'whoami' } }, 'no prompt: the tool was allowed for the session');
    assert.equal(sent.filter(p => p.type === 'control_request').length, 3);
    // Bookkeeping tools never prompt.
    assert.deepEqual(await queries[0].options.canUseTool('TodoWrite', { todos: [] }, { signal: new AbortController().signal }), { behavior: 'allow', updatedInput: { todos: [] } });
  } finally { session.destroy(); }
});

test('abort interrupts the turn, cancels open prompts and swallows the interrupt\'s own result', async () => {
  const { session, queries, sent } = harness();
  try {
    session._handleQuery({ prompt: 'long task' });
    await until(() => queries[0]?.pushed.length === 1);
    const pending = queries[0].options.canUseTool('Bash', { command: 'x' }, { signal: new AbortController().signal });
    await until(() => sent.some(p => p.type === 'control_request'));
    await session.handleMessage({ type: 'abort' });
    assert.deepEqual(await pending, { behavior: 'deny', message: 'Turn was interrupted' });
    assert.ok(sent.some(p => p.type === 'control_cancelled'));
    assert.deepEqual(sent.at(-1), { type: 'aborted' });
    assert.deepEqual(queries[0].calls, [['interrupt']]);
    queries[0].emit(result({ subtype: 'error_during_execution', errors: [] }));
    await until(() => events(sent, 'result').length === 1);
    assert.equal(sent.some(p => p.type === 'done'), false, 'the tab already got its terminal signal');
  } finally { session.destroy(); }
});

// ── The public API another host uses (the Assistant brain) ──

test('setModel switches the live query first, keeps the model for the next one, and never throws', async () => {
  const { session, queries } = harness();
  try {
    assert.deepEqual(await session.setModel('opus'), { ok: true, changed: true });
    assert.equal(session.model, 'opus', 'no query yet: kept for when one is created');
    assert.deepEqual(await session.setModel('opus'), { ok: true, changed: false });
    session.ensureQuery();
    assert.equal(queries[0].options.model, 'opus');
    assert.deepEqual(await session.setModel('haiku'), { ok: true, changed: true });
    assert.deepEqual(queries[0].calls.at(-1), ['setModel', 'haiku']);
    assert.deepEqual(await session.setModel('no-such-model'), { ok: false, changed: false, error: 'unknown model' });
    assert.equal(session.model, 'haiku', 'a refused switch changes nothing');
    assert.deepEqual(await session.setModel(null), { ok: true, changed: true });
    assert.deepEqual(queries[0].calls.at(-1), ['setModel', undefined], 'null goes back to the default model');
  } finally { session.destroy(); }
});

test('setPlanExitMode sets the mode an approved plan continues in; bypass only when the session allows it', () => {
  const { session } = harness();
  try {
    assert.equal(session.setPlanExitMode('acceptEdits'), 'acceptEdits');
    assert.equal(session.setPlanExitMode('bypassPermissions'), 'default', 'not without allowDangerouslySkipPermissions');
    assert.equal(session.setPlanExitMode('nonsense'), 'default');
  } finally { session.destroy(); }
  const allowed = harness({}, { allowDangerouslySkipPermissions: true });
  try { assert.equal(allowed.session.setPlanExitMode('bypassPermissions'), 'bypassPermissions'); } finally { allowed.session.destroy(); }
  // An options object the caller froze (or shares) is not written to.
  const frozen = harness({}, Object.freeze({ planExitMode: 'default' }));
  try { assert.equal(frozen.session.setPlanExitMode('acceptEdits'), 'acceptEdits'); } finally { frozen.session.destroy(); }
});

test('the Assistant brain goes through that API', async () => {
  const brain = await readFile(new URL('../lib/assistant-brains/claude.js', import.meta.url), 'utf8');
  assert.match(brain, /if \(typeof inner\.setPlanExitMode === 'function'\) inner\.setPlanExitMode\(approvalMode\);/);
  assert.match(brain, /const switched = await inner\.setModel\(want\);/);
  assert.match(brain, /if \(!switched\.ok\) sink\.send\(\{ type: 'stderr', text: `Model switch failed: \$\{switched\.error\}` \}\);/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeBypassAllowed, createClaudeBrain } from '../lib/assistant-brains/claude.js';
import { createCodexBrain } from '../lib/assistant-brains/codex.js';
import { createOpenCodeBrain } from '../lib/assistant-brains/opencode.js';

// A stand-in for ClaudeSession: records the options the brain builds.
function fakeSessionClass(seen) {
  return class FakeClaudeSession {
    constructor(socket, opts) { seen.push(opts); this.socket = socket; this.opts = opts; this.model = opts.model || null; }
    handleMessage() { return undefined; }
    destroy() {}
  };
}

test('the Claude brain marks its CLI with SYNABUN_ASSISTANT_SESSION and keeps the account env and user settings', () => {
  const seen = [];
  const sink = { send() {} };
  const session = { id: 'assistant-11111111-2222-4333-8444-555555555555', brain: { provider: 'claude-code', accountId: 'acct-1', cwd: '/tmp' } };
  const brain = createClaudeBrain({
    session, sink, persona: 'persona',
    deps: { ClaudeSession: fakeSessionClass(seen), claudeAccountEnv: (id) => (id === 'acct-1' ? { CLAUDE_CONFIG_DIR: '/tmp/acct-1' } : {}) },
  });
  assert.equal(brain.kind, 'claude-code');
  const [opts] = seen;
  assert.equal(opts.env.SYNABUN_ASSISTANT_SESSION, session.id, 'the user-level hooks see the marker');
  assert.equal(opts.env.CLAUDE_CONFIG_DIR, '/tmp/acct-1');
  assert.deepEqual(opts.settingSources, ['user']);
  assert.equal(opts.mcpHeaders['X-Synabun-Role'], 'assistant');
  assert.equal(opts.mcpHeaders['X-Synabun-Terminal'], session.id);
  // Without an account env function the marker is still set.
  const bare = [];
  createClaudeBrain({ session, sink, deps: { ClaudeSession: fakeSessionClass(bare) } });
  assert.deepEqual(bare[0].env, { SYNABUN_ASSISTANT_SESSION: session.id });
});

test('bypass as a switch target: always for a desktop session, only at the autonomous level for a WhatsApp one', () => {
  assert.equal(claudeBypassAllowed(null), true);
  assert.equal(claudeBypassAllowed('autonomous'), true);
  assert.equal(claudeBypassAllowed('ask'), false);
  assert.equal(claudeBypassAllowed('read-only'), false);
  const session = { id: 'assistant-1', brain: { provider: 'claude-code', permissionMode: 'default', cwd: '/tmp' } };
  const seen = [];
  for (const remoteLevel of [undefined, 'ask', 'read-only', 'autonomous']) {
    createClaudeBrain({ session, sink: { send() {} }, deps: { ClaudeSession: fakeSessionClass(seen), remoteLevel } });
  }
  assert.deepEqual(seen.map((opts) => opts.allowDangerouslySkipPermissions), [true, false, false, true]);
});

test('a WhatsApp Claude brain never lists computer-use tools in allowedTools (a desktop brain still does)', () => {
  const session = { id: 'assistant-2', brain: { provider: 'claude-code', permissionMode: 'default', cwd: '/tmp' } };
  const seen = [];
  for (const remoteLevel of [undefined, 'read-only', 'ask', 'autonomous']) {
    createClaudeBrain({ session, sink: { send() {} }, deps: { ClaudeSession: fakeSessionClass(seen), remoteLevel } });
  }
  const computer = (opts) => opts.allowedTools.filter((name) => /computer/i.test(name));
  assert.ok(computer(seen[0]).length > 0, 'desktop: computer use is auto-allowed');
  for (const opts of seen.slice(1)) {
    assert.deepEqual(computer(opts), [], 'remote: no computer tool is pre-approved');
    assert.ok(opts.allowedTools.includes('mcp__SynaBun__agent_route'), 'routing still never waits on a card');
  }
});

test('a Codex brain whose usage hooks throw still binds its thread and ends its turn', async () => {
  let socket = null;
  const sent = [];
  const brain = createCodexBrain({
    session: { id: 'codex-usage-1', brain: { provider: 'codex' } },
    sink: { send: (packet) => sent.push(packet) },
    deps: {
      handleCodexSkinWebSocket: (ws) => {
        socket = ws;
        ws.on('message', (raw) => { if (JSON.parse(String(raw)).type === 'bootstrap') ws.send({ type: 'ready' }); });
      },
      onCodexThread: () => { throw new Error('meter broke'); },
      onCodexUsage: () => { throw new Error('meter broke'); },
    },
  });
  await brain.start();
  // The notification that names the thread is the turn's start: a throw in the hook must not drop it.
  socket.send({ type: 'notify', threadId: 'thread-1', method: 'turn/started', params: { turn: { id: 'turn-1' } } });
  assert.equal(brain.identity().providerThreadId, 'thread-1');
  assert.equal(brain.isBusy(), true);
  socket.send({ type: 'notify', method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 5, outputTokens: 1 } } } });
  socket.send({ type: 'notify', method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(brain.isBusy(), false, 'the turn ended');
  assert.ok(sent.some((packet) => packet.type === 'done' && packet.code === 0));
  assert.deepEqual(brain.identity().usage, { total: { inputTokens: 5, outputTokens: 1 } });
  await brain.dispose();
});

test('an OpenCode resume tells the runtime its new root session', async () => {
  const roots = [];
  const brain = createOpenCodeBrain({
    session: { id: 'opencode-resume-1', brain: { provider: 'opencode' }, providerSessionId: 'session-1' },
    sink: { send() {} },
    deps: { ensureIsolatedServe: async () => null, stopIsolatedServe() {}, setupOpencodeSidepanelConfig: () => '', onOpenCodeRoot: (id) => roots.push(id) },
  });
  await brain.resume(null);
  assert.deepEqual(roots, [], 'nothing to resume');
  await brain.resume('session-2');
  assert.deepEqual(roots, ['session-2'], 'the usage meter\'s root follows the conversation');
  assert.equal(brain.identity().providerSessionId, 'session-2');
  await brain.dispose();
});

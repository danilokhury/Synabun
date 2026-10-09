import test from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeSession, configureClaudeBridge } from '../lib/claude-agent-bridge.js';
import { CLAUDE_NOT_INSTALLED, resolveClaudeSdkExecutable } from '../lib/claude-executable.js';

// Every Claude session (the side panel, the Assistant's brain) runs the user's
// own Claude Code. SynaBun carries none, so the session is given the executable
// the host resolved, and a machine without one gets a refusal the panel can show
// its install help on. The Agent SDK is never left to look for an executable.

function harness({ executable, queryFactory = 'fake', ...extra } = {}) {
  const captures = [];
  const sent = [];
  const deps = {
    PACKAGE_ROOT: process.cwd(),
    includePartialMessages: false,
    ...(executable === undefined ? {} : { claudeExecutable: typeof executable === 'function' ? executable : () => executable }),
    ...extra,
  };
  if (queryFactory === 'fake') {
    deps.queryFactory = ({ options }) => {
      captures.push(options);
      // Ends at once: these tests only look at how each Query was configured.
      const generator = (async function* () {})();
      generator.interrupt = async () => {};
      return generator;
    };
  } else if (queryFactory) {
    deps.queryFactory = queryFactory;
  }
  configureClaudeBridge(deps);
  const ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
  return { session: new ClaudeSession(ws, {}), captures, sent };
}

// process.execPath stands in for the installed Claude Code: a real, launchable binary.
const installed = () => resolveClaudeSdkExecutable({ launcher: process.execPath });

test('a session runs the installed Claude Code the host resolved', () => {
  const { session, captures } = harness({ executable: installed });
  try {
    assert.ok(session.ensureQuery());
    assert.equal(captures[0].pathToClaudeCodeExecutable, process.execPath);
    assert.equal(session._claudeExecutable, process.execPath);
    assert.equal(session._startRefused, null);
  } finally {
    session.destroy();
  }
});

test('the override from cli-config.json outranks the installed one, and a bad override is passed over aloud', () => {
  const script = new URL('./claude-bridge-executable.test.mjs', import.meta.url).pathname;
  const first = harness({ executable: () => resolveClaudeSdkExecutable({ launcher: process.execPath, sdkExecutable: script }) });
  try {
    first.session.ensureQuery();
    assert.equal(first.captures[0].pathToClaudeCodeExecutable, script);
  } finally {
    first.session.destroy();
  }

  const second = harness({ executable: () => resolveClaudeSdkExecutable({ launcher: process.execPath, sdkExecutable: 'claude' }) });
  try {
    second.session.ensureQuery();
    assert.equal(second.captures[0].pathToClaudeCodeExecutable, process.execPath, 'the installed Claude Code runs instead');
    assert.ok(second.sent.some(m => m.type === 'stderr' && /Ignoring sdkExecutable override/.test(m.text) && /bare command name/.test(m.text)));
  } finally {
    second.session.destroy();
  }
});

test('without Claude Code the start is refused with the install phrase, and nothing is started', () => {
  const missing = resolveClaudeSdkExecutable({ launcher: 'claude' });
  assert.equal(missing.path, null);
  const { session, captures, sent } = harness({ executable: missing });
  try {
    assert.equal(session.ensureQuery(), null);
    assert.equal(captures.length, 0, 'no process, no SDK call');
    assert.deepEqual(session._startRefused, { code: 'claude_not_installed', message: CLAUDE_NOT_INSTALLED });
    // What a prompt sent in this state gets back: one error the panel recognises, and the end of the turn.
    assert.equal(session._pushUserText('hello'), false);
    const error = sent.find(m => m.type === 'error');
    assert.equal(error.code, 'claude_not_installed');
    // ui-claude-panel.js shows its install help on this phrase.
    assert.match(error.message, /Claude CLI not found/);
    assert.ok(sent.some(m => m.type === 'done' && m.code === -1));
    assert.equal(session.inTurn, false);
  } finally {
    session.destroy();
  }
});

test('a resolver that throws or answers nothing is a refusal too, never a silent default', () => {
  for (const executable of [() => { throw new Error('boom'); }, () => null, () => ({ path: '' })]) {
    const { session, captures } = harness({ executable });
    try {
      assert.equal(session.ensureQuery(), null);
      assert.equal(session._startRefused.code, 'claude_not_installed');
      assert.equal(captures.length, 0);
    } finally {
      session.destroy();
    }
  }
});

test('the reason a found installation cannot be used reaches the user', () => {
  const reason = 'Claude Code was found at C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd, but not the program that command runs.';
  const { session, sent } = harness({ executable: { path: null, reason } });
  try {
    session.ensureQuery();
    session._announceRefusedStart();
    assert.equal(sent.find(m => m.type === 'error').message, reason);
  } finally {
    session.destroy();
  }
});

test('the real SDK is never called without an executable, even by a host that names no resolver', () => {
  // No queryFactory: this bridge would call the Agent SDK itself. With nothing to
  // hand it, it must not: the SDK would go looking inside its own packages.
  const { session } = harness({ queryFactory: null });
  try {
    assert.equal(session.ensureQuery(), null);
    assert.equal(session._startRefused.code, 'claude_not_installed');
    assert.equal(session.q, null);
  } finally {
    session.destroy();
  }
});

test('a host with its own query factory and no resolver starts as before (tests, stand-ins)', () => {
  const { session, captures } = harness({});
  try {
    assert.ok(session.ensureQuery());
    assert.equal(captures[0].pathToClaudeCodeExecutable, undefined);
  } finally {
    session.destroy();
  }
});

test('an installation that will not launch ends the turn with what is wrong with it, and tries nothing else', async () => {
  const { session, captures, sent } = harness({ executable: installed });
  try {
    session.ensureQuery();
    session.inTurn = true;
    session._recoverNativeRuntime(Object.assign(new Error('spawn /nowhere/claude ENOENT'), { code: 'ENOENT' }));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(captures.length, 1, 'there is no other runtime to move to: nothing is started again');
    const error = sent.find(m => m.type === 'error');
    assert.ok(error, 'the turn ends with an error');
    assert.doesNotMatch(error.message, /bundled/i);
    assert.match(error.message, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(sent.some(m => m.type === 'done' && m.code === -1));
    assert.equal(session.inTurn, false);
  } finally {
    session.destroy();
  }
});

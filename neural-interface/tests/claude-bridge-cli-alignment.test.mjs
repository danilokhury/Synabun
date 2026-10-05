import test from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeSession, configureClaudeBridge } from '../lib/claude-agent-bridge.js';
import { alignedClaudeExecutable, clearClaudeModelCache } from '../lib/claude-model-catalog.js';

// Sidepanel sessions default to the Agent SDK's bundled Claude CLI, while the model
// picker lists the installed CLI's models. When the installed CLI is newer, the same
// alias ("opus[1m]") names a newer model there — Opus 5.5 on 2.1.280, Opus 5 on the
// bundled 2.1.278 — so the session has to run the installed CLI, and fall back to
// the bundled runtime if that one will not launch.

const NEWER = { skewed: true, installedNewer: true };

function harness({ aligned } = {}) {
  const captures = [];
  const sent = [];
  configureClaudeBridge({
    PACKAGE_ROOT: process.cwd(),
    includePartialMessages: false,
    queryFactory: ({ options }) => {
      captures.push(options);
      // Ends at once: these tests only look at how each Query was configured.
      const generator = (async function* () {})();
      generator.interrupt = async () => {};
      return generator;
    },
    alignedClaudeBin: aligned,
  });
  const ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
  return { session: new ClaudeSession(ws, {}), captures, sent };
}

async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 10));
  }
}

test('a session runs the installed CLI when it is newer than the bundled one', () => {
  clearClaudeModelCache();
  // process.execPath stands in for the installed CLI: a real, launchable binary.
  const { session, captures } = harness({
    aligned: () => alignedClaudeExecutable(process.execPath, { skew: NEWER }),
  });
  try {
    session.ensureQuery();
    assert.equal(captures[0].pathToClaudeCodeExecutable, process.execPath);
  } finally {
    session.destroy();
    clearClaudeModelCache();
  }
});

test('with nothing to align to, the SDK resolves its bundled CLI itself', () => {
  const { session, captures } = harness({ aligned: () => null });
  try {
    session.ensureQuery();
    assert.equal(captures[0].pathToClaudeCodeExecutable, undefined);
  } finally {
    session.destroy();
  }
});

test('an aligned CLI that will not launch is latched off and the session moves to the bundled runtime', async () => {
  clearClaudeModelCache();
  const { session, captures, sent } = harness({
    aligned: () => alignedClaudeExecutable(process.execPath, { skew: NEWER }),
  });
  try {
    session.ensureQuery();
    assert.equal(captures[0].pathToClaudeCodeExecutable, process.execPath);

    session._recoverNativeRuntime(
      Object.assign(new Error(`spawn ${process.execPath} ENOENT`), { code: 'ENOENT' }),
    );
    await until(() => captures.length === 2);
    assert.equal(captures[1].pathToClaudeCodeExecutable, undefined, 'the retry runs on the bundled runtime');
    assert.ok(
      sent.some(m => m.type === 'event'
        && m.event?.subtype === 'runtime_notice'
        && /failed to launch/.test(m.event.message)),
      'the user is told why the runtime changed',
    );
    // The latch is process-wide: later sessions do not try the same binary again.
    assert.equal(alignedClaudeExecutable(process.execPath, { skew: NEWER }), null);
  } finally {
    session.destroy();
    clearClaudeModelCache();
  }
});

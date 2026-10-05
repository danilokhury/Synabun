// The OpenCode panel's rendering and wiring code has no browser test in the
// Node suite. This runs it under a DOM stand-in: every module is imported,
// the renderer, the widgets and the composer are mounted, a transcript with
// every part type and card is rendered, every control is clicked, keys are
// typed and bus events are pushed through the socket layer. Any exception
// (an undefined name, a missing export, a call on the wrong object) fails it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runSmoke(server) {
  const script = fileURLToPath(new URL('./opencode-panel-smoke.run.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, SYNABUN_TYPESAFE: 'off', OCP_SMOKE_SERVER: server },
  });
  const stdout = String(result.stdout || '');
  const output = `${stdout}\n${result.stderr || ''}`;
  assert.equal(result.status, 0, output.slice(-3000));
  const steps = stdout.split('\n').filter((line) => /^(ok  |FAIL) /.test(line));
  assert.ok(steps.length >= 15, `ran ${steps.length} steps`);
  assert.deepEqual(steps.filter((line) => line.startsWith('FAIL')), []);
  // The verdict is the last line of stdout (warnings from the stand-in's gaps go to stderr).
  assert.match(stdout, /\nno problems\s*$/, output.slice(-3000));
  return stdout;
}

test('the OpenCode panel modules load, mount, render and take input without throwing', () => {
  const stdout = runSmoke('new');
  assert.match(stdout, /capabilities: \d+/);
});

// The panel is served statically and reloads before the server is restarted:
// against a server that advertises nothing it must work and must not send a
// request type that server answers with "unknown message type".
test('the same run against a server that predates the capability list', () => {
  const stdout = runSmoke('old');
  assert.match(stdout, /old server: no capabilities/);
  assert.match(stdout, /request types sent: /);
});

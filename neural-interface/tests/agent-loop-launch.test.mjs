import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// POST /api/agents/launch runs the agent in a background function inside
// launchAgentController() (Automation Studio: Agent, single or Loop). server.js
// cannot be imported (it starts the server), so the function is taken out of
// its source and run here with its collaborators stubbed. Two things are
// pinned: the loop prompt gets the minutes that are left (the name it is
// computed from was once not declared, which threw on the first iteration), and
// a failure in the background function ends that launch as a failed agent
// instead of ending the process as an unhandled rejection.

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const START = 'async function launchAgentController(opts) {';
const END = '\n// POST /api/agents/launch';
const from = server.indexOf(START);
const to = server.indexOf(END, from);
assert.ok(from > 0 && to > from, 'launchAgentController is in server.js');
const source = server.slice(from, to);

function controller({ spawn } = {}) {
  const events = [];
  const errors = [];
  const released = [];
  const prompts = [];
  const world = {
    randomUUID,
    PACKAGE_ROOT: '/work',
    buildAgentMcpConfig: () => ({}),
    agentRegistry: new Map(),
    browserSessions: new Map([['bs-1', { _agentOwnedSet: new Set() }]]),
    broadcastSync: (msg) => events.push(msg),
    acquireSharedBrowserTab: async () => ({ error: 'none in tests' }),
    releaseSharedBrowserTab: async (sessionId, owner) => { released.push([sessionId, owner]); },
    spawnAgentProcess: async (agent, prompt) => {
      prompts.push(prompt);
      if (spawn) return spawn(agent, prompt);
      agent.toolUses.push({ name: 'Bash' });
      return { code: 0, error: null };
    },
    console: { log() {}, warn() {}, error: (...args) => errors.push(args.join(' ')) },
  };
  const names = Object.keys(world);
  // eslint-disable-next-line no-new-func
  const launch = new Function(...names, `${source}\nreturn launchAgentController;`)(...names.map(n => world[n]));
  return { launch, events, errors, released, prompts, world };
}

async function settled(agent, ms = 2000) {
  const deadline = Date.now() + ms;
  while (agent.status === 'running') {
    if (Date.now() > deadline) throw new Error('the agent never left "running"');
    await new Promise(r => setTimeout(r, 5));
  }
}

// What the process-level handler in server.js would have exited on.
async function withoutUnhandled(run) {
  const unhandled = [];
  const note = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', note);
  try { await run(); await new Promise(r => setTimeout(r, 20)); } finally { process.off('unhandledRejection', note); }
  assert.deepEqual(unhandled.map(e => e?.message || String(e)), [], 'nothing reached the unhandled-rejection handler, which exits the server');
}

test('an agent loop\'s first iteration is told the minutes that are left', async () => {
  await withoutUnhandled(async () => {
    const { launch, events, prompts, world } = controller();
    const agent = await launch({ task: 'Do the thing', mode: 'loop', iterations: 1, maxMinutes: 30 });
    assert.equal(world.agentRegistry.get(agent.id), agent);
    await settled(agent);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /^Do the thing\n\nIteration 1\/1\. 30min remaining\. Execute this iteration now\.$/);
    assert.equal(agent.status, 'completed');
    assert.equal(agent.error, null);
    assert.deepEqual(events.at(-1), { type: 'agent:status', agentId: agent.id, status: 'completed', exitCode: 0 });
  });
  // The time is counted from the launch, inside the background function.
  assert.match(source, /\(async \(\) => \{\n(?:\s*\/\/[^\n]*\n)*\s*const startTime = Date\.now\(\);/);
  assert.equal(source.split('startTime').length - 1, 2, 'declared once, read once');
});

test('a single run is not touched by any of it', async () => {
  await withoutUnhandled(async () => {
    const { launch, events, prompts } = controller();
    const agent = await launch({ task: 'One shot', mode: 'single' });
    await settled(agent);
    assert.deepEqual(prompts, ['One shot']);
    assert.equal(agent.status, 'completed');
    assert.deepEqual(events.map(e => e.type), ['agent:launched', 'agent:iteration', 'agent:status']);
  });
});

test('a failure inside the background run ends that launch as a failed agent, not the process', async () => {
  await withoutUnhandled(async () => {
    const boom = () => { throw new Error('spawn blew up'); };
    const { launch, events, errors, released, world } = controller({ spawn: boom });
    const agent = await launch({ task: 'Do the thing', mode: 'loop', iterations: 3, maxMinutes: 30, withSynabun: true, browserSessionId: 'bs-1', browserTabId: 'tab-1', agentId: 'agent-1' });
    await settled(agent);
    assert.equal(agent.status, 'failed');
    assert.equal(agent.error, 'spawn blew up');
    assert.equal(agent.exitCode, -1);
    assert.ok(agent.endedAt);
    assert.equal(agent.process, null);
    // Reported the way a finished agent is: the status broadcast the Automation Studio listens for.
    assert.deepEqual(events.at(-1), { type: 'agent:status', agentId: 'agent-1', status: 'failed', exitCode: -1 });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /\[agent\] agent-1 failed in iteration 1\/3: spawn blew up/);
    // Its browser tab is given back, as at a normal end.
    assert.deepEqual(released, [['bs-1', 'agent:agent-1']]);
    assert.equal(world.browserSessions.get('bs-1')._agentOwnedSet.has('agent-1'), false);
    assert.equal(agent.browserSessionId, null);
  });
});

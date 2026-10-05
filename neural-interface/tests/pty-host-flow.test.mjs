import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFlow } from '../lib/pty-host/flow.js';

const cfg = { flowHigh: 100, flowLow: 20, hiddenCap: 1000, flowStallMs: 3000 };
const client = (o) => ({ flow: true, open: true, visible: true, lagging: null, pending: null, unacked: 0, lastAckAt: 0, ...o });

test('flow: pause above high, resume below low, hysteresis in between', () => {
  const now = 10_000;
  assert.equal(evaluateFlow({ clients: [client({ unacked: 50 })], now, cfg }).pause, false);
  assert.equal(evaluateFlow({ clients: [client({ unacked: 150 })], now, cfg }).pause, true);
  // Already paused: stays paused until below LOW.
  const recent = { lastAckAt: now - 10 };
  assert.equal(evaluateFlow({ clients: [client({ unacked: 50, ...recent })], paused: true, pausedAt: now - 100, now, cfg }).pause, true);
  assert.equal(evaluateFlow({ clients: [client({ unacked: 10, ...recent })], paused: true, pausedAt: now - 100, now, cfg }).pause, false);
  // Not paused, between thresholds → stay running.
  assert.equal(evaluateFlow({ clients: [client({ unacked: 50 })], paused: false, now, cfg }).pause, false);
});

test('flow: hidden clients never pause; past the hidden cap they are demoted', () => {
  const r = evaluateFlow({ clients: [client({ visible: false, unacked: 5000 })], now: 1, cfg });
  assert.equal(r.pause, false);
  assert.equal(r.demote.length, 1);
  assert.equal(r.demote[0].reason, 'hidden-cap');
  const r2 = evaluateFlow({ clients: [client({ visible: false, unacked: 500 }), client({ unacked: 150 })], now: 1, cfg });
  assert.equal(r2.pause, true, 'a visible client over HIGH still pauses');
  assert.equal(r2.demote.length, 0);
});

test('flow: non-flow, lagging, pending and closed clients do not participate; loop-owned never pauses', () => {
  const clients = [
    client({ flow: false, unacked: 1e6 }),
    client({ lagging: 'buffer', unacked: 1e6 }),
    client({ pending: {}, unacked: 1e6 }),
    client({ open: false, unacked: 1e6 }),
  ];
  assert.equal(evaluateFlow({ clients, now: 1, cfg }).pause, false);
  assert.equal(evaluateFlow({ clients: [client({ unacked: 1e6 })], loopOwned: true, now: 1, cfg }).pause, false);
  assert.equal(evaluateFlow({ clients: [], now: 1, cfg }).pause, false);
});

test('flow: stall watchdog demotes a visible client that stopped acking while paused', () => {
  const now = 100_000;
  const stuck = client({ unacked: 500, lastAckAt: now - 10_000 });
  const r = evaluateFlow({ clients: [stuck], paused: true, pausedAt: now - 5000, now, cfg });
  assert.equal(r.pause, false, 'nothing left to wait for → resume');
  assert.deepEqual(r.demote.map(d => d.reason), ['stall']);
  // Paused only briefly → no demotion yet.
  const r2 = evaluateFlow({ clients: [client({ unacked: 500, lastAckAt: now - 10_000 })], paused: true, pausedAt: now - 500, now, cfg });
  assert.equal(r2.pause, true);
  assert.equal(r2.demote.length, 0);
  // A healthy second client keeps its own pause decision.
  const r3 = evaluateFlow({ clients: [stuck, client({ unacked: 150, lastAckAt: now })], paused: true, pausedAt: now - 5000, now, cfg });
  assert.equal(r3.pause, true);
  assert.equal(r3.demote.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventLoopMonitor } from '../lib/event-loop-monitor.js';

const block = (ms) => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('event-loop monitor reports delay net of its sampling resolution and records stalls', async () => {
  const mon = createEventLoopMonitor({ resolutionMs: 10, stallMs: 30, sampleMs: 20 });
  try {
    await sleep(200);
    const idle = mon.snapshot({ reset: true });
    assert.ok(idle.p50 < 5, `idle p50 should be near zero after subtracting the resolution, got ${idle.p50}`);

    await sleep(60);
    block(80);
    await sleep(120);
    const snap = mon.snapshot();
    assert.ok(snap.max >= 50, `an 80 ms block must show up in max (got ${snap.max})`);
    assert.ok(snap.stalls.length >= 1, 'the stall sampler records the block');
    assert.ok(snap.stalls.some(s => s.ms >= 40), JSON.stringify(snap.stalls));
    assert.ok(snap.elu > 0 && snap.elu <= 1);

    const afterReset = mon.snapshot({ reset: true });
    assert.equal(afterReset.stalls.length, snap.stalls.length);
    assert.equal(mon.snapshot().stalls.length, 0, 'reset clears the stall ring');
  } finally {
    mon.stop();
  }
});

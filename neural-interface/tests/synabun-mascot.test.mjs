// Run with: node --test tests/synabun-mascot.test.mjs
// The mascot rig's pure side (poseFrame, stillFrame, reactionFrame, the SVG
// strings) and the shared ticker's bookkeeping, on a fake rAF, clock and
// window: fps caps on one loop, no rAF without subscribers, the hidden / drag
// pauses, one pointermove listener for any number of subscribers, one
// prefers-reduced-motion listener. No DOM; the live rigs run in
// tests/synabun-mascot.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  MASCOT_KINDS, MASCOT_POSES, MASCOT_REACTIONS, MASCOT_STATES,
  mascotCameoSvg, mascotSvg, mouthPath, poseFrame, reactionFrame, stillFrame,
} = await import('../public/shared/synabun-mascot.js');
const {
  __ticker, isReducedMotion, lastInputAt, onKey, onPointer, onReducedMotionChange,
  pointerPosition, requestFrames, subscribe, tickerPaused,
} = await import('../public/shared/synabun-ticker.js');

// ── A fake platform: vsync every 16.67 ms, timers, window / document listeners ──

function fakePlatform() {
  let t = 0;
  let seq = 0;
  const frames = new Map();
  const timers = new Map();
  const stats = { rafCalls: 0, framesRun: 0, maxPending: 0 };
  const target = () => {
    const map = new Map();
    return {
      map,
      addEventListener(type, fn) { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(fn); },
      removeEventListener(type, fn) { map.get(type)?.delete(fn); },
      count: type => map.get(type)?.size || 0,
      fire(type, ev) { for (const fn of [...(map.get(type) || [])]) fn(ev); },
    };
  };
  const win = target();
  const bodyClasses = new Set();
  const doc = { ...target(), hidden: false, body: { classList: { contains: c => bodyClasses.has(c) } } };
  // addEventListener & co. close over their own `map`, so the spread keeps them working.
  const observers = [];
  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; this.on = false; observers.push(this); }
    observe() { this.on = true; }
    disconnect() { this.on = false; }
  }
  const query = {
    matches: false,
    listeners: new Set(),
    addEventListener(_, fn) { this.listeners.add(fn); },
    removeEventListener(_, fn) { this.listeners.delete(fn); },
  };
  const env = {
    now: () => t,
    raf(cb) {
      stats.rafCalls += 1;
      seq += 1;
      frames.set(seq, cb);
      stats.maxPending = Math.max(stats.maxPending, frames.size);
      return seq;
    },
    caf(id) { frames.delete(id); },
    setTimeout(fn, ms) { seq += 1; timers.set(seq, { at: t + Math.max(0, ms), fn }); return seq; },
    clearTimeout(id) { timers.delete(id); },
    window: win,
    document: doc,
    MutationObserver: FakeMutationObserver,
    matchMedia: () => query,
  };
  /** Run the clock `ms` forward, firing timers and a vsync every `frameMs` while a frame is pending. */
  function advance(ms, frameMs = 1000 / 60) {
    const end = t + ms;
    for (;;) {
      let timerAt = Infinity;
      let timerId = 0;
      for (const [id, timer] of timers) if (timer.at < timerAt) { timerAt = timer.at; timerId = id; }
      const vsync = frames.size ? (Math.floor(t / frameMs + 1e-9) + 1) * frameMs : Infinity;
      const next = Math.min(timerAt, vsync);
      if (next > end) { t = end; return; }
      t = next;
      if (timerAt <= vsync) {
        const timer = timers.get(timerId);
        timers.delete(timerId);
        timer.fn();
      } else {
        const due = [...frames.values()];
        frames.clear();
        stats.framesRun += 1;
        for (const cb of due) cb(t);
      }
    }
  }
  const setClass = (name, on) => {
    if (on) bodyClasses.add(name); else bodyClasses.delete(name);
    for (const o of observers) if (o.on) o.cb([]);
  };
  return { env, win, doc, query, stats, advance, setClass, observers, pending: () => frames.size, timers: () => timers.size, now: () => t };
}

function withPlatform(fn) {
  return async () => {
    const p = fakePlatform();
    __ticker.setEnv(p.env);
    try { await fn(p); } finally { __ticker.setEnv(null); }
  };
}

const counter = () => {
  const calls = [];
  const fn = (now, dt) => calls.push({ now, dt });
  return { fn, calls };
};

// ── Ticker ──

test('ticker: no subscribers, no rAF; the last unsubscribe stops the loop', withPlatform((p) => {
  p.advance(1000);
  assert.equal(p.stats.rafCalls, 0, 'nothing listens, nothing is requested');
  const idle = __ticker.state();
  assert.deepEqual([idle.subscribers, idle.raf, idle.timer, idle.watching], [0, false, false, false]);
  const a = counter();
  const stop = subscribe(a.fn, { fps: 60 });
  assert.equal(__ticker.state().watching, true, 'the pause watchers attach with the first subscriber');
  assert.equal(p.observers.filter(o => o.on).length, 1, 'one MutationObserver on <body>');
  assert.equal(p.doc.count('visibilitychange'), 1);
  p.advance(1000);
  assert.ok(a.calls.length >= 59 && a.calls.length <= 61, `60 fps (${a.calls.length})`);
  stop();
  stop(); // twice is harmless
  const requested = p.stats.rafCalls;
  p.advance(2000);
  assert.equal(p.stats.rafCalls, requested, 'no frame after the last unsubscribe');
  assert.equal(p.pending(), 0, 'the pending frame was cancelled');
  assert.equal(p.timers(), 0);
  assert.equal(__ticker.state().watching, false, 'the watchers detach with the last subscriber');
  assert.equal(p.observers.filter(o => o.on).length, 0);
  assert.equal(p.doc.count('visibilitychange'), 0);
}));

test('ticker: every subscriber shares one loop, each capped at its fps', withPlatform((p) => {
  const fast = counter();
  const loop = counter();
  const slow = counter();
  subscribe(fast.fn, { fps: 60 });
  subscribe(loop.fn, { fps: 30 });
  subscribe(slow.fn, { fps: 1 });
  p.advance(3000);
  assert.ok(Math.abs(fast.calls.length - 180) <= 2, `60 fps (${fast.calls.length})`);
  assert.ok(Math.abs(loop.calls.length - 90) <= 2, `30 fps (${loop.calls.length})`);
  assert.ok(slow.calls.length >= 3 && slow.calls.length <= 4, `1 fps (${slow.calls.length})`);
  assert.equal(p.stats.maxPending, 1, 'never more than one rAF in flight');
  assert.ok(p.stats.framesRun <= 182, `one vsync callback per frame (${p.stats.framesRun})`);
  for (const { dt } of loop.calls.slice(1)) assert.ok(dt > 30 && dt < 37, `30 fps dt ≈ 33 ms (${dt})`);
  assert.ok(fast.calls.every(({ dt }) => dt >= 0), 'dt is never negative');
}));

test('ticker: slow subscribers sleep on a timer between frames', withPlatform((p) => {
  const slow = counter();
  const stop = subscribe(slow.fn, { fps: 1 });
  p.advance(5000);
  assert.ok(slow.calls.length >= 5 && slow.calls.length <= 6, `1 fps (${slow.calls.length})`);
  assert.ok(p.stats.framesRun <= 3 * slow.calls.length, `no frame-by-frame polling (${p.stats.framesRun} frames for ${slow.calls.length} calls)`);
  // setFps re-caps in place and wakes the loop at once.
  stop.setFps(60);
  const before = slow.calls.length;
  p.advance(500);
  assert.ok(slow.calls.length - before >= 28, `re-capped to 60 fps (${slow.calls.length - before})`);
  stop();
}));

test('ticker: requestFrames lifts animation subscribers to 60 fps for a while', withPlatform((p) => {
  const loop = counter();
  const clock = counter();
  subscribe(loop.fn, { fps: 30 });
  subscribe(clock.fn, { fps: 1 });
  p.advance(1000);
  const [loopBase, clockBase] = [loop.calls.length, clock.calls.length];
  requestFrames(1000);
  assert.equal(__ticker.state().boosted, true);
  p.advance(1000);
  assert.ok(loop.calls.length - loopBase >= 58, `boosted to 60 fps (${loop.calls.length - loopBase})`);
  assert.ok(clock.calls.length - clockBase <= 2, 'a 1 fps clock keeps its pace');
  const boostedEnd = loop.calls.length;
  p.advance(1000);
  assert.ok(loop.calls.length - boostedEnd <= 31, `back to 30 fps (${loop.calls.length - boostedEnd})`);
}));

test('ticker: a hidden tab stops the loop; the first dt after is at most 50 ms', withPlatform((p) => {
  const a = counter();
  subscribe(a.fn, { fps: 60 });
  p.advance(200);
  p.doc.hidden = true;
  const seen = a.calls.length;
  p.advance(3000);
  assert.ok(a.calls.length - seen <= 1, 'no calls while hidden');
  assert.equal(p.pending(), 0, 'no rAF while hidden');
  assert.equal(tickerPaused(), 'hidden');
  const restoredAt = p.now();
  p.doc.hidden = false;
  p.doc.fire('visibilitychange');
  p.advance(100);
  const resumed = a.calls.find(c => c.now > restoredAt);
  assert.ok(resumed && resumed.dt <= 50, `resume dt clamped (${resumed?.dt})`);
  assert.ok(a.calls.length > seen + 3, 'it runs again');
  // body.app-hidden (the app's own hidden flag) stops it the same way.
  p.setClass('app-hidden', true);
  const beforeApp = a.calls.length;
  p.advance(1000);
  assert.ok(a.calls.length - beforeApp <= 1);
  p.setClass('app-hidden', false);
  p.advance(100);
  assert.ok(a.calls.length - beforeApp > 3, 'removing app-hidden restarts it');
}));

test('ticker: body.ui-interacting freezes subscribers; resume dt ≤ 50 ms', withPlatform((p) => {
  const a = counter();
  const b = counter();
  subscribe(a.fn, { fps: 30 });
  subscribe(b.fn, { fps: 60 });
  p.advance(300);
  p.setClass('ui-interacting', true);
  const [na, nb] = [a.calls.length, b.calls.length];
  p.advance(2000);
  assert.ok(a.calls.length - na <= 1 && b.calls.length - nb <= 1, 'skipped while dragging');
  assert.equal(p.pending(), 0, 'and no frames burnt on it');
  assert.equal(tickerPaused(), 'interacting');
  p.setClass('ui-interacting', false);
  p.advance(200);
  const firstA = a.calls.find(c => c.now > 2300);
  const firstB = b.calls.find(c => c.now > 2300);
  assert.ok(firstA.dt <= 50 && firstB.dt <= 50, `nothing jumps (${firstA.dt}, ${firstB.dt})`);
  assert.equal(tickerPaused(), '');
}));

test('ticker: a long task is not a leap, and a subscriber may unsubscribe mid-frame', withPlatform((p) => {
  const a = counter();
  subscribe(a.fn, { fps: 30 });
  p.advance(100);
  p.advance(2000, 2000); // the main thread stalls: one frame after 2 s
  assert.ok(a.calls.at(-1).dt <= 67, `dt capped at two frames (${a.calls.at(-1).dt})`);
  __ticker.reset();
  let stopSelf = null;
  const other = counter();
  stopSelf = subscribe(() => stopSelf(), { fps: 60 });
  const stopOther = subscribe(other.fn, { fps: 60 });
  p.advance(100);
  assert.ok(other.calls.length >= 5, 'the others keep running');
  stopOther();
  p.advance(100);
  assert.equal(__ticker.state().subscribers, 0);
  assert.equal(p.pending(), 0);
}));

test('ticker: one pointermove listener for any number of subscribers', withPlatform((p) => {
  const got = [];
  const stops = [0, 1, 2, 3, 4].map(i => onPointer((x, y) => got.push([i, x, y])));
  assert.equal(p.win.count('pointermove'), 1, 'exactly one window listener');
  assert.equal(__ticker.state().pointerListeners, 5);
  p.advance(40);
  p.win.fire('pointermove', { clientX: 12, clientY: 34 });
  assert.deepEqual(got.map(([i]) => i), [0, 1, 2, 3, 4]);
  assert.ok(got.every(([, x, y]) => x === 12 && y === 34));
  assert.deepEqual(pointerPosition(), { x: 12, y: 34, at: 40 });
  assert.equal(lastInputAt(), 40);
  stops.slice(0, 4).forEach(stop => stop());
  assert.equal(p.win.count('pointermove'), 1, 'still one while anybody listens');
  stops[4]();
  stops[4]();
  assert.equal(p.win.count('pointermove'), 0, 'detached at zero');
  assert.equal(__ticker.state().pointerAttached, false);
  // Keys follow the same rule.
  const keys = [];
  const k1 = onKey(e => keys.push(e.key));
  const k2 = onKey(e => keys.push(e.key.toUpperCase()));
  assert.equal(p.win.count('keydown'), 1);
  p.advance(10);
  p.win.fire('keydown', { key: 'a' });
  assert.deepEqual(keys, ['a', 'A']);
  assert.equal(lastInputAt(), 50);
  k1();
  k2();
  assert.equal(p.win.count('keydown'), 0);
}));

test('ticker: one live prefers-reduced-motion listener', withPlatform((p) => {
  assert.equal(isReducedMotion(), false);
  const seen = [];
  const stops = [1, 2, 3].map(i => onReducedMotionChange(on => seen.push([i, on])));
  assert.equal(p.query.listeners.size, 1, 'one listener on one query');
  p.query.matches = true;
  for (const fn of p.query.listeners) fn({ matches: true });
  assert.deepEqual(seen, [[1, true], [2, true], [3, true]]);
  assert.equal(isReducedMotion(), true, 'read live');
  stops.forEach(stop => stop());
  assert.equal(p.query.listeners.size, 0, 'removed with the last subscriber');
  assert.equal(__ticker.state().motionListeners, 0);
}));

test('ticker: importing and calling it without a DOM is safe', () => {
  __ticker.setEnv(null);
  const stop = subscribe(() => {}, { fps: 30 }); // Node: no rAF, nothing scheduled
  assert.equal(__ticker.state().raf, false);
  stop();
  assert.equal(isReducedMotion(), false);
  assert.equal(tickerPaused(), '');
  onPointer(() => {})();
});

// ── Poses ──

const TIMES = [0, 16, 137, 250, 480, 700, 999, 1250, 1540, 1799, 2100, 2520, 4800, 5600, 5999, 6000, 12345];
const OPTIONS = [{}, { count: 3, mode: 'remember', ticks: 3, look: { x: 1, y: -1 } }, { count: 2, look: { x: -0.7, y: 0.9 } }];

function assertSane(frame, where) {
  const finite = (v, label) => assert.ok(Number.isFinite(v), `${where}: ${label} is finite (${v})`);
  const within = (v, lo, hi, label) => { finite(v, label); assert.ok(v >= lo && v <= hi, `${where}: ${label} ${v} in [${lo}, ${hi}]`); };
  assert.equal(frame.eyes.length, 2, `${where}: two eyes`);
  frame.eyes.forEach((e, i) => {
    within(e.dx, -40, 40, `eye${i}.dx`);
    within(e.dy, -30, 30, `eye${i}.dy`);
    within(e.sx, 0.3, 1.5, `eye${i}.sx`);
    within(e.sy, 0.02, 1.5, `eye${i}.sy`);
    within(e.rot, -20, 20, `eye${i}.rot`);
  });
  within(frame.mouth.w, 0, 80, 'mouth.w');
  within(frame.mouth.c, -30, 30, 'mouth.c');
  within(frame.mouth.dx, -30, 30, 'mouth.dx');
  within(frame.mouth.dy, -20, 20, 'mouth.dy');
  within(frame.mouth.rot, -30, 30, 'mouth.rot');
  within(frame.mouth.op, 0, 1, 'mouth.op');
  within(frame.face.dx, -20, 20, 'face.dx');
  within(frame.face.dy, -12, 12, 'face.dy');
  within(frame.face.rot, -10, 10, 'face.rot');
  within(frame.face.op, 0, 1, 'face.op');
  assert.ok(frame.prop && 'name' in frame.prop, `${where}: a prop slot`);
  for (const [key, value] of Object.entries(frame.prop)) {
    if (typeof value === 'number') finite(value, `prop.${key}`);
  }
  for (const m of frame.prop.minis || []) for (const key of ['x', 'y', 's', 'sy', 'look', 'op']) finite(m[key], `mini.${key}`);
}

test('poses: the interface names, 12 kinds and 8 states, 7 reactions', () => {
  assert.deepEqual([...MASCOT_KINDS], ['shell', 'read', 'edit', 'search', 'web', 'subagent', 'plan', 'memory', 'runs', 'computer', 'think', 'mcp']);
  assert.deepEqual([...MASCOT_STATES], ['idle', 'sleep', 'watch', 'wait', 'success', 'error', 'blocked', 'offline']);
  assert.deepEqual([...MASCOT_POSES], [...MASCOT_KINDS, ...MASCOT_STATES]);
  assert.deepEqual([...MASCOT_REACTIONS], ['hop', 'wince', 'nod', 'pop', 'startle', 'pulse', 'click']);
  assert.ok(Object.isFrozen(MASCOT_POSES) && Object.isFrozen(MASCOT_REACTIONS));
});

test('poseFrame: every pose, finite and in range, deterministic', () => {
  for (const name of MASCOT_POSES) {
    for (const opts of OPTIONS) {
      for (const t of TIMES) {
        const frame = poseFrame(name, t, opts);
        assertSane(frame, `${name}@${t}`);
        assert.deepEqual(poseFrame(name, t, opts), frame, `${name}@${t} is deterministic`);
      }
    }
  }
});

test('poseFrame: unknown names and bad input fall back to idle', () => {
  for (const t of [0, 500, 9000]) {
    assert.deepEqual(poseFrame('dance', t), poseFrame('idle', t));
    assert.deepEqual(poseFrame(undefined, t, { look: { x: 0.5, y: 0.2 } }), poseFrame('idle', t, { look: { x: 0.5, y: 0.2 } }));
  }
  assertSane(poseFrame('shell', Number.NaN), 'shell@NaN');
  assertSane(poseFrame('read', -500), 'read@-500');
  assertSane(poseFrame('subagent', 0, { count: 99 }), 'subagent×99');
  assert.equal(poseFrame('subagent', 0, { count: 99 }).prop.minis.length, 3, 'at most three minis');
  assert.equal(poseFrame('subagent', 0, { count: -4 }).prop.minis.length, 1, 'at least one');
  assert.equal(poseFrame('idle', 0, { look: { x: 9, y: -9 } }).eyes[0].dx, 20, 'look is clamped to [-1, 1]');
});

test('poseFrame: idle follows the look, the far eye foreshortens', () => {
  const right = poseFrame('idle', 0, { look: { x: 1, y: 0.5 } });
  assert.deepEqual([right.eyes[0].dx, right.eyes[0].dy], [20, 6]);
  assert.ok(right.eyes[1].sx < right.eyes[0].sx, 'turning right narrows the right eye');
  assert.equal(right.mouth.dx, 10, 'the mouth follows at half the travel');
  const neutral = poseFrame('idle', 0);
  assert.deepEqual(neutral.eyes, [{ dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 }, { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 }]);
  assert.equal(mouthPath(neutral.mouth), 'M118,116 Q140,130 162,116', 'the v1 smile');
});

test('still frames: time-free, one prop per kind, both eyes changed differently', () => {
  for (const name of MASCOT_POSES) {
    const still = stillFrame(name);
    assertSane(still, `${name} still`);
    for (const t of TIMES) assert.deepEqual(poseFrame(name, t, { still: true }), still, `${name}: the still frame does not move`);
  }
  for (const kind of MASCOT_KINDS) {
    const { eyes, prop } = stillFrame(kind);
    assert.equal(prop.name, kind, `${kind} carries its prop`);
    assert.notDeepEqual(eyes[0], eyes[1], `${kind}: asymmetric eyes`);
    assert.notDeepEqual(eyes, stillFrame('idle').eyes, `${kind}: not the idle face`);
  }
  for (const state of MASCOT_STATES) assert.equal(stillFrame(state).prop.name, null, `${state}: no prop`);
  assert.equal(stillFrame('offline').face.op, 0.5, 'offline is dimmed');
  assert.ok(stillFrame('sleep').eyes.every(e => e.sy <= 0.12), 'sleep: eyes shut');
  const success = stillFrame('success');
  assert.ok(success.eyes.every(e => e.sy === 0.3) && success.mouth.c > 14 && success.mouth.w > 44, 'success: happy eyes, wide smile');
  const error = stillFrame('error');
  assert.ok(error.eyes[0].rot === 12 && error.eyes[1].rot === -12 && error.mouth.c < 0, 'error: /\\ and a frown');
  assert.ok(stillFrame('blocked').eyes.every(e => e.sy >= 1.1), 'blocked: wide eyes');
  assert.ok(stillFrame('runs').eyes.every(e => e.sy >= 0.42 && e.sy <= 0.5), 'runs: patient half-lids');
});

test('poses: the loops move, the one-shots settle, the patient ones sit still between blinks', () => {
  const moves = (name, opts) => TIMES.some(t => JSON.stringify(poseFrame(name, t, opts)) !== JSON.stringify(poseFrame(name, 0, opts)));
  for (const name of ['shell', 'read', 'edit', 'search', 'web', 'subagent', 'memory', 'think', 'mcp', 'sleep']) assert.ok(moves(name), `${name} loops`);
  assert.ok(moves('memory', { mode: 'remember' }), 'memory remember loops');
  for (const name of ['success', 'error', 'blocked']) {
    assert.deepEqual(poseFrame(name, 5000), stillFrame(name), `${name} settles on its still frame`);
  }
  // runs / wait: identical frames between blinks, a slow blink before every 6 s.
  assert.deepEqual(poseFrame('runs', 1000), poseFrame('runs', 5000));
  assert.ok(poseFrame('runs', 5760).eyes[0].sy < 0.1, 'the slow blink shuts the lids');
  assert.deepEqual(poseFrame('wait', 7000), poseFrame('wait', 11000));
  // read: the carriage return blinks.
  assert.ok(poseFrame('read', 1540 + 110).eyes[1].sy < 0.2);
  // shell: five keystroke nods per 2.48 s cycle.
  let nods = 0;
  let down = false;
  for (let t = 0; t < 2480; t += 5) {
    const deep = poseFrame('shell', t).face.dy > 1.5;
    if (deep && !down) nods += 1;
    down = deep;
  }
  assert.equal(nods, 5, 'five nods');
  // error never shakes: its tilt only grows.
  let last = -Infinity;
  for (let t = 0; t <= 2000; t += 10) {
    const rot = poseFrame('error', t).eyes[0].rot;
    assert.ok(rot >= last, `error tilt is monotonic at ${t}`);
    last = rot;
    assert.equal(poseFrame('error', t).face.dx, 0, 'no sideways motion');
  }
  // memory: recall pings a sonar ring 0 → 46, remember keeps it quiet.
  const rings = TIMES.map(t => poseFrame('memory', t).prop.ring);
  assert.ok(Math.max(...rings) > 30 && Math.max(...rings) <= 46);
  assert.ok(TIMES.every(t => poseFrame('memory', t, { mode: 'remember' }).prop.ring === 0));
});

test('reactionFrame: every reaction starts and ends at rest; hop lands, wince flips the smile', () => {
  const base = poseFrame('idle', 0);
  const close = (a, b, where) => {
    const flat = f => [...f.eyes.flatMap(e => [e.dx, e.dy, e.sx, e.sy, e.rot]), f.mouth.w, f.mouth.c, f.mouth.dy, f.face.dx, f.face.dy, f.face.rot];
    flat(a).forEach((v, i) => assert.ok(Math.abs(v - flat(b)[i]) < 1e-9, `${where}: component ${i} ${v} vs ${flat(b)[i]}`));
  };
  for (const name of [...MASCOT_REACTIONS, 'wiggle']) {
    close(reactionFrame(base, name, 0), base, `${name}@0`);
    close(reactionFrame(base, name, 1), base, `${name}@1`);
    for (const p of [0.1, 0.3, 0.5, 0.8]) assertSane(reactionFrame(base, name, p), `${name}@${p}`);
  }
  assert.ok(reactionFrame(base, 'hop', 0.3).face.dy <= -11.9, 'the hop peaks 12 units up');
  const landing = [0.5, 0.55, 0.6, 0.65, 0.7].map(p => reactionFrame(base, 'hop', p).face.dy);
  assert.ok(landing.some(dy => dy > 0), 'the spring landing dips below rest');
  const wince = reactionFrame(base, 'wince', 0.5);
  assert.ok(wince.mouth.c < 0, 'the smile flips');
  assert.ok(Math.abs(wince.eyes[0].sy - 0.55) < 0.01, 'lids to about .55');
  assert.equal(wince.face.dx, 0, 'no shake');
  const plan = poseFrame('plan', 0, { ticks: 2 });
  assert.equal(reactionFrame(plan, 'pop', 0.4).prop.pop, 0.4, 'pop drives the newest tick');
  const computer = poseFrame('computer', 0);
  assert.equal(reactionFrame(computer, 'click', 0.5).prop.ripple, 0.5, 'click drives the ripple');
  assert.ok(reactionFrame(computer, 'click', 110 / 280).eyes[1].sy < 0.1, 'and blinks');
  assert.deepEqual(reactionFrame(base, 'nope', 0.5).eyes, base.eyes, 'unknown reactions do nothing');
  assert.deepEqual(base, poseFrame('idle', 0), 'the input frame is not mutated');
});

// ── Markup ──

test('mascotSvg: the v1 geometry plus the face and props layers', () => {
  const svg = mascotSvg({ width: 72, height: 36, className: 'x' });
  assert.match(svg, /^<svg class="x" viewBox="0 0 280 140" width="72" height="36"/);
  assert.equal((svg.match(/class="syna-lid"/g) || []).length, 2);
  assert.equal((svg.match(/class="syna-eye"/g) || []).length, 2);
  assert.match(svg, /<rect x="80" y="24" width="38" height="72" rx="19" fill="currentColor"\/>/);
  assert.match(svg, /<rect x="162" y="24" width="38" height="72" rx="19" fill="currentColor"\/>/);
  assert.match(svg, /<path class="syna-mouth" d="M118,116 Q140,130 162,116"[^>]*stroke-opacity=".25"/);
  assert.match(svg, /<g class="syna-face">.*<g class="syna-props"><\/g><\/g><\/svg>$/);
  assert.match(svg, /aria-hidden="true" focusable="false"/);
});

test('mascotCameoSvg: two 3×7 px pill eyes', () => {
  const svg = mascotCameoSvg();
  assert.match(svg, /^<svg class="syna-cameo" viewBox="0 0 10 7" width="10" height="7"/);
  const eyes = svg.match(/<rect class="syna-cameo-eye"[^>]*>/g) || [];
  assert.equal(eyes.length, 2);
  for (const tag of eyes) assert.match(tag, /width="3" height="7" rx="1.5" fill="currentColor"/);
  assert.match(svg, /aria-hidden="true"/);
  assert.match(mascotCameoSvg({ className: 'is-live' }), /class="syna-cameo is-live"/);
  // Never a pause glyph: the pair leans −12° like the two-pill mark (the right eye sits higher),
  // on a wrapper, so the eyes keep an untransformed box for the CSS glance.
  assert.match(svg, /<g class="syna-cameo-pair" transform="rotate\(-12 5 3\.5\)"><rect class="syna-cameo-eye"[^>]*\/><rect class="syna-cameo-eye"[^>]*\/><\/g>/);
  for (const tag of eyes) assert.doesNotMatch(tag, /transform=/);
});

test('mascotPropSvg / paintMascotProp: a kind\'s prop alone, framed to its own box', async () => {
  const { mascotPropSvg, MASCOT_KINDS } = await import('../public/shared/synabun-mascot.js');
  for (const kind of MASCOT_KINDS) {
    const svg = mascotPropSvg(kind, { width: 24, height: 16, className: 'asst-prop-glyph' });
    assert.match(svg, /^<svg class="syna-prop-glyph asst-prop-glyph" viewBox="-?\d+ -?\d+ \d+ \d+" width="24" height="16" preserveAspectRatio="xMidYMid meet"/, kind);
    assert.match(svg, /<g class="syna-face"><g class="syna-props"><\/g><\/g><\/svg>$/, `${kind}: no eyes, only the props layer`);
  }
  assert.equal(mascotPropSvg('nope'), '', 'a kind without a prop draws nothing');
});

test('mouthPath: width, curve, offset and tilt', () => {
  assert.equal(mouthPath({ w: 44, c: 14, dx: 0, dy: 0, rot: 0, op: 0.25 }), 'M118,116 Q140,130 162,116');
  assert.equal(mouthPath({ w: 30, c: -10, dx: 5, dy: 2, rot: 0, op: 0.25 }), 'M130,118 Q145,108 160,118', 'a frown');
  const tilted = mouthPath({ w: 20, c: 0, dx: 0, dy: 0, rot: 90, op: 0.25 });
  assert.equal(tilted, 'M140,106 Q140,116 140,126', 'rotation turns the stroke about its centre');
});

// Run with: SYNABUN_TYPESAFE=off node --test tests/assistant-mascot.test.mjs
// The panel's mascot director (asst-mascot.js) on a fake clock with fake rigs:
// watch-on-typing throttling and the return to idle, sending hands over at
// once, blocked / offline / success / error wiring and their order, the
// hero's 90 s sleep, one panel animating at a time.
import test from 'node:test';
import assert from 'node:assert/strict';

const { createMascotDirector, turnEndPose, lookToward, MASCOT_TIMING } = await import('../public/shared/assistant/asst-mascot.js');

function fakeClock() {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { seq += 1; timers.set(seq, { fn, at: now + Math.max(0, Number(ms) || 0) }); return seq; },
    clearTimeout: (id) => { timers.delete(id); },
    /** Run every timer due within `ms`, in order, then land on now + ms. */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, timer] of timers) if (timer.at <= end && (!next || timer.at < next[1].at)) next = [id, timer];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
    pending: () => timers.size,
  };
}

/** A rig the director can dress, and the target the renderer would hand over. */
function fakeTarget(kind = 'hero', box = { left: 100, top: 100, width: 120, height: 60 }) {
  const calls = [];
  const rig = {
    pose: kind === 'hero' ? 'idle' : 'shell',
    setPose(name, opts) { calls.push(['pose', name, opts?.then || null]); rig.pose = name; },
    look(x, y) { calls.push(['look', Math.round(x * 100) / 100, Math.round(y * 100) / 100]); },
    react(name) { calls.push(['react', name]); },
    el: { getBoundingClientRect: () => box },
  };
  const target = {
    kind,
    rig,
    el: rig.el,
    held: false,
    isParked: false,
    parked: () => target.isParked,
    hold(on) { target.held = on; calls.push(['hold', on]); },
    restore() { calls.push(['restore']); rig.pose = kind === 'hero' ? (target.isParked ? 'think' : 'idle') : 'shell'; },
  };
  return { target, rig, calls };
}

function setup({ kind = 'hero', caret = { x: 400, y: 600 }, visible = true } = {}) {
  const clock = fakeClock();
  const { target, rig, calls } = fakeTarget(kind);
  let current = target;
  const inputs = new Set();
  const enabled = [];
  const director = createMascotDirector({
    getTarget: () => current,
    caret: () => caret,
    setEnabled: (on) => enabled.push(on),
    isVisible: () => visible,
    env: { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, input: (fn) => { inputs.add(fn); return () => inputs.delete(fn); }, lastInputAt: () => -Infinity },
  });
  director.retarget();
  return { clock, director, target, rig, calls, enabled, inputs, setTarget: (t) => { current = t; director.retarget(); }, pageInput: () => [...inputs].forEach(fn => fn()) };
}

const poses = (calls) => calls.filter(c => c[0] === 'pose').map(c => (c[2] ? `${c[1]}→${c[2]}` : c[1]));
const count = (calls, kind) => calls.filter(c => c[0] === kind).length;

test('turnEndPose: success after real work, error when it failed, nothing when stopped or trivial', () => {
  assert.equal(turnEndPose({ calls: 1, elapsedMs: 200 }), 'success', 'one tool call is real work');
  assert.equal(turnEndPose({ calls: 0, elapsedMs: 3500 }), 'success', 'a turn longer than 3 s');
  assert.equal(turnEndPose({ calls: 0, elapsedMs: 900 }), null, 'a quick answer: no celebration');
  assert.equal(turnEndPose({ calls: 0, elapsedMs: MASCOT_TIMING.realWorkMs }), null, 'exactly 3 s is not more than 3 s');
  assert.equal(turnEndPose({ calls: 4, lastFailed: true }), 'error', 'a tool failed at the end');
  assert.equal(turnEndPose({ calls: 0, errored: true }), 'error', 'the turn errored');
  assert.equal(turnEndPose({ calls: 5, errored: true, aborted: true }), null, 'the user stopped it');
  assert.equal(turnEndPose(), null);
});

test('lookToward: the rig cursor mapping; watch keeps the column only', () => {
  const box = { left: 0, top: 0, width: 100, height: 50 };
  const right = lookToward(box, { x: 350, y: 25 });
  assert.ok(right.x > 0.8 && right.x <= 1 && Math.abs(right.y) < 1e-9, JSON.stringify(right));
  const below = lookToward(box, { x: 50, y: 400 });
  assert.ok(below.y > 0.8 && Math.abs(below.x) < 1e-9, JSON.stringify(below));
  const column = lookToward(box, { x: -100, y: 900 }, { horizontal: true });
  assert.ok(column.x < -0.5 && column.y === 0, 'horizontal: the caret column, not its line');
  assert.deepEqual(lookToward(box, { x: 50, y: 25 }), { x: 0, y: 0 }, 'on the centre: straight ahead');
  assert.deepEqual(lookToward(null, { x: 1, y: 1 }), { x: 0, y: 0 });
  assert.deepEqual(lookToward(box, null), { x: 0, y: 0 });
});

test('watch while typing: the pose once, look() at most every 120 ms, back to idle 1.5 s after the last key', () => {
  const { clock, director, calls, target, rig } = setup();
  director.type(true);
  assert.deepEqual(poses(calls), ['watch'], 'the first key: watch at once');
  assert.equal(target.held, true, 'the renderer leaves the pose alone');
  assert.equal(count(calls, 'look'), 1);
  assert.ok(calls.find(c => c[0] === 'look')[1] > 0, 'the caret (right of the rig) pulls the eyes right');
  // Nine more keys over 90 ms: one trailing look at 120 ms, not nine.
  for (let i = 0; i < 9; i += 1) { clock.advance(10); director.type(true); }
  assert.equal(count(calls, 'look'), 1, 'throttled: nothing new inside the 120 ms window');
  clock.advance(30);
  assert.equal(count(calls, 'look'), 2, 'the trailing look lands 120 ms after the first');
  assert.deepEqual(poses(calls), ['watch'], 'setPose runs once for the whole burst');
  // A steady typist: one look per 120 ms window.
  for (let i = 0; i < 12; i += 1) { clock.advance(40); director.type(true); }
  const looks = count(calls, 'look');
  assert.ok(looks >= 5 && looks <= 6, `about one look per 120 ms over 480 ms (${looks})`);
  // Quiet for 1.5 s: the renderer's own pose again.
  clock.advance(MASCOT_TIMING.watchIdleMs - 1);
  assert.equal(rig.pose, 'watch', 'still watching just before 1.5 s');
  clock.advance(1);
  assert.equal(target.held, false);
  assert.equal(count(calls, 'restore'), 1);
  assert.equal(rig.pose, 'idle', 'back to idle');
  director.destroy();
});

test('sending hands over at once (well inside 80 ms): the watch ends, the parked hero thinks', () => {
  const { director, calls, target, rig } = setup();
  director.type(true);
  assert.equal(rig.pose, 'watch');
  target.isParked = true; // the renderer parked the hero when the prompt row went in
  director.sent();
  assert.equal(target.held, false, 'released synchronously, no timer involved');
  assert.equal(rig.pose, 'think', 'the parked hero thinks');
  director.type(false); // the composer empties itself after a send
  assert.equal(count(calls, 'restore'), 1, 'an empty draft after the send changes nothing');
  director.destroy();
});

test('blocked: eyes on the waiting card, above typing; released when it is answered', () => {
  const { director, calls, target, rig } = setup({ kind: 'stage' });
  director.type(true);
  director.setBlocked(() => ({ left: 90, top: 400, width: 200, height: 120 }));
  assert.equal(rig.pose, 'blocked', 'blocked beats watch');
  const look = calls.filter(c => c[0] === 'look').at(-1);
  assert.ok(look[2] > 0.5, `the eyes go down to the card (${look})`);
  director.stopTyping();
  assert.equal(rig.pose, 'blocked', 'still blocked after typing stops');
  director.setBlocked(null);
  assert.equal(target.held, false);
  assert.equal(rig.pose, 'shell', 'the stage acts out its call again');
  director.destroy();
});

test('offline while reconnecting (above everything); one startle when back, only after an outage', () => {
  const { director, calls, rig } = setup();
  director.setBlocked(() => ({ left: 0, top: 0, width: 10, height: 10 }));
  director.setOffline(true);
  assert.equal(rig.pose, 'offline', 'offline beats blocked');
  director.setBlocked(null);
  director.setOffline(false);
  assert.equal(rig.pose, 'idle');
  assert.deepEqual(calls.filter(c => c[0] === 'react'), [['react', 'startle']], 'one startle on reconnect');
  director.setOffline(false);
  assert.equal(count(calls, 'react'), 1, 'no startle without an outage');
  director.destroy();
});

test('success and error: once per turn, after which the rig goes idle', () => {
  const { clock, director, calls, target, rig } = setup({ kind: 'stage' });
  director.turnStarted();
  director.turnEnded('success');
  assert.deepEqual(poses(calls), ['success→idle'], 'setPose(success, { then: idle })');
  assert.equal(target.held, true);
  director.retarget();
  assert.deepEqual(poses(calls), ['success→idle'], 'not replayed');
  clock.advance(MASCOT_TIMING.oneShotMs.success);
  assert.equal(target.held, false, 'released after its time');
  assert.equal(rig.pose, 'shell');
  director.turnStarted();
  director.turnEnded('error');
  assert.deepEqual(poses(calls), ['success→idle', 'error→idle']);
  director.turnStarted();
  director.turnEnded(null);
  assert.equal(poses(calls).length, 2, 'a trivial turn: nothing');
  director.destroy();
});

test('the one-shot stays with its rig: a new stage is not posed with an old verdict', () => {
  const { director, calls, setTarget } = setup({ kind: 'stage' });
  director.turnEnded('success');
  const next = fakeTarget('stage');
  setTarget(next.target);
  assert.deepEqual(poses(next.calls), [], 'the next stage keeps its own pose');
  assert.ok(calls.some(c => c[0] === 'hold' && c[1] === false), 'the old stage was let go');
  director.destroy();
});

test('sleep: the idle hero after 90 s of quiet; input wakes it; typing, a turn or a stage keep it awake', () => {
  const { clock, director, rig, target, pageInput } = setup();
  clock.advance(MASCOT_TIMING.sleepAfterMs - 1);
  assert.equal(rig.pose, 'idle');
  clock.advance(1);
  assert.equal(rig.pose, 'sleep', 'asleep after 90 s');
  pageInput(); // the rig wakes itself on the same pointer move / key; the director lets go too
  assert.equal(target.held, false);
  assert.equal(rig.pose, 'idle');
  clock.advance(MASCOT_TIMING.sleepAfterMs);
  assert.equal(rig.pose, 'sleep', 'and sleeps again after another quiet 90 s');
  pageInput();
  director.turnStarted();
  clock.advance(MASCOT_TIMING.sleepAfterMs * 2);
  assert.equal(rig.pose, 'idle', 'never while a turn runs');
  director.turnEnded(null);
  director.type(true);
  clock.advance(MASCOT_TIMING.watchIdleMs);
  clock.advance(MASCOT_TIMING.sleepAfterMs - MASCOT_TIMING.watchIdleMs - 1);
  assert.notEqual(rig.pose, 'sleep', 'the quiet counts from the last key');
  clock.advance(MASCOT_TIMING.watchIdleMs + 1);
  assert.equal(rig.pose, 'sleep');
  director.destroy();

  const stage = setup({ kind: 'stage' });
  stage.clock.advance(MASCOT_TIMING.sleepAfterMs * 2);
  assert.equal(stage.rig.pose, 'shell', 'a stage never sleeps');
  assert.equal(stage.inputs.size, 0, 'and no page listener for it');
  stage.director.destroy();

  const parked = setup();
  parked.target.isParked = true;
  parked.director.retarget();
  parked.clock.advance(MASCOT_TIMING.sleepAfterMs * 2);
  assert.notEqual(parked.rig.pose, 'sleep', 'a parked hero (a turn starting) never sleeps');
  parked.director.destroy();
});

test('one panel animates: the visible one used last (a new stage promotes it too)', () => {
  const a = setup();
  const b = setup();
  assert.equal(a.director.isLead(), false);
  assert.equal(b.director.isLead(), true, 'the newest panel leads');
  assert.equal(a.enabled.at(-1), false, "the other panel's rigs hold still");
  a.director.touch();
  assert.deepEqual([a.director.isLead(), b.director.isLead()], [true, false]);
  assert.equal(b.enabled.at(-1), false);
  assert.equal(a.enabled.at(-1), true);
  b.setTarget(fakeTarget('stage').target);
  assert.equal(b.director.isLead(), true, 'work starting there takes the lead');
  b.director.destroy();
  assert.equal(a.director.isLead(), true, 'the survivor leads');
  a.director.destroy();

  const hidden = setup({ visible: false });
  const shown = setup();
  hidden.director.touch();
  assert.equal(shown.director.isLead(), true, 'a hidden panel never takes the lead from a visible one');
  hidden.director.destroy();
  shown.director.destroy();
});

test('destroy lets go of the rig and every timer', () => {
  const { clock, director, target, inputs } = setup();
  director.type(true);
  director.destroy();
  assert.equal(target.held, false);
  assert.equal(inputs.size, 0);
  assert.equal(clock.pending(), 0);
  director.type(true);
  assert.equal(target.held, false, 'a destroyed director does nothing');
});

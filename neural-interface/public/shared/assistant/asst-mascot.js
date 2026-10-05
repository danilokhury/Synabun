// ═══════════════════════════════════════════
// SynaBun Assistant — the panel's mascot director
// ═══════════════════════════════════════════
// The renderer (asst-render.js) owns the rigs and says which one is on screen:
// the hero (the empty state's character, parked after a send until the first
// stage takes it over) or the live rack's stage. This module dresses that one
// in the panel's own state, above the pose the renderer gives it:
//
//   offline         the socket dropped (the Reconnecting banner); one startle on reconnect
//   blocked         a card waits on you: eyes on it, two pulses, then still
//   success, error  once, when a turn that did real work ends (then idle)
//   watch           while you type: eyes on the caret column, look() at most
//                   every 120 ms; back 1.5 s after the last key, at once on send
//   sleep           the hero only, after 90 s with no input while nothing runs;
//                   the rig wakes itself on a pointer move or a key
//
// Anything else is the renderer's pose: the hero idles (thinks once parked),
// the stage acts out its call. A pose the director sets is held: the renderer
// leaves it alone until the director lets go and asks it to restore its own.
// Only one panel animates its rigs: the visible one used last (typing, focus,
// a new stage). Pure logic: the clock, timers and page input come in through
// `env`, so node:test drives it with fakes (tests/assistant-mascot.test.mjs).

export const MASCOT_TIMING = Object.freeze({
  watchEveryMs: 120,
  watchIdleMs: 1500,
  sleepAfterMs: 90_000,
  realWorkMs: 3000,
  oneShotMs: Object.freeze({ success: 1000, error: 900 }),
});

const unit = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

/**
 * The pose a turn ends with: error when it failed or its last call did,
 * success after real work (a tool call, or longer than 3 s), else none. A
 * turn the user stopped ends with nothing.
 */
export function turnEndPose({ aborted = false, errored = false, lastFailed = false, calls = 0, elapsedMs = 0 } = {}) {
  if (aborted) return null;
  if (errored || lastFailed) return 'error';
  if (Number(calls) > 0 || Number(elapsedMs) > MASCOT_TIMING.realWorkMs) return 'success';
  return null;
}

/**
 * Where a rig in `box` looks to see `point` (client px): the rig's own cursor
 * mapping, d / (d + 140) × 1.25 along the direction. `horizontal` keeps the
 * column only (watch looks along the line being typed).
 */
export function lookToward(box, point, { horizontal = false } = {}) {
  if (!box || !point || !(box.width > 0) || !Number.isFinite(point.x)) return { x: 0, y: 0 };
  const vx = point.x - (box.left + box.width / 2);
  const vy = horizontal || !Number.isFinite(point.y) ? 0 : point.y - (box.top + box.height / 2);
  const d = Math.hypot(vx, vy);
  if (d < 1) return { x: 0, y: 0 };
  const m = (d / (d + 140)) * 1.25;
  return { x: unit((vx / d) * m), y: unit((vy / d) * m) };
}

// ── One panel animates: the visible one used last ──
const directors = new Set();
let lead = null;
let seq = 0;

function elect() {
  let best = null;
  for (const d of directors) if (d.visible() && (!best || d.activeAt() > best.activeAt())) best = d;
  if (!best) for (const d of directors) if (!best || d.activeAt() > best.activeAt()) best = d;
  if (best === lead) return;
  const prev = lead;
  lead = best;
  prev?.leadChanged();
  best?.leadChanged();
}

/**
 * createMascotDirector({ getTarget, caret, setEnabled, isVisible, env })
 * getTarget() → the renderer's visible mascot { kind: 'hero'|'stage', rig, el,
 *   parked?(), hold(on), restore() } or null; caret() → the caret's client
 *   point or null; setEnabled(on) → whether this panel's rigs animate;
 *   isVisible() → the panel is on screen.
 * env: { now, setTimeout, clearTimeout, input(fn) → unsubscribe (page pointer
 *   and key input), lastInputAt() }.
 */
export function createMascotDirector({ getTarget = () => null, caret = () => null, setEnabled = () => {}, isVisible = () => true, env = {} } = {}) {
  const now = env.now || (() => Date.now());
  const later = env.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const cancel = env.clearTimeout || ((id) => clearTimeout(id));
  const pageInput = typeof env.input === 'function' ? env.input : null;
  const pageInputAt = typeof env.lastInputAt === 'function' ? env.lastInputAt : () => -Infinity;

  let destroyed = false;
  let target = null; // the rig on screen the director last dressed
  let holding = false; // hold(true) is in force on `target`
  let shown = ''; // the pose (and then) set on `target`
  let typing = false;
  let typingTimer = 0;
  let lookTimer = 0;
  let lookedAt = -Infinity;
  let blocked = null; // () → the waiting card's rect
  let offline = false;
  let oneShot = null; // { pose, target, timer }
  let turnActive = false;
  let sleeping = false;
  let sleepTimer = 0;
  let lastInput = now();
  let stopInput = null;
  let activeAt = (seq += 1);

  const safe = (fn) => { try { return fn(); } catch { return undefined; } };
  const boxOf = (t) => safe(() => t.el?.getBoundingClientRect?.()) || null;

  function desired(t) {
    if (offline) return { pose: 'offline' };
    if (blocked) {
      // The card's head (its title and command sit top left), not its centre.
      const card = safe(blocked);
      const point = card && card.width ? { x: card.left + Math.min(card.width * 0.3, 160), y: card.top + Math.min(card.height / 2, 28) } : null;
      return { pose: 'blocked', look: lookToward(boxOf(t), point) };
    }
    if (oneShot && oneShot.target === t) return { pose: oneShot.pose, opts: { then: 'idle' } };
    if (typing) return { pose: 'watch', look: lookToward(boxOf(t), safe(caret), { horizontal: true }) };
    if (sleeping && t.kind === 'hero' && !safe(() => t.parked?.())) return { pose: 'sleep' };
    return null;
  }

  /** Dress the rig on screen for the current state (or hand it back to the renderer). */
  function apply() {
    if (destroyed) return;
    const t = safe(getTarget) || null;
    if (t !== target) {
      if (target && holding) safe(() => target.hold(false));
      target = t;
      holding = false;
      shown = '';
      if (oneShot && oneShot.target !== t) dropOneShot();
      listenInput();
      armSleep();
    }
    if (!t) return;
    const want = desired(t);
    if (!want) {
      if (!holding) return;
      holding = false;
      shown = '';
      safe(() => t.hold(false));
      safe(() => t.restore());
      return;
    }
    if (!holding) { holding = true; safe(() => t.hold(true)); }
    const key = `${want.pose}|${want.opts?.then || ''}`;
    if (key !== shown) { shown = key; safe(() => t.rig.setPose(want.pose, want.opts)); }
    if (want.look) safe(() => t.rig.look(want.look.x, want.look.y));
  }

  // ── Page input: the hero sleeps after 90 s of quiet and wakes on the next input ──
  function noteInput() {
    lastInput = now();
    if (sleeping) { sleeping = false; apply(); armSleep(); }
  }

  function listenInput() {
    const want = !!target && target.kind === 'hero' && !!pageInput;
    if (want && !stopInput) stopInput = safe(() => pageInput(noteInput)) || null;
    if (!want && stopInput) { safe(stopInput); stopInput = null; }
  }

  function canSleep() {
    const t = target;
    return !destroyed && !!t && t.kind === 'hero' && !safe(() => t.parked?.()) && !turnActive && !typing && !blocked && !offline && !oneShot;
  }

  function armSleep() {
    if (sleepTimer) { cancel(sleepTimer); sleepTimer = 0; }
    if (sleeping || !canSleep()) return;
    const quiet = now() - Math.max(lastInput, pageInputAt());
    sleepTimer = later(() => {
      sleepTimer = 0;
      if (!canSleep()) return;
      if (now() - Math.max(lastInput, pageInputAt()) < MASCOT_TIMING.sleepAfterMs) { armSleep(); return; }
      sleeping = true;
      apply();
    }, Math.max(0, MASCOT_TIMING.sleepAfterMs - quiet));
  }

  // ── Typing ──
  function stopTyping() {
    if (typingTimer) { cancel(typingTimer); typingTimer = 0; }
    if (lookTimer) { cancel(lookTimer); lookTimer = 0; }
    if (!typing) return;
    typing = false;
    apply();
    armSleep();
  }

  /** The draft changed: `present` false (an empty draft) ends the watch. */
  function type(present = true) {
    if (destroyed) return;
    touch();
    noteInput();
    if (!present) { stopTyping(); return; }
    const first = !typing;
    typing = true;
    if (sleepTimer) { cancel(sleepTimer); sleepTimer = 0; }
    if (typingTimer) cancel(typingTimer);
    typingTimer = later(() => { typingTimer = 0; stopTyping(); }, MASCOT_TIMING.watchIdleMs);
    const at = now();
    if (first || at - lookedAt >= MASCOT_TIMING.watchEveryMs) {
      if (lookTimer) { cancel(lookTimer); lookTimer = 0; }
      lookedAt = at;
      apply();
    } else if (!lookTimer) {
      lookTimer = later(() => { lookTimer = 0; if (!typing) return; lookedAt = now(); apply(); }, lookedAt + MASCOT_TIMING.watchEveryMs - at);
    }
  }

  // ── One-shots ──
  function dropOneShot() {
    if (!oneShot) return;
    cancel(oneShot.timer);
    oneShot = null;
  }

  function turnEnded(pose) {
    turnActive = false;
    dropOneShot();
    const t = safe(getTarget) || null;
    if (pose && t && (pose === 'success' || pose === 'error')) {
      const shot = { pose, target: t, timer: 0 };
      shot.timer = later(() => { if (oneShot !== shot) return; oneShot = null; apply(); armSleep(); }, MASCOT_TIMING.oneShotMs[pose]);
      oneShot = shot;
    }
    apply();
    armSleep();
  }

  function touch() {
    activeAt = (seq += 1);
    elect();
  }

  const self = {
    visible: () => !destroyed && safe(isVisible) !== false,
    activeAt: () => activeAt,
    leadChanged() { if (!destroyed) safe(() => setEnabled(lead === self)); },
  };
  directors.add(self);
  touch();
  if (lead !== self) self.leadChanged();

  return {
    /** The draft changed (typing): the mascot watches the caret column. */
    type,
    /** Blur, or the draft went away. */
    stopTyping,
    /** A prompt went out: the watch hands over at once (the renderer parks the hero thinking). */
    sent() { touch(); stopTyping(); },
    /** A card waits on the user (`rectOf()` → its box), or none (null). */
    setBlocked(rectOf) {
      blocked = typeof rectOf === 'function' ? rectOf : null;
      apply();
      armSleep();
    },
    /** The socket is down (true) or back (false); coming back startles the rig once. */
    setOffline(on) {
      const next = !!on;
      if (next === offline) return;
      offline = next;
      apply();
      if (!offline) {
        const t = target;
        if (t) safe(() => t.rig.react?.('startle'));
      }
      armSleep();
    },
    turnStarted() {
      turnActive = true;
      dropOneShot();
      if (sleeping) sleeping = false;
      apply();
      armSleep();
    },
    /** The turn ended with `pose` ('success' | 'error' | null): played once on the rig on screen. */
    turnEnded,
    /** The renderer's visible mascot changed; a new stage makes this panel the one that animates. */
    retarget() {
      if (destroyed) return;
      const t = safe(getTarget) || null;
      if (t && t !== target && t.kind === 'stage') touch();
      apply();
    },
    /** The user is here (focus, a click): this panel animates. */
    touch() { touch(); noteInput(); },
    /** The host showed or hid the panel. */
    visibilityChanged() { elect(); },
    isLead: () => lead === self,
    /** For tests and devtools: what the director holds right now. */
    state: () => ({ target: target?.kind || null, pose: shown.split('|')[0] || null, typing, blocked: !!blocked, offline, sleeping, oneShot: oneShot?.pose || null, lead: lead === self }),
    destroy() {
      if (destroyed) return;
      if (target && holding) safe(() => target.hold(false));
      destroyed = true;
      for (const id of [typingTimer, lookTimer, sleepTimer]) if (id) cancel(id);
      dropOneShot();
      if (stopInput) { safe(stopInput); stopInput = null; }
      directors.delete(self);
      if (lead === self) { lead = null; elect(); }
    },
  };
}

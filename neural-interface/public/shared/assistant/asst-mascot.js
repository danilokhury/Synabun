// ═══════════════════════════════════════════
// SynaBun Assistant — the panel's mascot director
// ═══════════════════════════════════════════
// The renderer (asst-render.js) owns the rigs and says which one is on screen:
// the hero (the empty state's character; a send hands it over to the
// "Thinking" row's at once), the face of the newest open card the mascot
// presents (a follow-ups or question card: asst-ask.js, kind 'card'), the
// live rack's stage or the "Thinking" row's.
// This module dresses that one in the panel's own state, above the pose the
// renderer gives it:
//
//   offline         the socket dropped (the Reconnecting banner); one startle on reconnect
//   blocked         a card waits on you: eyes on it, two pulses, then still (never on a
//                   question card's own face, `waits`: that card asks in its own pose)
//   success, error  once, when a turn that did real work ends (then idle)
//   watch           while you type: eyes on the caret column, look() at most
//                   every 120 ms; back 1.5 s after the last key, at once on send
//   project/budget  attention owned by this panel's empty-state chip/menu;
//                   commits react once; a menu prevents idle sleep
//   sleep           the hero only, after 90 s with no input while nothing runs;
//                   the rig wakes itself on a pointer move or a key
//
// Anything else is the renderer's pose: the hero idles, the "Thinking" row's
// character thinks, the stage acts out its call. A pose the director sets is
// held: the renderer leaves it alone until the director lets go and asks it
// to restore its own. A director knows its own panel only: nothing in this
// module is shared between directors, so every open session dresses and
// animates its own character at the same time as every other one (a rig that
// is off screen parks itself: synabun-mascot.js). Pure logic: the clock,
// timers and page input come in through `env`, so node:test drives it with
// fakes (tests/assistant-mascot.test.mjs).

export const MASCOT_TIMING = Object.freeze({
  watchEveryMs: 120,
  watchIdleMs: 1500,
  controlDwellMs: 1500,
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

/**
 * createMascotDirector({ getTarget, caret, env })
 * getTarget() → the renderer's visible mascot { kind: 'hero'|'card'|'stage'|'working',
 *   rig, el, parked?(), waits?, hold(on), restore() } or null; caret() → the caret's
 *   client point or null.
 * Control API: attend(owner, { pose, rectOf, options, open }), leave(owner),
 * controlCommitted({ pose, options, reaction }); type(present, pointOf?) also
 * watches a budget amount field using the same throttling as the composer.
 * env: { now, setTimeout, clearTimeout, input(fn) → unsubscribe (page pointer
 *   and key input), lastInputAt() }.
 * All of its state is its own: one director per panel, any number at once.
 */
export function createMascotDirector({ getTarget = () => null, caret = () => null, env = {} } = {}) {
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
  let typingPoint = null;
  let attention = null; // { owner, pose, rectOf, options, open }; this panel's empty-state control
  let attentionTimer = 0;
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

  const safe = (fn) => { try { return fn(); } catch { return undefined; } };
  const boxOf = (t) => safe(() => t.el?.getBoundingClientRect?.()) || null;

  function desired(t) {
    if (offline) return { pose: 'offline' };
    // A question card's own face is the card that waits: it asks in its own pose (asst-ask.js), never "blocked" at itself.
    if (blocked && !t.waits) {
      // The card's head (its title and command sit top left), not its centre.
      const card = safe(blocked);
      const point = card && card.width ? { x: card.left + Math.min(card.width * 0.3, 160), y: card.top + Math.min(card.height / 2, 28) } : null;
      return { pose: 'blocked', look: lookToward(boxOf(t), point) };
    }
    const attentionLook = () => {
      const rect = attention && safe(attention.rectOf);
      return lookToward(boxOf(t), rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    };
    if (oneShot && oneShot.target === t) return { pose: oneShot.pose, opts: oneShot.opts || { then: 'idle' }, ...(attention ? { look: attentionLook() } : {}) };
    if (typing) return { pose: 'watch', look: lookToward(boxOf(t), safe(typingPoint || caret), { horizontal: true }) };
    if (sleeping && t.kind === 'hero' && !safe(() => t.parked?.())) return { pose: 'sleep' };
    if (attention && t.kind === 'hero' && !safe(() => t.parked?.())) {
      return { pose: attention.pose, opts: safe(attention.options) || {}, look: attentionLook() };
    }
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
    const key = `${want.pose}|${want.opts?.then || ''}|${!!want.opts?.unlimited}`;
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
    return !destroyed && !!t && t.kind === 'hero' && !safe(() => t.parked?.()) && !turnActive && !typing && !attention?.open && !blocked && !offline && !oneShot;
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
    typingPoint = null;
    apply();
    armSleep();
  }

  /** The draft changed: `present` false (an empty draft) ends the watch. */
  function type(present = true, pointOf = null) {
    if (destroyed) return;
    noteInput();
    if (!present) { stopTyping(); return; }
    if (oneShot?.control) dropOneShot(); // a new edit resumes watching after an acknowledgement
    const first = !typing;
    typing = true;
    typingPoint = typeof pointOf === 'function' ? pointOf : null;
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

  function clearAttention() {
    if (attentionTimer) { cancel(attentionTimer); attentionTimer = 0; }
    attention = null;
  }

  return {
    /** The draft changed (typing): the mascot watches the caret column. */
    type,
    /** Blur, or the draft went away. */
    stopTyping,
    /** Chip previews relax after a short dwell; only open menus hold attention and block sleep. */
    attend(owner, spec) {
      if (destroyed || (attention?.open && attention.owner !== owner && !spec.open)) return;
      noteInput();
      clearAttention();
      attention = { owner, ...spec };
      if (!attention.open) attentionTimer = later(() => {
        clearAttention();
        apply();
        armSleep();
      }, MASCOT_TIMING.controlDwellMs);
      apply();
      armSleep();
    },
    leave(owner) {
      if (attention?.owner !== owner) return;
      clearAttention();
      apply();
      armSleep();
    },
    /** Only acknowledged user commits call this; loads, live updates and keystrokes do not. */
    controlCommitted({ pose, options = {}, reaction = 'nod' }) {
      if (destroyed) return;
      const t = safe(getTarget);
      if (!t || t.kind !== 'hero' || safe(() => t.parked?.()) || turnActive || offline || blocked) return;
      stopTyping();
      noteInput();
      dropOneShot();
      const shot = { pose, opts: options, target: t, timer: 0, control: true };
      shot.timer = later(() => { if (oneShot !== shot) return; oneShot = null; apply(); armSleep(); }, 900);
      oneShot = shot;
      apply();
      safe(() => t.rig.react(reaction));
      armSleep();
    },
    /** A prompt went out: the watch hands over at once (the renderer gives the hero to the "Thinking" row). */
    sent() { clearAttention(); dropOneShot(); stopTyping(); apply(); armSleep(); },
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
      clearAttention();
      dropOneShot();
      if (sleeping) sleeping = false;
      apply();
      armSleep();
    },
    /** The turn ended with `pose` ('success' | 'error' | null): played once on the rig on screen. */
    turnEnded,
    /** The renderer's visible mascot changed. */
    retarget() { apply(); },
    /** The user is here (focus, a click): a sleeping hero wakes, the quiet starts over. */
    touch() { if (!destroyed) noteInput(); },
    /** For tests and devtools: what the director holds right now. */
    state: () => ({ target: target?.kind || null, pose: shown.split('|')[0] || null, typing, attention: attention?.pose || null, menuOpen: !!attention?.open, blocked: !!blocked, offline, sleeping, oneShot: oneShot?.pose || null }),
    destroy() {
      if (destroyed) return;
      if (target && holding) safe(() => target.hold(false));
      destroyed = true;
      clearAttention();
      for (const id of [typingTimer, lookTimer, sleepTimer]) if (id) cancel(id);
      dropOneShot();
      if (stopInput) { safe(stopInput); stopInput = null; }
    },
  };
}

/** Wire one empty-state chip and its body-level menu to its panel's director. No rig or clock here. */
export function createMascotControl(anchor, { director = () => null, pose, options = () => ({}) } = {}) {
  const owner = {};
  let menu = null, preview = null, watched = false, destroyed = false;
  const listeners = [];
  const listen = (node, event, fn) => { node.addEventListener(event, fn); listeners.push(() => node.removeEventListener(event, fn)); };
  function attend(node = anchor) {
    if (destroyed) return;
    preview = node;
    director()?.attend(owner, { pose, options, open: !!menu, rectOf: () => node.getBoundingClientRect() });
  }
  const leave = () => { if (!menu) { preview = null; director()?.leave(owner); } };
  listen(anchor, 'pointerenter', () => attend(menu || anchor));
  listen(anchor, 'focus', () => attend(menu || anchor));
  listen(anchor, 'pointerleave', () => { if (document.activeElement !== anchor) leave(); });
  listen(anchor, 'blur', leave);
  let stopMenu = () => {};
  return {
    open(node) {
      if (destroyed || !node) return;
      stopMenu();
      menu = node;
      const follow = e => {
        const option = e.target.closest?.('.asst-dd-item, input, label, button');
        if (option && node.contains(option)) attend(option);
      };
      const type = e => {
        if (!e.target.matches?.('.asst-budget-input')) return;
        watched = true;
        director()?.type(true, () => {
          const r = e.target.getBoundingClientRect();
          return { x: r.left + Math.min(r.width - 12, 12 + e.target.value.length * 7), y: r.top + r.height / 2 };
        });
      };
      node.addEventListener('pointerover', follow);
      node.addEventListener('focusin', follow);
      node.addEventListener('input', type);
      stopMenu = () => {
        node.removeEventListener('pointerover', follow);
        node.removeEventListener('focusin', follow);
        node.removeEventListener('input', type);
      };
      attend(node.contains(document.activeElement) ? document.activeElement : node);
    },
    close() {
      stopMenu(); menu = null; preview = null;
      if (watched) { director()?.stopTyping(); watched = false; }
      director()?.leave(owner);
    },
    commit(reaction) { if (!destroyed) director()?.controlCommitted({ pose, options: options(), reaction }); },
    refresh() { if (preview) attend(preview); },
    destroy() {
      this.close(); destroyed = true;
      for (const off of listeners) off();
    },
  };
}

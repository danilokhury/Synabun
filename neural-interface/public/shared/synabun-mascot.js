// ═══════════════════════════════════════════
// SynaBun mascot — pill eyes and a smile, rig v2
// ═══════════════════════════════════════════
// The onboarding character (onboarding.html initEyesSVG / updateEyesSVG): the
// same 280×140 geometry and blink timing, as a module any page can mount, now
// a small rig that acts out what the Assistant is doing. Every pose is a pure
// function of time (poseFrame) over a few parameters per eye, the mouth and
// the face, plus one prop drawn in the face's own pill geometry. Rigs draw
// from the shared ticker (shared/synabun-ticker.js): 30 fps while a pose
// loops, 60 fps for blends and reactions, no frames at all while still. One
// loop, one pointermove listener and one IntersectionObserver serve every rig,
// and every rig that is active and on screen plays its own pose: N rigs move
// at once, each on its own clock. No rig waits for another; a host that wants
// one moving character among several of its own (an Assistant panel's hero,
// stage and "Thinking" row) says so with setActive(). Under
// prefers-reduced-motion every pose is its still frame and changes are
// instant. A rig tears itself down once its SVG leaves the document.
//
// v1 callers are unchanged: createMascot(container, opts) → { el, destroy,
// look, blink }, idle, blinking every 3-7 s and following the cursor.

/**
 * @module synabun-mascot
 *
 * ## Mount
 * `createMascot(container?, opts?)` appends the SVG to `container` (or returns
 * it unattached as `el` when the first argument is the options object).
 * Options: `width` (128), `height` (64), `className` ('synabun-mascot'),
 * `pose` ('idle'), `poseOptions`, `active` (true unless `false`), and the v1
 * `rangeX` / `rangeY`, which can only widen the v2 cursor travel (±20 × ±12
 * viewBox units).
 *
 * ## Instance
 * - `el` — the `<svg>`.
 * - `setPose(name, opts?)` — blends from the current frame over 160 ms
 *   (cubic-bezier(.2,0,.38,.9)). Names: `MASCOT_POSES`; unknown → 'idle'.
 *   `opts.count` 1-3 (subagent minis), `opts.mode` 'recall' | 'remember'
 *   (memory), `opts.ticks` 0-3 (plan), `opts.then` a pose to blend to once a
 *   one-shot (success, error, blocked) has played and held. The same pose with
 *   a new count or ticks keeps its loop running. `opts.unlimited` selects the
 *   budget pose's relaxed infinity variant; project peeks into a folder.
 *   The card poses (`MASCOT_CARD_POSES`, the Assistant's follow-ups and
 *   question cards): `present` (a warm smile toward what it offers), `pick`
 *   (the plan's clipboard, one tick per picked item: `opts.ticks`) and `ask`
 *   (a tilted head and a question mark); all three are still between blinks
 *   and look where look() points.
 * - `react(name)` — `MASCOT_REACTIONS`: hop (spring, at most one per 600 ms),
 *   wince, nod, pop (plan: pops the newest tick; ticks the next box too
 *   unless setPose passed `ticks`), startle, pulse, click
 *   (computer: a ripple). While one plays the SVG carries `syna-react-<name>`,
 *   removed when it ends and on `animationend`.
 * - `look(x, y)` — gaze in [-1, 1] on both axes. Idle: a cursor that moved in
 *   the last 2.5 s wins. watch / computer / runs / wait / blocked follow it.
 * - `blink()` — one blink.
 * - `point(target | null, { poke, gap })` — rubber-hose arms (rig v3): the
 *   arm on the side of `target` (an element, a client rect or a client point)
 *   sprouts from the face's lower outer side with a springy overshoot, grows
 *   until its fingertip stops `gap` px short of the target and aims its hand
 *   (a round palm, one index pill and a thumb nub, in the eyes' pill
 *   language) along the line from the hand to the target, on a spring; the
 *   eyes look there too, never far enough to come to the arm; null (or a
 *   target on the other side) sends it back into the body, quicker than it
 *   grew. Pointing again re-measures and carries on from the springs' state.
 *   Rects are read when it is called and again after a resize or scroll,
 *   never per frame. No part of an arm ever crosses an eye or the smile. Only
 *   on a rig at least 96 px wide (`opts.arms` overrides): never a mini, a
 *   cameo or a still. Under reduced motion the arm shows its final pose at once.
 * - `poke()` — two quick pokes along the line to the target (a beat landed).
 * - `nudge(vx, vy)` — the host moved the character's box and its velocity
 *   changed by (vx, vy) px/s: the arms trail, then wobble back.
 * - `shift(dx, dy)` — the host moved the box by (dx, dy) px since the last
 *   measure: the hand keeps pointing at the same place (no layout read).
 * - `remeasure()` — read the rects again (the host's move has landed).
 * - `armExtent()` — the client box the pointing arm takes once grown, or null.
 * - `pointing` — the target, or null.
 * - `setActive(bool)` — false unsubscribes and shows the pose's still frame
 *   (no loops, no tracking); true resumes.
 * - `pose` — the current pose name (also the SVG's `data-pose`); `fps` — the
 *   rate it draws at now (0 = still).
 * - `destroy()` — releases everything; idempotent.
 *
 * ## Pure helpers (Node-safe)
 * - `poseFrame(name, t, opts?)` → `{ eyes: [{dx,dy,sx,sy,rot} ×2],
 *   mouth: {w,c,dx,dy,rot,op}, face: {dx,dy,rot,op}, prop: {name, …} }`,
 *   `t` in ms since the pose began; opts: look {x,y}, range {x,y}, count,
 *   mode, ticks, still. Deterministic; unknown names fall back to idle.
 * - `stillFrame(name, opts?)` — the frame reduced motion shows.
 * - `reactionFrame(frame, name, p)` — a reaction `p` (0-1) of the way in.
 * - `mouthPath(mouth)` — the mouth's `d`.
 * - `paintMascot(svg, frame)` — draw a frame on any `mascotSvg()`. A still
 *   frame (`stillFrame`, or a rig that is not looping) draws its prop at
 *   ≥ .7 opacity with strokes of ≥ 1.5 CSS px, so it reads at 28×14.
 * - `mascotCameoSvg()` — two 3×7 px pill eyes (`syna-cameo` /
 *   `syna-cameo-eye`) for running pills, leaning −12° like the two-pill mark
 *   (never a pause glyph); the host's CSS animates them.
 * - `mascotPropSvg(kind, { width, height })` + `paintMascotProp(svg, kind)`
 *   — a kind's prop alone, framed to its own box: the ledger's row glyphs.
 * - `mascotBounds(pose)` — the face-unit box a pose can draw in (the eyes over
 *   their travel, the smile, its prop): what a host keeps its drawing out of.
 * - Arms: `createArmSim`, `armRest`, `armAim`, `armSide`, `armTargeting`,
 *   `armWidths`, `armPath`, `armHandPath`, `armDrawPath`, `armGaze`,
 *   `armKeepOut`, `MASCOT_ARM`.
 * - v1: `mascotSvg`, `mascotRefs`, `poseMascot`, `blinkAmount`, `MASCOT_VIEWBOX`.
 */

import {
  isReducedMotion, lastInputAt, now as tickerNow, onKey, onPointer, onReducedMotionChange,
  pointerPosition, requestFrames, subscribe,
} from './synabun-ticker.js';

export const MASCOT_VIEWBOX = '0 0 280 140';

/** One pose per tool kind (shared with the activity rack's kind ids). */
export const MASCOT_KINDS = Object.freeze(['shell', 'read', 'edit', 'search', 'web', 'subagent', 'plan', 'memory', 'runs', 'computer', 'think', 'mcp']);
export const MASCOT_STATES = Object.freeze(['idle', 'sleep', 'watch', 'wait', 'success', 'error', 'blocked', 'offline']);
/** The Assistant's cards the mascot presents (asst-ask.js): next steps and confirms, decisions, questions. */
export const MASCOT_CARD_POSES = Object.freeze(['present', 'pick', 'ask']);
export const MASCOT_POSES = Object.freeze([...MASCOT_KINDS, ...MASCOT_STATES, 'project', 'budget', 'skill', ...MASCOT_CARD_POSES]);
export const MASCOT_REACTIONS = Object.freeze(['hop', 'wince', 'nod', 'pop', 'startle', 'pulse', 'click']);

/** The character's SVG. Colour comes from `currentColor` (the mouth at 25 %). */
export function mascotSvg({ width = 280, height = 140, className = '' } = {}) {
  return `<svg${className ? ` class="${className}"` : ''} viewBox="${MASCOT_VIEWBOX}" width="${width}" height="${height}" style="overflow:visible" aria-hidden="true" focusable="false">`
    + '<g class="syna-face">'
    + '<g class="syna-eye"><g class="syna-lid"><rect x="80" y="24" width="38" height="72" rx="19" fill="currentColor"/></g></g>'
    + '<g class="syna-eye"><g class="syna-lid"><rect x="162" y="24" width="38" height="72" rx="19" fill="currentColor"/></g></g>'
    + '<path class="syna-mouth" d="M118,116 Q140,130 162,116" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2.5" stroke-linecap="round"/>'
    + '<g class="syna-props"></g>'
    + '</g></svg>';
}

export function mascotRefs(root) {
  return {
    lids: root.querySelectorAll('.syna-lid'),
    mouth: root.querySelector('.syna-mouth'),
    face: root.querySelector('.syna-face'),
    props: root.querySelector('.syna-props'),
  };
}

/**
 * v1 pose: look in [-1, 1] on both axes, blink in [0, 1] (1 = shut).
 * Travel is in viewBox units; onboarding's full-page character uses 4 × 3.
 */
export function poseMascot(refs, lookX, lookY, blink, now, { rangeX = 4, rangeY = 3 } = {}) {
  const moveX = lookX * rangeX;
  const moveY = lookY * rangeY;
  const cy = 60;
  const vScale = Math.max(0.06, 1 - blink * 0.94);
  refs.lids.forEach((lid) => {
    lid.setAttribute('transform', `translate(${moveX},${moveY}) translate(0,${cy}) scale(1,${vScale}) translate(0,${-cy})`);
  });
  // The mouth follows at half the travel, with a slow wobble.
  const t = (now || 0) * 0.001;
  refs.mouth?.setAttribute('transform', `translate(${moveX * 0.5 + Math.sin(t * 0.7) * 1.2},${moveY * 0.5 + Math.cos(t * 1.1) * 0.8})`);
}

/** Lid closure `elapsed` ms into a blink: 90 ms closing, 60 ms shut, 130 ms opening. */
export function blinkAmount(elapsed) {
  if (!(elapsed >= 0)) return 0;
  if (elapsed < 90) return elapsed / 90;
  if (elapsed < 150) return 1;
  if (elapsed < 280) return 1 - (elapsed - 150) / 130;
  return 0;
}

/**
 * Two 3×7 px pill eyes for a running pill; the host's CSS moves them. The
 * pair leans −12° like the two-pill mark (the right eye sits higher), so it
 * never reads as a pause glyph. The eyes stay untransformed for the CSS glance.
 */
export function mascotCameoSvg({ className = '' } = {}) {
  return `<svg class="syna-cameo${className ? ` ${className}` : ''}" viewBox="0 0 10 7" width="10" height="7" style="overflow:visible" aria-hidden="true" focusable="false">`
    + '<g class="syna-cameo-pair" transform="rotate(-12 5 3.5)">'
    + '<rect class="syna-cameo-eye" x="0" y="0" width="3" height="7" rx="1.5" fill="currentColor"/>'
    + '<rect class="syna-cameo-eye" x="7" y="0" width="3" height="7" rx="1.5" fill="currentColor"/>'
    + '</g></svg>';
}

/** Each prop's own box in face units, to draw it alone (a ledger row's glyph, a suggestion's). */
const PROP_BOX = Object.freeze({
  project: [204, 77, 62, 48],
  budget: [212, 65, 54, 60],
  skill: [209, 25, 71, 96],
  ask: [210, 0, 46, 66],
  shell: [144, 116, 42, 26], // the last keycap and the caret
  read: [65, 20, 150, 88],
  edit: [188, 93, 56, 44],
  search: [215, 31, 48, 46],
  web: [216, 10, 44, 40],
  subagent: [216, 38, 68, 44],
  plan: [14, 17, 50, 67],
  memory: [210, 2, 48, 48],
  runs: [211, 16, 46, 46],
  computer: [219, 60, 30, 38],
  think: [202, -2, 52, 42],
  mcp: [16, 68, 42, 72],
});

/**
 * A kind's prop alone, framed to its own box: the glyph a ledger row shows
 * so rows differ at a squint. Paint it with paintMascotProp. '' for a kind
 * without a prop.
 */
export function mascotPropSvg(kind, { width = 24, height = 16, className = '' } = {}) {
  const box = PROP_BOX[kind];
  if (!box) return '';
  return `<svg class="syna-prop-glyph${className ? ` ${className}` : ''}" viewBox="${box.join(' ')}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">`
    + '<g class="syna-face"><g class="syna-props"></g></g></svg>';
}

// ── Math ──

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = v => clamp(v, 0, 1);
const unit = v => clamp(Number(v) || 0, -1, 1);
const lerp = (a, b, p) => a + (b - a) * p;
const mod = (a, n) => ((a % n) + n) % n;
const smooth = p => p * p * (3 - 2 * p);
const easeOut = p => 1 - (1 - p) ** 3;
const intIn = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return v != null && Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
};
/** 0 → 1 → 0 across [start, start + dur). */
const bump = (t, start, dur) => {
  const p = (t - start) / dur;
  return p > 0 && p < 1 ? Math.sin(Math.PI * p) : 0;
};
/** A blink stretched over `dur` ms (the patient poses blink slowly). */
const blinkOver = (elapsed, dur) => blinkAmount(elapsed * 280 / dur);
/** Attribute number: two decimals, never "-0". */
const n = (v) => {
  const r = Math.round(v * 100) / 100;
  return String(r === 0 ? 0 : r);
};

function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const X = s => ((ax * s + bx) * s + cx) * s;
  const Y = s => ((ay * s + by) * s + cy) * s;
  const dX = s => (3 * ax * s + 2 * bx) * s + cx;
  return (x) => {
    if (!(x > 0)) return 0;
    if (x >= 1) return 1;
    let s = x;
    for (let i = 0; i < 8; i += 1) {
      const err = X(s) - x;
      if (Math.abs(err) < 1e-6) return Y(s);
      const d = dX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
      if (s < 0 || s > 1) break;
    }
    let lo = 0;
    let hi = 1;
    s = x;
    for (let i = 0; i < 30; i += 1) {
      const v = X(s);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = s; else hi = s;
      s = (lo + hi) / 2;
    }
    return Y(s);
  };
}

/** --asst-ease-standard: every blend. */
const easeStandard = cubicBezier(0.2, 0, 0.38, 0.9);
/** --asst-ease-spring, linear(0, 0.35 9%, 0.78 21%, 1.03 40%, 0.99 60%, 1): hops and snaps. */
const SPRING = [[0, 0], [0.09, 0.35], [0.21, 0.78], [0.4, 1.03], [0.6, 0.99], [1, 1]];
function springEase(p) {
  if (!(p > 0)) return 0;
  if (p >= 1) return 1;
  for (let i = 1; i < SPRING.length; i += 1) {
    const [x1, y1] = SPRING[i];
    if (p <= x1) {
      const [x0, y0] = SPRING[i - 1];
      return y0 + (y1 - y0) * (p - x0) / (x1 - x0);
    }
  }
  return 1;
}

// ── Frames ──

const EYE_CX = [99, 181];
const EYE_CY = 60;
const RANGE = { x: 20, y: 12 }; // cursor travel, viewBox units
const ZERO = Object.freeze({ x: 0, y: 0 });

const eye = (dx = 0, dy = 0, sx = 1, sy = 1, rot = 0) => ({ dx, dy, sx, sy, rot });
const mouth = (w = 44, c = 14, dx = 0, dy = 0, rot = 0, op = 0.25) => ({ w, c, dx, dy, rot, op });
const blankFrame = () => ({ eyes: [eye(), eye()], mouth: mouth(), face: { dx: 0, dy: 0, rot: 0, op: 1 }, prop: { name: null } });

/** Gaze: both eyes travel, the mouth follows at `mouthK`, the far eye foreshortens. */
function gaze(f, look, range, mouthK = 0.5) {
  const x = look.x * range.x;
  const y = look.y * range.y;
  for (const e of f.eyes) { e.dx += x; e.dy += y; }
  f.mouth.dx += x * mouthK;
  f.mouth.dy += y * mouthK;
  f.eyes[1].sx *= 1 - 0.06 * clamp01(look.x);
  f.eyes[0].sx *= 1 - 0.06 * clamp01(-look.x);
  return f;
}

/** The runs / wait poses: patient half-lids, a slow blink every 6 s, the gaze on look(). */
function patientPose(prop) {
  return {
    motion: 'blink',
    look: 150,
    frame(t, o) {
      const f = blankFrame();
      const c = o.still ? 0 : mod(t, 6000);
      const k = 1 - 0.94 * (c >= 5520 ? blinkOver(c - 5520, 480) : 0);
      f.eyes = [eye(0, 3, 1, 0.42 * k, 0), eye(0, 3, 1, 0.5 * k, 0)];
      f.mouth = mouth(26, 3, 0, 0, 0, 0.25);
      gaze(f, o.look, { x: o.range.x * 0.6, y: o.range.y * 0.6 });
      f.prop = { name: prop };
      return f;
    },
    /** ms until the pose moves again; 0 while it blinks. */
    idleFor(t) {
      const c = mod(t, 6000);
      return c < 5520 ? 5520 - c : 0;
    },
  };
}

const KEY_BEATS = [0, 420, 700, 1380, 1760]; // five irregular keystrokes per 2.48 s
const KEY_ORDER = [0, 2, 1, 2, 0];
const READ_STOPS = [-9, -3, 3, 9];
const SEARCH_POINTS = [[-9, -4], [7, -6], [10, 3], [-3, 5], [-10, 1], [4, -2]];
// Mini eye-pairs [x, y, scale] per count, right of the face (face coordinates;
// the parent steps 20 units left to make room).
const MINIS = [
  [[250, 60, 0.5]],
  [[246, 40, 0.42], [256, 94, 0.34]],
  [[242, 28, 0.36], [262, 68, 0.3], [242, 106, 0.28]],
];

/**
 * motion: 'loop' (30 fps), 'blink' (still between slow blinks),
 * 'once' (plays `settle` ms, then still; `hold` before opts.then), 'still'.
 * blinks: random blinks every 3-7 s. tracks: follows the cursor.
 * look: follows look(), easing with this time constant (ms).
 */
const POSES = {
  // Empty-state controls: host-directed gaze, the same ticker and prop painter as tool kinds.
  project: {
    motion: 'loop', blinks: true, look: 70,
    frame(t, o) {
      const f = blankFrame();
      const peek = o.still ? 0.5 : (1 + Math.sin(TAU * t / 2400)) / 2;
      f.eyes = [eye(0, 2 + 2 * peek, 1, 0.92, -2), eye(0, 2 + 2 * peek, 1, 0.96, 2)];
      f.mouth = mouth(34, 11);
      gaze(f, o.look, { x: 16, y: 10 });
      f.prop = { name: 'project', peek };
      return f;
    },
  },
  budget: {
    motion: 'loop', blinks: true, look: 70,
    frame(t, o) {
      const f = blankFrame();
      const lift = o.still ? 0 : Math.sin(TAU * t / 2200);
      f.eyes = [eye(0, 0, 1, o.unlimited ? 0.65 : 0.93, -3), eye(0, 0, 1, o.unlimited ? 0.65 : 1, 3)];
      f.mouth = mouth(o.unlimited ? 48 : 34, o.unlimited ? 20 : 11);
      gaze(f, o.look, { x: 16, y: 10 });
      f.prop = { name: 'budget', lift, unlimited: o.unlimited };
      return f;
    },
  },
  skill: { // writing a reusable skill: a little scroll, then a pleased sparkle
    motion: 'loop', blinks: true,
    frame(t, o) {
      const f = blankFrame();
      const c = mod(t, 3000);
      const draw = o.still ? 0.85 : clamp01(c / 1800);
      const spark = o.still ? 1 : bump(c, 1800, 900);
      f.face.rot = -3 * (1 - spark);
      f.eyes = [eye(5 + 2 * draw, 6, 1, 0.8 - 0.18 * spark, -3), eye(5 + 2 * draw, 6, 1, 0.94 - 0.2 * spark, 2)];
      f.mouth = mouth(30 + 10 * spark, 8 + 8 * spark, 3, -1);
      f.prop = { name: 'skill', draw, spark, jig: o.still || draw >= 1 ? 0 : Math.sin(TAU * c / 300) };
      return f;
    },
  },
  // Cards the mascot presents (asst-ask.js): still between blinks, the gaze on the option the host points at.
  present: { // next steps, a confirm: a warm smile, the head turned a little toward what it offers
    motion: 'still', blinks: true, look: 70,
    frame(t, o) {
      const f = blankFrame();
      f.eyes = [eye(0, 2, 1, 0.94, -2), eye(0, 2, 1, 0.98, 2)];
      f.mouth = mouth(40, 18, 0, -1);
      f.face.rot = -2;
      return gaze(f, o.look, { x: 16, y: 10 });
    },
  },
  pick: { // decisions: the plan's clipboard ticks a box per picked item (opts.ticks)
    motion: 'still', blinks: true, look: 70,
    frame(t, o) {
      const f = blankFrame();
      f.eyes = [eye(0, 1, 1.02, 0.9, 0), eye(0, 1, 0.98, 0.86, 2)];
      f.mouth = mouth(30, 8);
      gaze(f, o.look, { x: 14, y: 9 });
      f.prop = { name: 'plan', ticks: o.ticks, pop: 1 };
      return f;
    },
  },
  ask: { // a question: the head tilts, one eye wider, a small round mouth, a question mark beside it
    motion: 'still', blinks: true, look: 70,
    frame(t, o) {
      const f = blankFrame();
      f.face.rot = 5;
      f.eyes = [eye(0, -2, 1.02, 1.06, 0), eye(0, -1, 0.98, 0.9, 3)];
      f.mouth = mouth(16, 7, 2, 1, 0, 0.3);
      gaze(f, o.look, { x: 14, y: 9 });
      f.prop = { name: 'ask' };
      return f;
    },
  },
  // ── States ──
  idle: {
    motion: 'still', blinks: true, tracks: true,
    frame(t, o) {
      return gaze(blankFrame(), o.look, o.range);
    },
  },
  sleep: {
    motion: 'loop',
    frame(t, o) {
      const f = blankFrame();
      const b = o.still ? 0 : Math.sin(TAU * t / 6000);
      const sy = 0.1 + 0.02 * b;
      f.eyes = [eye(-1, 9, 1.04, sy, 0), eye(1, 9, 1.04, sy * 0.92, 0)];
      f.mouth = mouth(22, 3, 0, 1, 0, 0.2);
      f.face.dy = b;
      return f;
    },
  },
  watch: {
    motion: 'still', blinks: true, look: 47,
    frame(t, o) {
      const f = blankFrame();
      f.eyes = [eye(0, 10, 1, 1.05, 0), eye(0, 10, 1, 1.02, 0)];
      f.mouth = mouth(24, 6, 0, 1, 0, 0.25);
      return gaze(f, { x: o.look.x, y: 0 }, { x: o.range.x * 0.8, y: 0 });
    },
  },
  wait: patientPose(null),
  success: {
    motion: 'once', settle: 900, hold: 1200,
    frame(t, o) {
      const f = blankFrame();
      const tt = o.still ? 900 : t;
      const happy = tt >= 290; // the eyes turn happy while the lids are shut
      const k = 1 - 0.94 * (tt < 480 ? blinkAmount(tt - 200) : 0);
      const lift = easeOut(clamp01(tt / 200));
      const tilt = 8 * easeOut(clamp01((tt - 290) / 300));
      const sy = happy ? 0.3 : lerp(1, 1.06, lift);
      const dy = happy ? -4 : -3 * lift;
      f.eyes = [eye(0, dy, 1.06, sy * k, -tilt), eye(0, dy, 1.06, sy * k, tilt)];
      const smile = easeOut(clamp01(tt / 300));
      f.mouth = mouth(lerp(44, 58, smile), lerp(14, 22, smile), 0, -smile, 0, lerp(0.25, 0.4, smile));
      f.face.dy = -2.5 * bump(tt, 480, 360);
      return f;
    },
  },
  error: {
    motion: 'once', settle: 120, hold: 1800,
    frame(t, o) {
      const f = blankFrame();
      const e = o.still ? 1 : easeOut(clamp01(t / 120));
      f.face.dy = 2 * e;
      f.eyes = [eye(1.5 * e, 2 * e, 0.96, lerp(1, 0.8, e), 12 * e), eye(-1.5 * e, 2 * e, 0.96, lerp(1, 0.74, e), -12 * e)];
      f.mouth = mouth(lerp(44, 34, e), lerp(14, -10, e), 0, 2 * e, 0, lerp(0.25, 0.32, e));
      return f;
    },
  },
  blocked: { // two pulses, then still; the eyes stay on what it waits for (look())
    motion: 'once', settle: 1200, look: 47,
    frame(t, o) {
      const f = blankFrame();
      const g = 1 + 0.05 * (o.still || t >= 1200 ? 0 : Math.sin(Math.PI * mod(t, 600) / 600));
      f.eyes = [eye(0, -2, 1.02 * g, 1.1 * g, 0), eye(0, -2, 1.02 * g, 1.14 * g, 0)];
      f.mouth = mouth(20, 0, 0, 1, 0, 0.3);
      return gaze(f, o.look, { x: o.range.x * 0.6, y: o.range.y * 0.6 });
    },
  },
  offline: {
    motion: 'still',
    frame() {
      const f = blankFrame();
      f.eyes = [eye(0, 5, 1, 0.42, 0), eye(0, 5, 1, 0.46, 0)];
      f.mouth = mouth(30, 0, 0, 1, 0, 0.25);
      f.face.op = 0.5;
      return f;
    },
  },

  // ── Kinds ──
  shell: {
    motion: 'loop', blinks: true,
    frame(t, o) {
      const f = blankFrame();
      f.eyes = [eye(-1, 10, 1, 0.58, 3), eye(1, 10, 1, 0.62, -3)];
      f.mouth = mouth(30, 1.5, 0, 0, 0, 0.25);
      let nod = 0;
      let key = -1;
      if (!o.still) {
        const c = mod(t, 2480);
        KEY_BEATS.forEach((beat, i) => {
          const b = bump(c, beat, 110);
          if (b > 0) { nod = b; key = KEY_ORDER[i]; }
        });
      }
      f.face.dy = 1.6 * nod;
      // The keys stay put while the head nods over them.
      f.prop = { name: 'shell', key, press: nod, caret: o.still || mod(t, 1060) < 530 ? 1 : 0, dy: -f.face.dy };
      return f;
    },
  },
  read: {
    motion: 'loop',
    frame(t, o) {
      const f = blankFrame();
      let x = READ_STOPS[1];
      let b = 0;
      if (!o.still) {
        const c = mod(t, 1800);
        if (c < 1540) {
          const i = Math.min(3, Math.floor(c / 385));
          x = i === 0 ? READ_STOPS[0] : lerp(READ_STOPS[i - 1], READ_STOPS[i], easeOut(clamp01((c - i * 385) / 70)));
        } else {
          // Carriage return: back to the start of the line with a blink.
          x = lerp(READ_STOPS[3], READ_STOPS[0], smooth((c - 1540) / 260));
          b = blinkOver(c - 1540, 260);
        }
      }
      const k = 1 - 0.94 * b;
      f.eyes = [eye(x - 0.6, 4.5, 1, 0.86 * k, 0), eye(x + 0.6, 4, 1, 0.9 * k, 0)];
      f.mouth = mouth(30, 7, x * 0.25, 0, 0, 0.25);
      f.prop = { name: 'read' };
      return f;
    },
  },
  edit: {
    motion: 'loop', blinks: true,
    frame(t, o) {
      const f = blankFrame();
      const draw = o.still ? 0.6 : mod(t, 2520) / 2520;
      const follow = (draw - 0.5) * 4; // the eyes ride the pencil
      f.face.rot = -4;
      f.eyes = [eye(5 + follow, 9, 1, 0.5, -3), eye(5 + follow, 9, 1, 0.9, 0)];
      f.mouth = mouth(26, 6, 8, -1, -10, 0.25);
      f.prop = { name: 'edit', draw, jig: o.still ? 0 : 1.2 * Math.sin(TAU * t / 420) };
      return f;
    },
  },
  search: {
    motion: 'loop', blinks: true,
    frame(t, o) {
      const f = blankFrame();
      let x = 2;
      let y = -1;
      if (!o.still) {
        // Saccades: a 150 ms jump, a 270 ms hold, six points.
        const c = mod(t, 2520);
        const i = Math.floor(c / 420);
        const e = easeStandard(clamp01((c - i * 420) / 150));
        const [x0, y0] = SEARCH_POINTS[(i + 5) % 6];
        const [x1, y1] = SEARCH_POINTS[i];
        x = lerp(x0, x1, e);
        y = lerp(y0, y1, e);
      }
      f.eyes = [eye(x, y, 0.94, 1.06, 0), eye(x, y, 0.94, 1.1, 0)];
      f.mouth = mouth(16, 1, x * 0.4, 1 + y * 0.3, 0, 0.25);
      const a = o.still ? 0 : TAU * t / 1400;
      f.prop = { name: 'search', x: x * 0.5 + 1.3 * Math.cos(a), y: y * 0.5 + 1.3 * Math.sin(a) };
      return f;
    },
  },
  web: {
    motion: 'loop', blinks: true,
    frame(t, o) {
      const f = blankFrame();
      f.eyes = [eye(9, -3, 0.97, 0.92, 0), eye(9, -3, 1.02, 0.98, 0)];
      f.mouth = mouth(26, 6, 5, -1, -3, 0.25);
      f.prop = { name: 'web', spin: o.still ? 0.2 : mod(t, 2600) / 2600 };
      return f;
    },
  },
  subagent: {
    motion: 'loop', blinks: true,
    frame(t, o) {
      const f = blankFrame();
      f.face.dx = -20;
      // Every 6 s the parent checks on its minis: 250 ms there, 700 ms, 300 ms back.
      const c = o.still ? -1 : mod(t, 6000);
      const g = c < 0 ? 0 : c < 250 ? easeStandard(c / 250) : c < 950 ? 1 : c < 1250 ? 1 - easeStandard((c - 950) / 300) : 0;
      f.eyes = [eye(2 + 12 * g, 2 * g, 0.97, 0.96, 0), eye(2 + 12 * g, 2 * g, 1.03 - 0.05 * g, 1, 0)];
      f.mouth = mouth(32, 10, 2 + 4 * g, 0, 0, 0.25);
      const minis = MINIS[o.count - 1].map(([x, y, s], i) => ({
        x,
        y: y + (o.still ? 0 : 1.6 * Math.sin(TAU * (t / 1700 + i * 0.37))),
        s,
        sy: 1 - 0.94 * (o.still ? 0 : blinkAmount(mod(t + i * 1500, 4600) - 4300)),
        look: -g,
        op: 1,
      }));
      f.prop = { name: 'subagent', count: o.count, minis };
      return f;
    },
  },
  plan: {
    motion: 'still', blinks: true,
    frame(t, o) {
      const f = blankFrame();
      f.eyes = [eye(-8, -5, 1.02, 0.9, 0), eye(-8, -5, 0.97, 0.86, 2)];
      f.mouth = mouth(30, 4, -3, 0, 0, 0.25);
      f.prop = { name: 'plan', ticks: o.ticks, pop: 1 };
      return f;
    },
  },
  memory: {
    motion: 'loop', blinks: true,
    frame(t, o) {
      const f = blankFrame();
      f.eyes = [eye(4, -7, 1, 0.5, 0), eye(4, -7, 1, 0.58, 0)];
      f.mouth = mouth(26, 4, 2, 0, 0, 0.25);
      let gap;
      let ring = 0;
      let ringOp = 0;
      let nod = 0;
      if (o.mode === 'remember') {
        // Snap together (200 ms spring), nod, drift apart for the next one.
        const c = o.still ? 400 : mod(t, 1600);
        gap = c < 200 ? 7 * (1 - springEase(c / 200)) : 7 * smooth(clamp01((c - 520) / 1080));
        nod = o.still ? 0 : bump(c, 140, 260);
      } else if (o.still) {
        gap = 5;
      } else {
        // Recall: a sonar ring out of the mark while its pills slide apart.
        const c = mod(t, 1400);
        gap = c < 700 ? lerp(1, 7, easeOut(c / 700)) : lerp(7, 1, smooth((c - 700) / 700));
        if (c < 700) { ring = 46 * easeOut(c / 700); ringOp = 0.5 * (1 - c / 700); }
      }
      f.face.dy = 2 * nod;
      f.prop = { name: 'memory', gap, ring, ringOp };
      return f;
    },
  },
  runs: patientPose('runs'),
  computer: {
    motion: 'still', blinks: true, look: 47,
    frame(t, o) {
      const f = blankFrame();
      f.eyes[0].sy = 0.95;
      gaze(f, o.look, { x: 16, y: 10 }, 0.45);
      f.prop = { name: 'computer', x: o.look.x, y: o.look.y, ripple: 0 };
      return f;
    },
  },
  think: {
    motion: 'loop', blinks: true,
    frame(t, o) {
      const f = blankFrame();
      // A slow figure-8 up and to the right.
      const a = o.still ? Math.PI / 2 : TAU * t / 4800;
      const x = 6 + 6 * Math.sin(a);
      const y = -6 + 4 * Math.sin(2 * a);
      f.eyes = [eye(x, y, 1, 0.88, 0), eye(x, y, 1, 0.8, -2)];
      f.mouth = mouth(20, 0, -10, 1, -5, 0.25);
      f.prop = { name: 'think', phase: o.still ? 0.9 : mod(t, 1200) / 1200 };
      return f;
    },
  },
  mcp: {
    motion: 'loop', blinks: true,
    frame(t, o) {
      const f = blankFrame();
      const c = o.still ? -1 : mod(t, 1200);
      const g = c < 0 ? 0 : c < 120 ? easeStandard(c / 120) : c < 420 ? 1 : c < 560 ? 1 - easeStandard((c - 420) / 140) : 0;
      f.eyes = [eye(-9 * g, 5 * g, 1 + 0.03 * g, 1, 0), eye(-9 * g, 5 * g, 1 - 0.04 * g, 0.97, 0)];
      f.mouth = mouth(34, 9, -3 * g, 0, 0, 0.25);
      f.prop = { name: 'mcp', nudge: g };
      return f;
    },
  },
};

function poseOptions(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const look = o.look ? { x: unit(o.look.x), y: unit(o.look.y) } : { x: 0, y: 0 };
  const range = {
    x: Number(o.range?.x) > 0 ? Number(o.range.x) : RANGE.x,
    y: Number(o.range?.y) > 0 ? Number(o.range.y) : RANGE.y,
  };
  return {
    look,
    range,
    count: intIn(o.count, 1, 3, 1),
    mode: o.mode === 'remember' ? 'remember' : 'recall',
    ticks: intIn(o.ticks, 0, 3, 1),
    unlimited: !!o.unlimited,
    still: !!o.still,
  };
}

/**
 * The pose `name` at `t` ms after it began. Pure and deterministic; unknown
 * names fall back to idle. `opts.still` gives the still frame.
 */
export function poseFrame(name, t = 0, opts = {}) {
  const def = POSES[name] || POSES.idle;
  const time = Number.isFinite(t) && t > 0 ? t : 0;
  const o = poseOptions(opts);
  const frame = def.frame(time, o);
  return o.still ? markStill(frame) : frame; // the painter makes a still's prop legible at a glance
}

/** Flag a frame as still (not enumerable: a still frame's geometry compares equal to a settled one). */
function markStill(frame) {
  Object.defineProperty(frame, 'still', { value: true, enumerable: false, configurable: true });
  return frame;
}

/** The frame a pose holds under reduced motion, off screen or inactive. */
export function stillFrame(name, opts = {}) {
  return poseFrame(name, 0, { ...opts, still: true });
}

// The face-unit box the eyes and the smile can reach: the eyes (80-200 × 24-96) over their whole travel
// (±20 × ±14, the widest pose's) and swell, the smile at its widest and lowest.
const FACE_REACH = Object.freeze({ left: 58, top: 6, right: 222, bottom: 134 });

/**
 * The box (face units: { left, top, right, bottom }) pose `name` can draw in:
 * its eyes over their whole travel, the smile and its prop, at the face's own
 * offset (the subagent pose steps aside for its minis). Arms aside. What a
 * host keeps its own drawing out of, so nothing is drawn over the character.
 */
export function mascotBounds(name, opts = {}) {
  const f = stillFrame(POSES[name] ? name : 'idle', opts);
  const box = { ...FACE_REACH };
  const prop = PROP_BOX[f.prop?.name];
  if (prop) {
    const [x, y, w, h] = prop;
    box.left = Math.min(box.left, x);
    box.top = Math.min(box.top, y);
    box.right = Math.max(box.right, x + w);
    box.bottom = Math.max(box.bottom, y + h);
  }
  const dx = f.face?.dx || 0;
  const dy = f.face?.dy || 0;
  return { left: box.left + dx, top: box.top + dy, right: box.right + dx, bottom: box.bottom + dy };
}

/** The mouth's quadratic stroke: `w` wide, control `c` below the corners. */
export function mouthPath(m) {
  const hw = m.w / 2;
  const cx = 140 + m.dx;
  const cy = 116 + m.dy;
  const a = (m.rot * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const pt = (x, y) => `${n(cx + x * cos - y * sin)},${n(cy + x * sin + y * cos)}`;
  return `M${pt(-hw, 0)} Q${pt(0, m.c)} ${pt(hw, 0)}`;
}

function cloneFrame(f) {
  const out = {
    eyes: [{ ...f.eyes[0] }, { ...f.eyes[1] }],
    mouth: { ...f.mouth },
    face: { ...f.face },
    prop: f.prop?.minis ? { ...f.prop, minis: f.prop.minis.map(m => ({ ...m })) } : { ...f.prop },
    ...(f.propFrom !== undefined ? { propFrom: f.propFrom, propMix: f.propMix } : {}),
  };
  return f.still ? markStill(out) : out;
}

function mixFrames(a, b, p) {
  const m = (x, y) => x + (y - x) * p;
  const eyeMix = (e, g) => ({ dx: m(e.dx, g.dx), dy: m(e.dy, g.dy), sx: m(e.sx, g.sx), sy: m(e.sy, g.sy), rot: m(e.rot, g.rot) });
  const out = {
    eyes: [eyeMix(a.eyes[0], b.eyes[0]), eyeMix(a.eyes[1], b.eyes[1])],
    mouth: { w: m(a.mouth.w, b.mouth.w), c: m(a.mouth.c, b.mouth.c), dx: m(a.mouth.dx, b.mouth.dx), dy: m(a.mouth.dy, b.mouth.dy), rot: m(a.mouth.rot, b.mouth.rot), op: m(a.mouth.op, b.mouth.op) },
    face: { dx: m(a.face.dx, b.face.dx), dy: m(a.face.dy, b.face.dy), rot: m(a.face.rot, b.face.rot), op: m(a.face.op, b.face.op) },
    prop: b.prop,
    propFrom: a.prop,
    propMix: p,
  };
  return b.still ? markStill(out) : out; // blending into a still: its prop is already legible
}

/** Two frames that draw the same face and prop (a blend between them would be wasted frames). */
function sameFrame(a, b) {
  const nums = f => [...f.eyes.flatMap(e => [e.dx, e.dy, e.sx, e.sy, e.rot]), f.mouth.w, f.mouth.c, f.mouth.dx, f.mouth.dy, f.mouth.rot, f.mouth.op, f.face.dx, f.face.dy, f.face.rot, f.face.op];
  const x = nums(a);
  const y = nums(b);
  return (a.prop?.name || null) === (b.prop?.name || null) && x.every((v, i) => Math.abs(v - y[i]) < 1e-3);
}

// ── Reactions ──

const REACTIONS = { hop: 300, wince: 240, nod: 260, pop: 220, startle: 220, pulse: 600, click: 300, wiggle: 360, split: 420 };

/** `frame` with reaction `name` `p` (0-1) of the way through. Pure. */
export function reactionFrame(frame, name, p) {
  const f = cloneFrame(frame);
  const q = clamp01(Number(p) || 0);
  const b = bump(q, 0, 1);
  switch (name) {
    case 'hop': {
      // 90 ms up (stretching), then a spring landing that dips a touch below rest (squashing).
      const up = q < 0.3 ? easeOut(q / 0.3) : 1 - springEase((q - 0.3) / 0.7);
      const rise = bump(q, 0, 0.3);
      const land = bump(q, 0.45, 0.35);
      f.face.dy -= 12 * up;
      for (const e of f.eyes) {
        e.sy *= (1 + 0.06 * rise) * (1 - 0.12 * land);
        e.sx *= (1 - 0.03 * rise) * (1 + 0.06 * land);
      }
      break;
    }
    case 'wince':
      for (const e of f.eyes) e.sy *= 1 - 0.45 * b; // lids to about .55
      f.mouth.c = lerp(f.mouth.c, -Math.abs(f.mouth.c) - 4, b);
      f.face.dy += 1.5 * b;
      break;
    case 'nod':
      f.face.dy += 3 * b;
      break;
    case 'pop':
      if (f.prop.name === 'plan') f.prop.pop = q;
      else for (const e of f.eyes) { e.sy *= 1 + 0.08 * b; e.sx *= 1 + 0.04 * b; }
      break;
    case 'startle':
      for (const e of f.eyes) { e.sy *= 1 + 0.15 * b; e.sx *= 1 + 0.03 * b; }
      f.face.dy -= 2 * b;
      break;
    case 'pulse': {
      const g = 1 + 0.06 * Math.sin(Math.PI * q);
      for (const e of f.eyes) { e.sx *= g; e.sy *= g; }
      break;
    }
    case 'click': {
      const k = 1 - 0.94 * blinkAmount(q * 280);
      for (const e of f.eyes) e.sy *= k;
      if (f.prop.name === 'computer') f.prop.ripple = q;
      break;
    }
    case 'wiggle': // the idle fidget: a small head wobble that dies out
      f.face.rot += 3 * Math.sin(TAU * 2 * q) * (1 - q);
      break;
    case 'split': { // the eyes part, tilting away, and spring back into one face
      const apart = q < 0.3 ? easeOut(q / 0.3) : 1 - springEase((q - 0.3) / 0.7);
      f.eyes[0].dx -= 16 * apart;
      f.eyes[1].dx += 16 * apart;
      f.eyes[0].rot -= 12 * apart;
      f.eyes[1].rot += 12 * apart;
      for (const e of f.eyes) e.sy *= 1 - 0.1 * clamp01(apart);
      f.mouth.op *= 1 - 0.6 * clamp01(apart);
      break;
    }
    default:
      break;
  }
  return f;
}

// ── Props: small, currentColor, in the face's pill geometry ──

const PROPS = {
  project: {
    markup: () => '<g fill="none" stroke="currentColor" stroke-opacity=".7" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M208 117V84q0-4 4-4h15l7 8h25v29z"/><path class="syna-folder-front" d="M208 117l5-23h49l-5 23z"/><path class="syna-folder-paper" d="M223 93V85h22v8M229 89h10"/></g>',
    refs: g => ({ front: g.querySelector('.syna-folder-front'), paper: g.querySelector('.syna-folder-paper') }),
    update(r, p, put) {
      put(r.front, 'transform', `translate(0,${n(2 * p.peek)})`);
      put(r.paper, 'transform', `translate(0,${n(-4 * p.peek)})`);
    },
  },
  budget: {
    markup: () => '<g fill="none" stroke="currentColor" stroke-opacity=".7" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="216" y="96" width="46" height="25" rx="4"/><path d="M250 103h12v10h-12z"/><g class="syna-budget-coin"><circle cx="236" cy="80" r="12"/><path d="M236 73v14M232 76h6q4 0 0 4h-4q-4 4 0 4h6"/></g><path class="syna-budget-infinity" d="M235 80c-16-19-25 15-8 7l17-14c17-8 8 26-9 7"/></g>',
    refs: g => ({ coin: g.querySelector('.syna-budget-coin'), infinity: g.querySelector('.syna-budget-infinity') }),
    update(r, p, put) {
      put(r.coin, 'display', p.unlimited ? 'none' : null);
      put(r.infinity, 'display', p.unlimited ? null : 'none');
      put(p.unlimited ? r.infinity : r.coin, 'transform', `translate(0,${n(-3 * p.lift)})`);
    },
  },
  skill: {
    markup: () => '<path d="M218 107V57q0-5 5-5h29q5 0 5 5v50M212 107h45v4q0 7-7 7h-31q-7 0-7-7z" fill="none" stroke="currentColor" stroke-opacity=".7" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path class="syna-skill-ink" d="M225 72h21M225 85h21M225 98h21" pathLength="1" fill="none" stroke="currentColor" stroke-opacity=".55" stroke-width="3" stroke-linecap="round" stroke-dasharray="1 1"/>'
      + '<g class="syna-skill-pen" fill="currentColor" fill-opacity=".75"><rect x="-3" y="-28" width="6" height="20" rx="3"/><path d="M-2.8,-9 L0,-1 L2.8,-9 Z"/></g>'
      + '<path class="syna-skill-spark" d="M266 28l2.4 7.6L276 38l-7.6 2.4L266 48l-2.4-7.6L256 38l7.6-2.4z" fill="currentColor"/>',
    refs: g => ({ ink: g.querySelector('.syna-skill-ink'), pen: g.querySelector('.syna-skill-pen'), spark: g.querySelector('.syna-skill-spark') }),
    update(r, p, put) {
      const row = Math.min(2, Math.floor(p.draw * 3));
      const x = 225 + 21 * (p.draw * 3 - row);
      const y = 72 + 13 * row + p.jig - 3 * p.spark;
      put(r.ink, 'stroke-dashoffset', n(1 - p.draw));
      put(r.pen, 'transform', `translate(${n(x)},${n(y)}) rotate(35)`);
      put(r.spark, 'transform', `translate(266,38) scale(${n(0.65 + 0.35 * p.spark)}) translate(-266,-38)`);
      put(r.spark, 'fill-opacity', n(0.25 + 0.6 * p.spark));
    },
  },
  shell: { // three keycaps and a block caret under the chin
    markup: () => [0, 1, 2].map(i => `<rect class="syna-key" x="${100 + i * 24}" y="127" width="20" height="9" rx="4.5" fill="currentColor" fill-opacity=".4"/>`).join('')
      + '<rect class="syna-caret" x="174" y="125" width="7" height="12" rx="2" fill="currentColor" fill-opacity=".75"/>',
    refs: g => ({ keys: Array.from(g.querySelectorAll('.syna-key')), caret: g.querySelector('.syna-caret') }),
    update(r, p, put) {
      r.keys.forEach((k, i) => {
        const on = i === p.key ? p.press : 0;
        put(k, 'transform', on ? `translate(0,${n(2 * on)})` : null);
        put(k, 'fill-opacity', n(0.4 + 0.35 * on));
      });
      put(r.caret, 'fill-opacity', p.caret ? '.75' : '.12');
    },
  },
  read: { // two thin reading rings round the eyes
    markup: () => '<g fill="none" stroke="currentColor" stroke-opacity=".5" stroke-width="4"><rect x="69" y="24" width="60" height="80" rx="30"/><rect x="151" y="24" width="60" height="80" rx="30"/><path d="M129,58 Q140,50 151,58" stroke-linecap="round"/></g>',
    refs: () => ({}),
    update() {},
  },
  edit: { // a pencil drawing a stroke
    markup: () => '<path class="syna-ink" d="M192,130 q5.5,-3 11,0 t11,0 t11,0 t11,0" pathLength="1" fill="none" stroke="currentColor" stroke-opacity=".45" stroke-width="3" stroke-linecap="round" stroke-dasharray="1 1" stroke-dashoffset="1"/>'
      + '<g class="syna-pencil" fill="currentColor" fill-opacity=".75"><rect x="-4" y="-34" width="8" height="25" rx="4"/><path d="M-3.6,-10 L0,-1 L3.6,-10 Z"/></g>',
    refs: g => ({ ink: g.querySelector('.syna-ink'), pencil: g.querySelector('.syna-pencil') }),
    update(r, p, put) {
      const fade = p.draw > 0.85 ? (1 - p.draw) / 0.15 : 1;
      put(r.ink, 'stroke-dashoffset', n(1 - p.draw));
      put(r.ink, 'stroke-opacity', n(0.45 * fade));
      put(r.pencil, 'transform', `translate(${n(192 + 44 * p.draw)},${n(129 + p.jig)}) rotate(35)`);
    },
  },
  search: { // a magnifier on a small orbit
    markup: () => '<g class="syna-glass"><circle cx="232" cy="50" r="12" fill="none" stroke="currentColor" stroke-opacity=".6" stroke-width="5"/><rect x="244.5" y="58" width="7" height="16" rx="3.5" transform="rotate(-45 248 66)" fill="currentColor" fill-opacity=".6"/></g>',
    refs: g => ({ glass: g.querySelector('.syna-glass') }),
    update(r, p, put) {
      put(r.glass, 'transform', `translate(${n(p.x)},${n(p.y)})`);
    },
  },
  web: { // a globe whose meridian turns
    markup: () => '<g fill="none" stroke="currentColor" stroke-width="3.5"><circle cx="238" cy="30" r="16" stroke-opacity=".55"/><ellipse cx="238" cy="30" rx="16" ry="5.5" stroke-opacity=".28"/><path class="syna-meridian" d="M238,14 L238,46" stroke-opacity=".55"/></g>',
    refs: g => ({ meridian: g.querySelector('.syna-meridian') }),
    update(r, p, put) {
      const a = TAU * p.spin;
      const bulge = 16 * Math.sin(a);
      put(r.meridian, 'd', Math.abs(bulge) < 0.6 ? 'M238,14 L238,46' : `M238,14 A${n(Math.abs(bulge))},16 0 0 ${bulge > 0 ? 1 : 0} 238,46`);
      put(r.meridian, 'stroke-opacity', Math.cos(a) >= 0 ? '.55' : '.18');
    },
  },
  subagent: { // 1-3 mini eye-pairs, one <use> each
    markup: uid => `<defs><g id="${uid}-pair"><rect x="-60" y="-36" width="38" height="72" rx="19" fill="currentColor"/><rect x="22" y="-36" width="38" height="72" rx="19" fill="currentColor"/></g></defs>`
      + [0, 1, 2].map(() => `<use class="syna-mini" href="#${uid}-pair" fill-opacity=".78" display="none"/>`).join(''),
    refs: g => ({ minis: Array.from(g.querySelectorAll('.syna-mini')) }),
    update(r, p, put) {
      r.minis.forEach((u, i) => {
        const m = p.minis?.[i];
        if (!m) { put(u, 'display', 'none'); return; }
        put(u, 'display', null);
        put(u, 'transform', `translate(${n(m.x + 3 * m.look)},${n(m.y)}) scale(${n(m.s)},${n(m.s * Math.max(0.04, m.sy))})`);
        put(u, 'opacity', m.op < 0.999 ? n(m.op) : null);
      });
    },
  },
  plan: { // a clipboard with three rows; ticked rows pop in
    markup: () => '<rect x="20" y="26" width="38" height="52" rx="8" fill="none" stroke="currentColor" stroke-opacity=".5" stroke-width="3.5"/>'
      + '<rect x="31" y="21" width="16" height="9" rx="4.5" fill="currentColor" fill-opacity=".6"/>'
      + [0, 1, 2].map((i) => {
        const y = 40 + i * 12;
        return `<g class="syna-check"><circle cx="30" cy="${y}" r="3.6" fill="currentColor" fill-opacity="0" stroke="currentColor" stroke-opacity=".5" stroke-width="2.2"/>`
          + `<path d="M27.7,${y} l1.7,1.9 l3.3,-3.9" fill="none" stroke="currentColor" stroke-opacity=".85" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" display="none"/></g>`
          + `<rect x="37" y="${y - 1.5}" width="15" height="3" rx="1.5" fill="currentColor" fill-opacity=".35"/>`;
      }).join(''),
    refs: g => ({ rows: Array.from(g.querySelectorAll('.syna-check')).map(check => ({ check, box: check.firstElementChild, tick: check.lastElementChild })) }),
    update(r, p, put) {
      r.rows.forEach((row, i) => {
        const on = i < p.ticks;
        const y = 40 + i * 12;
        put(row.tick, 'display', on ? null : 'none');
        put(row.box, 'fill-opacity', on ? '.25' : '0');
        const popping = on && i === p.ticks - 1 && p.pop < 1;
        const s = popping ? 0.6 + 0.4 * springEase(p.pop) : 1;
        put(row.check, 'transform', s !== 1 ? `translate(30,${y}) scale(${n(s)}) translate(-30,${-y})` : null);
        put(row.tick, 'stroke-opacity', popping ? n(0.85 * clamp01(p.pop * 3)) : '.85');
      });
    },
  },
  memory: { // the two-pill SynaBun mark and a sonar ring
    markup: () => '<circle class="syna-sonar" cx="234" cy="26" r="1" fill="none" stroke="currentColor" stroke-width="3" stroke-opacity="0" display="none"/>'
      + '<g class="syna-pill-a"><rect x="-13.2" y="-6" width="26.4" height="12" rx="6" transform="rotate(-12)" fill="currentColor" fill-opacity=".72"/></g>'
      + '<g class="syna-pill-b"><rect x="-13.2" y="-6" width="26.4" height="12" rx="6" transform="rotate(-12)" fill="currentColor" fill-opacity=".72"/></g>',
    refs: g => ({ ring: g.querySelector('.syna-sonar'), a: g.querySelector('.syna-pill-a'), b: g.querySelector('.syna-pill-b') }),
    update(r, p, put) {
      const h = p.gap / 2; // along the mark's diagonal
      put(r.a, 'transform', `translate(${n(238.2 + 0.447 * h)},${n(17.6 - 0.894 * h)})`);
      put(r.b, 'transform', `translate(${n(229.8 - 0.447 * h)},${n(34.4 + 0.894 * h)})`);
      const on = p.ring > 0.5 && p.ringOp > 0.01;
      put(r.ring, 'display', on ? null : 'none');
      if (on) { put(r.ring, 'r', n(p.ring)); put(r.ring, 'stroke-opacity', n(p.ringOp)); }
    },
  },
  runs: { // a radar dish listening
    markup: () => '<g fill="none" stroke="currentColor" stroke-linecap="round">'
      + '<path d="M222,30 A20,20 0 0 0 242,50" stroke-opacity=".6" stroke-width="4"/>'
      + '<path d="M228,44 L236,36 M228,44 L223,55 M217,55 L229,55" stroke-opacity=".5" stroke-width="3"/>'
      + '<path d="M237.4,28.1 A8,8 0 0 1 243.9,34.6" stroke-opacity=".45" stroke-width="3"/>'
      + '<path d="M238.4,22.2 A14,14 0 0 1 249.8,33.6" stroke-opacity=".3" stroke-width="3"/></g>',
    refs: () => ({}),
    update() {},
  },
  computer: { // a cursor arrow and its click ripple
    markup: () => '<circle class="syna-ripple" r="4" fill="none" stroke="currentColor" stroke-width="2.5" stroke-opacity="0" display="none"/>'
      + '<path class="syna-cursor" d="M0,0 L0,22 L5.5,17 L9.5,25.5 L13.5,23.8 L9.6,15.4 L16.5,15.4 Z" fill="currentColor" fill-opacity=".85" stroke="currentColor" stroke-opacity=".85" stroke-width="1.5" stroke-linejoin="round"/>',
    refs: g => ({ ripple: g.querySelector('.syna-ripple'), cursor: g.querySelector('.syna-cursor') }),
    update(r, p, put) {
      const x = 226 + 30 * p.x;
      const y = 66 + 40 * p.y;
      put(r.cursor, 'transform', `translate(${n(x)},${n(y)})`);
      const on = p.ripple > 0 && p.ripple < 1;
      put(r.ripple, 'display', on ? null : 'none');
      if (on) {
        put(r.ripple, 'cx', n(x));
        put(r.ripple, 'cy', n(y));
        put(r.ripple, 'r', n(3 + 13 * easeOut(p.ripple)));
        put(r.ripple, 'stroke-opacity', n(0.6 * (1 - p.ripple)));
      }
    },
  },
  think: { // three thought dots, lit in turn
    markup: () => '<circle cx="210" cy="32" r="3.5" fill="currentColor"/><circle cx="224" cy="20" r="5" fill="currentColor"/><circle cx="243" cy="9" r="6.5" fill="currentColor"/>',
    refs: g => ({ dots: Array.from(g.querySelectorAll('circle')) }),
    update(r, p, put) {
      r.dots.forEach((dot, i) => {
        const q = (p.phase - i * 0.22) / 0.5;
        put(dot, 'fill-opacity', n(0.25 + 0.55 * (q > 0 && q < 1 ? Math.sin(Math.PI * q) : 0)));
      });
    },
  },
  ask: { // a question mark beside the face, in the outline props' weight
    markup: () => '<path d="M216,22 C216,10 225,4 233,4 C242,4 250,10 250,19 C250,28 243,32 236,36 C232,38 231,41 231,46" fill="none" stroke="currentColor" stroke-opacity=".7" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<rect x="227.5" y="54" width="7" height="8" rx="3.5" fill="currentColor" fill-opacity=".7"/>',
    refs: () => ({}),
    update() {},
  },
  mcp: { // a two-prong plug on its cord
    markup: () => '<path d="M41,106 C41,120 30,122 22,134" fill="none" stroke="currentColor" stroke-opacity=".4" stroke-width="3" stroke-linecap="round"/>'
      + '<g class="syna-plug" fill="currentColor" fill-opacity=".65"><rect x="30" y="86" width="22" height="20" rx="7"/><rect x="34" y="74" width="4.5" height="14" rx="2.25"/><rect x="43.5" y="74" width="4.5" height="14" rx="2.25"/></g>',
    refs: g => ({ plug: g.querySelector('.syna-plug') }),
    update(r, p, put) {
      put(r.plug, 'transform', p.nudge ? `translate(${n(2 * p.nudge)},${n(-1.5 * p.nudge)})` : null);
    },
  },
};

// ── Arms: rubber-hose noodles the rig grows only while it points ──
// One arm at each lower outer side of the face, below and outside the eyes,
// where a body's sides would be: a fine line (CSS px, so it stays fine at every
// size, about the smile's own stroke) from a shoulder anchor, no elbow or joint,
// that swells into a hand built from pills like the eyes: a round palm, one
// index pill that unfurls to point, a thumb nub. They exist only while a host
// points (rig.point): the arm on the target's side sprouts with a springy
// overshoot and grows until its fingertip stops just short of the target; the
// index aims along the line from the hand to the target, its angle on its own
// spring so it never snaps; the other arm may give a tiny balancing flick (a
// relaxed hand, index folded); when the pointing ends or the target changes
// side the arm goes back into the body, quicker than it grew. Every control
// point is a damped spring (the hand the loosest), so an arm lags when the body
// travels (rig.nudge), wobbles when it lands and settles into a low idle wiggle
// while it is held; a poke moves the hand along the hand-to-target line and
// squashes it there; a new target continues from the springs' state. Whatever
// the springs do, every point of an arm stays inside its shoulder's free wedge
// (ARM_BOUND): the eyes and the smile are never crossed, and while an arm is
// out the eyes keep to MASCOT_ARM.gaze so they never come to it; a prop drawn
// over a shoulder (the project folder, the budget, the edit pen) moves that
// arm's root under it (armShoulder), on a spring, so no arm comes out of a
// prop. Noodle and
// hand are one path (a nonzero union: no seam where they meet, whatever alpha
// the colour carries). Pure here (createArmSim, armRest, armPath, armHandPath,
// armDrawPath: no DOM); the rig measures, steps the sim on its own frames and
// paints it.

export const MASCOT_ARM = Object.freeze({
  // Left, right (face units): outside the eyes (x 80-118, 162-200), below them (y 24-96) and level with the
  // smile's corners (x 118-162, y 116), so neither eye nor the smile is ever near the root of an arm. A prop
  // drawn over one (PROP_BOX) moves that root under it: armShoulder.
  shoulders: Object.freeze([Object.freeze({ x: 62, y: 106 }), Object.freeze({ x: 218, y: 106 })]),
  reach: 96, // a grown arm, shoulder to the wrist
  // The line's width in CSS px, at the shoulder and at the wrist: a fine line, about the smile's stroke
  // (2.5 face units, .86-1.07 px on the hero), with a slight taper. Face units are px / the rig's px per
  // unit, kept within `units` on a very small or very large character.
  px: Object.freeze({ w0: 1.2, w1: 0.95 }),
  units: Object.freeze({ min: 1.8, max: 4.6 }),
  unitPx: 120 / 280, // px per face unit when a caller says nothing: the empty state's 120 px character
  // The hand (armHandPath), in the pill language of the eyes: a round palm, one index pill that
  // unfurls to point along the aim, and a thumb nub. Radii and lengths in face units, around the wrist.
  hand: Object.freeze({ palm: 6.6, index: 2.9, indexLen: 15, thumb: 2.6, thumbLen: 6.5 }),
  raise: 1.35, // radians an arm may aim above straight out (never up across the eyes)…
  lower: 2.3, // …and below it (down and in, under the smile, never across it)
  // While an arm is out the eyes travel at most this far (face units) and swell at most this much,
  // so an eye never comes to an arm.
  gaze: Object.freeze({ x: 12, y: 10, sx: 1.04, sy: 1.08 }),
});

const ARM_T = [1 / 3, 2 / 3, 1];
const ARM_SPRINGS = [[520, 0.72], [400, 0.5], [310, 0.36]]; // per control point: stiffness (1/s²), damping ratio
const ARM_GROW = [19, 0.46]; // the sprout: ω (rad/s), ζ (≈ 18 % overshoot)
const ARM_SHRINK = [27, 1]; // going home: critically damped, quicker
const ARM_WIGGLE = [[1.1, 1.05, 0.2], [1.4, 1.45, 1.7], [1.7, 0.8, 3.1]]; // per point: amplitude (units), Hz, phase
const ARM_NUDGE = [0.25, 0.55, 0.9]; // how much of a body jolt each point keeps (the hand lags most)
const ARM_POKE = { dist: 13, dur: 0.13, gap: 0.24, share: [0.2, 0.55, 1] }; // each poke: units along the aim, s out and back, s between the two, per point
const ARM_FLICK = { e: 0.24, angle: 1.05, hold: 0.22 }; // the other arm's balancing flick: reach, aim (down and out), s held
const ARM_MAX_SPEED = 900; // units/s a jolt can give a point
// Where any point of an arm may be, as seen from its shoulder (0 straight out, + down): the aim's range and a
// little more for overshoot, wiggle and trailing. The eyes (at their MASCOT_ARM.gaze limits) and the smile lie
// outside it with room to spare; consecutive points never turn more than ARM_KINK, so no segment cuts across.
const ARM_BOUND = [-(MASCOT_ARM.raise + 0.12), MASCOT_ARM.lower + 0.1];
const ARM_KINK = 2.2;
const ARM_HOLD = [0.25, 0.3, 0.35]; // a jolt never folds a point closer to the shoulder than this share of where it rests
// What an arm keeps away from (face units, rounded boxes: centre, half sizes, corner radius): each eye over
// its MASCOT_ARM.gaze travel and swell, and the smile at its widest and lowest. Every part of an arm (the
// line, the palm, the index, the thumb) stays ARM_CLEAR outside them, whatever the springs do.
const ARM_KEEP_OUT = Object.freeze([
  ...[99, 181].map(cx => Object.freeze({ cx, cy: 60, hw: 19 * MASCOT_ARM.gaze.sx + MASCOT_ARM.gaze.x, hh: 36 * MASCOT_ARM.gaze.sy + MASCOT_ARM.gaze.y, r: 19 * MASCOT_ARM.gaze.sx })),
  Object.freeze({ cx: 140, cy: 120.5, hw: 34, hh: 12.5, r: 6 }),
]);
const ARM_CLEAR = 2.5; // face units, about a CSS px on the hero
const ARM_MIN_REACH = 0.42; // a target close by: the arm grows at least this much of its reach
const ARM_FOCUS = 0.32; // the index aims at the target's middle, this much in from each side, leaning toward the arm
const HAND_SQUASH = 0.16; // how much a poke squashes the hand at its peak (shorter along the aim, wider across)
const HAND_SQUASH_SPRING = [42, 0.42]; // ω (rad/s), ζ: the squash rebounds a little (a stretch), then settles
const HAND_POINT_RATE = 18; // 1/s: how fast the index unfurls on a held arm, or folds once it is let go
const HAND_TURN = [20, 0.9]; // ω (rad/s), ζ: the hand's angle follows the line to the target, fluid, never a snap
const ARM_FLARE = 18; // units of arm, before the wrist, over which the line swells into the palm
// The fingertip's distance past the wrist with the index out, at full size (armHandPath's index pill).
const HAND_TIP = (4 + MASCOT_ARM.hand.indexLen + MASCOT_ARM.hand.index) * 1.08;

/** What an arm keeps away from: the eyes over their travel while it is out, and the smile (face units, rounded boxes). */
export function armKeepOut() {
  return ARM_KEEP_OUT.map(b => ({ ...b }));
}

const ARM_ROOT_MAX_Y = 138; // a root moved under a prop never leaves the face's own box (140 high)
const ARM_ROOT_SPRING = [16, 0.9]; // ω (rad/s), ζ: a root that moves under a prop glides there, no pop

/**
 * Where the arm on `side` (0 left, 1 right) roots while the face shows `prop`:
 * its shoulder (MASCOT_ARM.shoulders), or, when that prop's box (PROP_BOX: the
 * project folder, the budget pill and the edit pen sit at the face's lower
 * side, over the right shoulder) covers the shoulder, just under the box, so an
 * arm never comes out of a prop. A prop clear of the shoulder moves nothing.
 */
export function armShoulder(side, prop = null) {
  const s = MASCOT_ARM.shoulders[side ? 1 : 0];
  const box = prop ? PROP_BOX[prop] : null;
  if (!box) return { x: s.x, y: s.y };
  const [x, y, w, h] = box;
  const root = MASCOT_ARM.units.max / 2; // the line's radius at its widest
  if (s.x < x - root || s.x > x + w + root || s.y < y - root || s.y > y + h + root) return { x: s.x, y: s.y };
  return { x: s.x, y: Math.min(ARM_ROOT_MAX_Y, y + h + root + ARM_CLEAR) };
}

/** Signed distance from (x, y) to a rounded box `b` (negative inside), and the unit normal out of it. */
function boxDistance(x, y, b) {
  const sx = x >= b.cx ? 1 : -1;
  const sy = y >= b.cy ? 1 : -1;
  const qx = Math.abs(x - b.cx) - (b.hw - b.r);
  const qy = Math.abs(y - b.cy) - (b.hh - b.r);
  if (qx > 0 && qy > 0) {
    const l = Math.hypot(qx, qy);
    return { d: l - b.r, nx: (sx * qx) / l, ny: (sy * qy) / l };
  }
  if (qx > qy) return { d: qx - b.r, nx: sx, ny: 0 };
  return { d: qy - b.r, nx: 0, ny: sy };
}

/** How close a disc (x, y, radius r) comes to the face (ARM_KEEP_OUT): the smallest gap, negative when it overlaps. */
function faceGap(x, y, r) {
  let gap = Infinity;
  for (const b of ARM_KEEP_OUT) gap = Math.min(gap, boxDistance(x, y, b).d - r);
  return gap;
}

/** The hand's size for an arm `e` of the way out (armDrawPath's). */
const handScale = e => clamp(e * 1.5, 0, 1.08);

/**
 * The discs a hand covers (face units), turned to `angle` at `wrist` on `side`,
 * `hs` its size and `pt` how far its index is out: the palm's front, points along
 * the index and the thumb's tip. armHandPath's pills, sampled.
 */
function handDiscs(wrist, angle, side, hs, pt) {
  const H = MASCOT_ARM.hand;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const flip = side ? -1 : 1;
  const at = (x, y, r) => ({ x: wrist.x + (x * cos - y * flip * sin) * hs, y: wrist.y + (x * sin + y * flip * cos) * hs, r: r * hs });
  const open = 0.5 + 0.5 * pt;
  const discs = [at(3.5, 0, H.palm), at(0.5 + 3 * open, 4 + H.thumbLen * open, H.thumb)];
  for (let i = 0; i <= 4; i += 1) discs.push(at(4 + (H.indexLen * pt * i) / 4, 0, H.index));
  return discs;
}

/** Does a hand at `angle` keep ARM_CLEAR from the face? */
function handClear(wrist, angle, side, hs, pt) {
  return handDiscs(wrist, angle, side, hs, pt).every(c => faceGap(c.x, c.y, c.r) >= ARM_CLEAR);
}

/** The direction an arm on `side` (0 left, 1 right) points at `angle` (0 straight out, + down). */
function armDir(side, angle) {
  return { x: (side ? 1 : -1) * Math.cos(angle), y: Math.sin(angle) };
}

/** Which arm faces `point` (face units): the side of the face it is on. */
export function armSide(point) {
  return Number(point?.x) >= 140 ? 1 : 0;
}

const clampAim = a => clamp(Number(a) || 0, -MASCOT_ARM.raise, MASCOT_ARM.lower);

/** The angle the arm on `side` aims at `point` (face units), kept within its swing; `shoulder` is where it roots (armShoulder). */
export function armAim(side, point, shoulder = MASCOT_ARM.shoulders[side ? 1 : 0]) {
  const s = shoulder;
  const dx = (Number(point?.x) - s.x) * (side ? 1 : -1);
  const dy = Number(point?.y) - s.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6)) return 0;
  return clampAim(Math.atan2(dy, dx));
}

/**
 * How the arm on `side` meets a target `rect` (face units: { left, top, right,
 * bottom }): the angle it aims at, the point its index aims at (the target's
 * middle, leaning toward the arm: its near side for a wide one) and how much of
 * its reach it grows so the fingertip stops `gap` units short of the target.
 * `shoulder` is where the arm roots (armShoulder: under a prop that covers it).
 */
export function armTargeting(side, rect, gap = 0, shoulder = MASCOT_ARM.shoulders[side ? 1 : 0]) {
  const s = shoulder;
  const l = Number(rect?.left);
  const t = Number(rect?.top);
  const r = Number.isFinite(Number(rect?.right)) ? Number(rect.right) : l;
  const b = Number.isFinite(Number(rect?.bottom)) ? Number(rect.bottom) : t;
  if (![l, t, r, b].every(Number.isFinite)) return null;
  const inset = (lo, hi) => { const m = (hi - lo) * ARM_FOCUS; return [lo + m, hi - m]; };
  const [fx0, fx1] = inset(l, r);
  const [fy0, fy1] = inset(t, b);
  const focus = { x: clamp(s.x, fx0, fx1), y: clamp(s.y, fy0, fy1) };
  const g = Math.max(0, Number(gap) || 0);
  const dx = Math.max(l - g - s.x, 0, s.x - r - g);
  const dy = Math.max(t - g - s.y, 0, s.y - b - g);
  const reach = clamp((Math.hypot(dx, dy) - HAND_TIP) / MASCOT_ARM.reach, ARM_MIN_REACH, 1);
  return { angle: armAim(side, focus, s), focus, reach };
}

/**
 * Where the arm's three control points rest (a third, two thirds, the hand):
 * along its aim, `extension` of its reach, bowed a little like a hose away
 * from the face. With `wiggleAt` (s) they sway in the low idle wiggle.
 * `shoulder` is where the arm roots (armShoulder).
 */
export function armRest(side, angle, extension, wiggleAt = null, shoulder = MASCOT_ARM.shoulders[side ? 1 : 0]) {
  const s = shoulder;
  const d = armDir(side, angle);
  // The hose bows away from the face: down for a level arm, outward for a raised or a lowered one.
  // Its size follows how far that perpendicular leans out-and-down, so it never flips at once.
  const nx = -d.y;
  const ny = d.x;
  const ox = (side ? 1 : -1) * 0.857;
  const oy = 0.514;
  const e = Math.max(0, Number(extension) || 0);
  const len = MASCOT_ARM.reach * e;
  const bow = 0.16 * len * (nx * ox + ny * oy);
  const mirror = side ? -1 : 1; // the right arm's perpendicular is the left one's mirror turned round: the wiggle mirrors too
  return ARM_T.map((t, i) => {
    let off = Math.sin(Math.PI * t) * bow;
    let along = len * t;
    if (wiggleAt != null) {
      const [a, f, p] = ARM_WIGGLE[i];
      const k = Math.min(1, e);
      off += mirror * a * k * Math.sin(TAU * f * wiggleAt + p);
      along += 0.5 * a * k * Math.sin(TAU * f * 0.7 * wiggleAt + p * 1.7);
    }
    return { x: s.x + d.x * along + nx * off, y: s.y + d.y * along + ny * off };
  });
}

/** A point `t` (0-1) along the Catmull-Rom segment p1 → p2. */
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return { x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) };
}

const smoothstep = (u) => { const v = clamp01(u); return v * v * (3 - 2 * v); };

/** The line's width (face units) at the shoulder and at the wrist, for a character drawn at `unitPx` px per unit. */
export function armWidths(unitPx = MASCOT_ARM.unitPx) {
  const k = Number(unitPx) > 0 ? Number(unitPx) : MASCOT_ARM.unitPx;
  const u = px => clamp(px / k, MASCOT_ARM.units.min, MASCOT_ARM.units.max);
  return { w0: u(MASCOT_ARM.px.w0), w1: u(MASCOT_ARM.px.w1) };
}

/**
 * The noodle's two edges through `points` (shoulder first, hand last, face
 * units), × `scale`: armWidths(unitPx) w0 wide at the shoulder, tapering to w1
 * at the wrist, and with `cuff` (a half-width, drawn units) swelling over the
 * last ARM_FLARE units into the palm, so the hand grows out of the arm with no
 * step. Also the direction the arm ends in (`tangent`, radians) and the
 * shoulder's radius. null when the arm is too short to draw.
 */
function armOutline(points, scale = 1, cuff = 0, unitPx = MASCOT_ARM.unitPx) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const k = clamp(Number(scale) || 0, 0, 1.2);
  const { w0, w1 } = armWidths(unitPx);
  const line = [];
  const steps = 6;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    for (let j = 0; j < steps; j += 1) line.push(catmull(p0, points[i], points[i + 1], p3, j / steps));
  }
  line.push(points[points.length - 1]);
  const at = [0];
  for (let i = 1; i < line.length; i += 1) at.push(at[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y));
  const total = at[at.length - 1];
  if (!(total > 0.5) || k <= 0.01) return null;
  const swell = Math.max(0, Number(cuff) || 0);
  const left = [];
  const right = [];
  for (let i = 0; i < line.length; i += 1) {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dl = Math.hypot(dx, dy) || 1;
    let hw = (w0 + (w1 - w0) * (at[i] / total)) * k / 2;
    if (swell > hw) hw += (swell - hw) * smoothstep((at[i] - (total - ARM_FLARE)) / ARM_FLARE);
    left.push({ x: line[i].x - (dy / dl) * hw, y: line[i].y + (dx / dl) * hw });
    right.push({ x: line[i].x + (dy / dl) * hw, y: line[i].y - (dx / dl) * hw });
  }
  const end = line[line.length - 1];
  const before = line[line.length - 2];
  return { left, right, r0: w0 * k / 2, tangent: Math.atan2(end.y - before.y, end.x - before.x) };
}

/** An outline's path data: smooth edges (quadratics through the midpoints) and a round shoulder. */
function outlinePath(o) {
  const edge = (pts) => {
    let d = '';
    for (let i = 1; i < pts.length - 1; i += 1) {
      const m = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
      d += ` Q${n(pts[i].x)},${n(pts[i].y)} ${n(m.x)},${n(m.y)}`;
    }
    const last = pts[pts.length - 1];
    return `${d} L${n(last.x)},${n(last.y)}`;
  };
  const back = o.right.slice().reverse();
  return `M${n(o.left[0].x)},${n(o.left[0].y)}${edge(o.left)} L${n(back[0].x)},${n(back[0].y)}${edge(back)}`
    + ` A${n(o.r0)},${n(o.r0)} 0 0 1 ${n(o.left[0].x)},${n(o.left[0].y)}Z`;
}

/**
 * The noodle's outline as path data: one smooth tapered shape, w0 wide at the
 * shoulder (a rounded end that goes into the body) and w1 at the wrist, × `scale`,
 * swelling into a `cuff` half-width at the wrist when one is given (armOutline).
 * '' when the arm is too short to draw. The hand is armHandPath's.
 */
export function armPath(points, scale = 1, cuff = 0, unitPx = MASCOT_ARM.unitPx) {
  const o = armOutline(points, scale, cuff, unitPx);
  return o ? outlinePath(o) : '';
}

/** Twice a polygon's signed area (the shoelace sum): its sign is which way round it goes. */
const shoelace = (pts) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p.x * q.y - q.x * p.y; }, 0);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** A pill from `a` to `b` of radius `r`, as a polygon (local units). */
function pillPolygon(a, b, r, segs = 10) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const pts = [];
  for (let i = 0; i <= segs; i += 1) { const t = ang - Math.PI / 2 + (Math.PI * i) / segs; pts.push({ x: b.x + r * Math.cos(t), y: b.y + r * Math.sin(t) }); }
  for (let i = 0; i <= segs; i += 1) { const t = ang + Math.PI / 2 + (Math.PI * i) / segs; pts.push({ x: a.x + r * Math.cos(t), y: a.y + r * Math.sin(t) }); }
  return pts;
}

/**
 * The hand at `wrist` (face units), pointing along `angle` (radians, screen
 * coordinates) on the arm of `side` (0 left, 1 right): a round palm the noodle
 * swells into, one index pill out `point` (0-1) of its length, on the line
 * through the wrist at `angle` (so the index aims exactly where the hand is
 * turned), and a thumb nub that opens with it. Built from pills like the eyes.
 * The thumb is on top for a level arm and outward for a lowered one, on either
 * side (left mirrors right). `scale` grows it with the arm; `squash` (a poke
 * landing) shortens it along the aim and widens it across. Path data of three
 * pills, each the same way round (`sign`, the noodle's, so a nonzero fill
 * paints the union once, whatever alpha `currentColor` carries). '' when too
 * small to draw.
 */
export function armHandPath(wrist, angle, side, { scale = 1, point = 1, squash = 0, sign = -1 } = {}) {
  const H = MASCOT_ARM.hand;
  const hs = clamp(Number(scale) || 0, 0, 1.2);
  if (hs <= 0.01 || !Number.isFinite(Number(wrist?.x)) || !Number.isFinite(Number(wrist?.y))) return '';
  const pt = clamp01(Number(point) || 0);
  const sq = clamp(Number(squash) || 0, -0.3, 0.3);
  const th = Number(angle) || 0;
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const sx = hs * (1 - sq);
  const sy = hs * (1 + sq) * (side ? -1 : 1); // +y is the thumb's side
  const toWorld = (p) => { const x = p.x * sx; const y = p.y * sy; return { x: wrist.x + x * cos - y * sin, y: wrist.y + x * sin + y * cos }; };
  const open = 0.5 + 0.5 * pt; // the thumb: tucked on a relaxed hand, out when it points
  const pills = [
    pillPolygon({ x: -0.5, y: 0 }, { x: 3.5, y: 0 }, H.palm),
    pillPolygon({ x: 4, y: 0 }, { x: 4 + H.indexLen * pt, y: 0 }, H.index),
    pillPolygon({ x: 0.5, y: 4 }, { x: 0.5 + 3 * open, y: 4 + H.thumbLen * open }, H.thumb),
  ];
  const way = sign < 0 ? -1 : 1;
  return pills.map((poly) => {
    const w = poly.map(toWorld);
    if (Math.sign(shoelace(w)) !== way) w.reverse();
    return `M${w.map(p => `${n(p.x)},${n(p.y)}`).join('L')}Z`;
  }).join('');
}

/**
 * Everything one arm draws, as one path: the noodle swelling into the palm, then
 * the hand at the wrist (armHandPath), turned to the frame's `hand` angle (the
 * line from the hand to what it points at, on its own spring; the arm's end
 * when there is none). `frame` is one side of createArmSim().frame(); `side` 0
 * left, 1 right; `unitPx` the character's px per face unit (the line's width is
 * in px). One path, every subpath the same way round. '' when there is nothing
 * to draw.
 */
export function armDrawPath(frame, side, { unitPx = MASCOT_ARM.unitPx } = {}) {
  if (!frame || !Array.isArray(frame.points) || !(frame.e > 0)) return '';
  const grown = frame.e / Math.max(0.05, Number(frame.span) > 0 ? Number(frame.span) : 1);
  const hs = handScale(grown);
  const sq = clamp(Number(frame.squash) || 0, -0.3, 0.3);
  const pt = clamp01(frame.point == null ? 1 : Number(frame.point) || 0);
  const o = armOutline(frame.points, clamp01(grown * 1.7), MASCOT_ARM.hand.palm * hs * (1 + sq), unitPx);
  if (!o) return '';
  const wrist = frame.points[frame.points.length - 1];
  const angle = Number.isFinite(frame.hand) ? frame.hand : o.tangent;
  const sign = Math.sign(shoelace([...o.left, ...o.right.slice().reverse()])) || -1;
  return outlinePath(o) + armHandPath(wrist, angle, side, { scale: hs, point: pt, squash: sq, sign });
}

/**
 * The eyes of `frame` kept to MASCOT_ARM.gaze, `amount` (0-1) of the way (an arm
 * on its way out or home eases them in and out): while an arm is out an eye
 * never travels to it. A new frame; `frame` is left as it is.
 */
export function armGaze(frame, amount = 1) {
  const g = clamp01(Number(amount) || 0);
  if (!frame?.eyes || g <= 0) return frame;
  const G = MASCOT_ARM.gaze;
  const f = cloneFrame(frame);
  for (const e of f.eyes) {
    e.dx += (clamp(e.dx, -G.x, G.x) - e.dx) * g;
    e.dy += (clamp(e.dy, -G.y, G.y) - e.dy) * g;
    e.sx += (Math.min(e.sx, G.sx) - e.sx) * g;
    e.sy += (Math.min(e.sy, G.sy) - e.sy) * g;
  }
  return f;
}

/**
 * The arms' motion, with no DOM: two arms of damped springs. aim(side, angle,
 * { target, reach }) grows that arm `reach` (0-1) of the way and turns its hand
 * toward `target` (face units; the other one goes home, or flicks once for
 * balance), release() sends both home, poke() pokes twice, nudge(vx, vy) is a
 * jolt of the body (units/s: the points keep part of their speed, so they lag),
 * step(dt) advances, finish() jumps to the end (reduced motion: no overshoot,
 * no wiggle), frame() says what to draw.
 */
export function createArmSim() {
  // Per arm: the reach e (0 home, 1 grown) and its speed, the three spring points, the target its index
  // aims at, and the hand's own numbers: pt (0 a relaxed hand, 1 the index out), sq (the poke's squash,
  // a small spring) and ha (its angle, on a spring that follows the line to the target).
  // `span` is the reach the arm was last sent to (1 for the flick): the hand and the index grow with e / span.
  const arms = [0, 1].map(side => ({
    side, e: 0, ve: 0, goal: 0, span: 1, angle: 0, pts: null, held: false, flickUntil: -1, pokeAt: -1,
    pt: 0, sq: 0, vsq: 0, target: null, ha: 0, vha: 0, sh: null,
  }));
  const grownOf = a => a.e / Math.max(0.05, a.span);
  // The face's prop (PROP_BOX's name): an arm whose shoulder it covers roots under it (armShoulder). The
  // root `sh` is a spring toward that place, so a prop arriving while the arm is out slides it, never pops.
  let prop = null;
  const rootGoal = a => armShoulder(a.side, prop);
  const rootOf = (a) => {
    if (!a.sh) { const g = rootGoal(a); a.sh = { x: g.x, y: g.y, vx: 0, vy: 0 }; }
    return a.sh;
  };
  /** The two pokes' push (0-1) `t` s after they began: two quick bumps, then nothing. */
  const pokeBump = (t) => {
    const bump = (x) => (x > 0 && x < ARM_POKE.dur ? Math.sin(Math.PI * x / ARM_POKE.dur) : 0);
    return bump(t) + bump(t - ARM_POKE.gap);
  };
  let time = 0;
  const restOf = (a, wiggle) => armRest(a.side, a.angle, a.e, wiggle ? time : null, rootOf(a));
  const ensurePts = (a) => {
    if (a.pts) return;
    a.sh = null; // a fresh sprout roots where the prop lets it, at once
    a.pts = restOf(a, false).map(p => ({ x: p.x, y: p.y, vx: 0, vy: 0 }));
    a.ha = Math.atan2(Math.sin(a.angle), (a.side ? 1 : -1) * Math.cos(a.angle)); // the hand comes out along the arm
    a.vha = 0;
  };
  const moving = (a) => !!a.pts && (a.held || a.e > 1e-3 || Math.abs(a.ve) > 1e-3 || Math.abs(a.sq) > 0.002 || Math.abs(a.vsq) > 0.02
    || Math.abs(a.vha) > 0.02 || (!!a.sh && Math.abs(a.sh.vx) + Math.abs(a.sh.vy) > 0.05)
    || a.pts.some(p => Math.abs(p.vx) + Math.abs(p.vy) > 0.05));

  /** Where the hand should point: the arm's own end, turned toward the target as far as the index is out. */
  function handGoal(a) {
    const hand = a.pts[2];
    const prev = a.pts[1];
    const along = Math.hypot(hand.x - prev.x, hand.y - prev.y) > 0.3
      ? Math.atan2(hand.y - prev.y, hand.x - prev.x)
      : Math.atan2(Math.sin(a.angle), (a.side ? 1 : -1) * Math.cos(a.angle));
    if (!a.target) return along;
    const dx = a.target.x - hand.x;
    const dy = a.target.y - hand.y;
    if (Math.hypot(dx, dy) < 4) return a.ha;
    return along + wrapAngle(Math.atan2(dy, dx) - along) * smoothstep(a.pt);
  }

  /**
   * Keep every point inside the shoulder's free wedge (ARM_BOUND, ARM_KINK), no
   * nearer the shoulder than ARM_HOLD of its rest, and clear of the face
   * (ARM_KEEP_OUT, by the line's or the palm's radius): a point stopped there
   * loses the speed that took it out, a little of it coming back as a bounce.
   */
  function bound(a, rest) {
    const s = rootOf(a);
    const out = a.side ? 1 : -1;
    const hs = handScale(grownOf(a));
    let prev = null;
    a.pts.forEach((p, i) => {
      const stop = (nx, ny) => { // the speed into (nx, ny)'s opposite is spent
        const vn = p.vx * nx + p.vy * ny;
        if (vn < 0) { p.vx -= 1.2 * vn * nx; p.vy -= 1.2 * vn * ny; }
      };
      const dx = (p.x - s.x) * out;
      const dy = p.y - s.y;
      const r = Math.hypot(dx, dy);
      const hold = ARM_HOLD[i] * Math.hypot(rest[i].x - s.x, rest[i].y - s.y);
      if (r >= 0.5) {
        const th = Math.atan2(dy, dx);
        let c = th;
        if (c < ARM_BOUND[0] || c > ARM_BOUND[1]) {
          c = Math.abs(wrapAngle(th - ARM_BOUND[0])) <= Math.abs(wrapAngle(th - ARM_BOUND[1])) ? ARM_BOUND[0] : ARM_BOUND[1];
        }
        if (prev != null && Math.abs(c - prev) > ARM_KINK) c = prev + Math.sign(c - prev) * ARM_KINK;
        const rr = Math.max(r, hold);
        if (c !== th || rr !== r) {
          p.x = s.x + out * rr * Math.cos(c);
          p.y = s.y + rr * Math.sin(c);
          // Keep the speed along the radius (outward only, when it was folded in); the sideways part is spent.
          const ux = out * Math.cos(c);
          const uy = Math.sin(c);
          let vr = p.vx * ux + p.vy * uy;
          if (rr !== r && vr < 0) vr = 0;
          const vtx = p.vx - (p.vx * ux + p.vy * uy) * ux;
          const vty = p.vy - (p.vx * ux + p.vy * uy) * uy;
          const keep = c !== th ? -0.2 : 1;
          p.vx = vr * ux + keep * vtx;
          p.vy = vr * uy + keep * vty;
        }
        prev = c;
      } else prev = null;
      // Clear of the eyes and the smile: by the line's half-width, by the palm for the hand.
      const need = ARM_CLEAR + (i === 2 ? MASCOT_ARM.hand.palm * hs * 1.16 : MASCOT_ARM.units.max / 2);
      for (const b of ARM_KEEP_OUT) {
        const g = boxDistance(p.x, p.y, b);
        if (g.d < need) { p.x += g.nx * (need - g.d); p.y += g.ny * (need - g.d); stop(g.nx, g.ny); }
      }
    });
  }

  /**
   * The hand's angle, kept clear of the face: as asked when its palm, index and
   * thumb keep ARM_CLEAR from ARM_KEEP_OUT (always, for anything beside the
   * face); otherwise turned the least toward the arm's own end until they do.
   */
  function clearAngle(a, angle) {
    const wrist = a.pts[2];
    const hs = handScale(grownOf(a));
    if (hs <= 0.01 || handClear(wrist, angle, a.side, hs, a.pt)) return angle;
    const prev = a.pts[1];
    const along = Math.atan2(wrist.y - prev.y, wrist.x - prev.x);
    const toward = Math.sign(wrapAngle(along - angle)) || 1;
    for (let k = 1; k <= 24; k += 1) {
      for (const way of [toward, -toward]) {
        const c = angle + way * k * 0.07;
        if (handClear(wrist, c, a.side, hs, a.pt)) return wrapAngle(c);
      }
    }
    return along;
  }

  function stepArm(a, h) {
    if (a.flickUntil >= 0 && time >= a.flickUntil) { a.goal = 0; a.flickUntil = -1; }
    let push = 0;
    let squash = 0;
    if (a.pokeAt >= 0) {
      const since = time - a.pokeAt;
      if (since > ARM_POKE.gap + ARM_POKE.dur) a.pokeAt = -1;
      else {
        push = pokeBump(since);
        squash = HAND_SQUASH * push; // the hand lands on the target at the bump's peak
      }
    }
    const [w, z] = a.held || a.flickUntil >= 0 ? ARM_GROW : ARM_SHRINK;
    a.ve += (w * w * (a.goal - a.e) - 2 * z * w * a.ve) * h;
    a.e += a.ve * h;
    if (!a.held && a.e < 0) { a.e = 0; a.ve = 0; } // home: into the body, never out the other side
    // The hand: the index unfurls as a held arm grows (and folds once it is let go: the flick arm and
    // a retreating one show a relaxed hand); a poke squashes it, and the squash rebounds and settles.
    a.pt += ((a.held ? clamp01((grownOf(a) - 0.25) / 0.45) : 0) - a.pt) * (1 - Math.exp(-HAND_POINT_RATE * h));
    const [sw, sz] = HAND_SQUASH_SPRING;
    a.vsq += (sw * sw * (squash - a.sq) - 2 * sz * sw * a.vsq) * h;
    a.sq += a.vsq * h;
    // The root glides to where the face's prop lets it be (armShoulder); it never jumps.
    const sh = rootOf(a);
    const g = rootGoal(a);
    const [rw, rz] = ARM_ROOT_SPRING;
    sh.vx += (rw * rw * (g.x - sh.x) - 2 * rz * rw * sh.vx) * h;
    sh.vy += (rw * rw * (g.y - sh.y) - 2 * rz * rw * sh.vy) * h;
    sh.x += sh.vx * h;
    sh.y += sh.vy * h;
    if (Math.abs(sh.x - g.x) + Math.abs(sh.y - g.y) < 0.05 && Math.abs(sh.vx) + Math.abs(sh.vy) < 0.5) { sh.x = g.x; sh.y = g.y; sh.vx = 0; sh.vy = 0; }
    const rest = restOf(a, a.held);
    if (push > 0) {
      // A poke goes along the line the index aims down, the hand most.
      const ux = Math.cos(a.ha);
      const uy = Math.sin(a.ha);
      rest.forEach((p, i) => { p.x += ux * ARM_POKE.dist * ARM_POKE.share[i] * push; p.y += uy * ARM_POKE.dist * ARM_POKE.share[i] * push; });
    }
    a.pts.forEach((p, i) => {
      const [k, zeta] = ARM_SPRINGS[i];
      const c = 2 * zeta * Math.sqrt(k);
      p.vx += (k * (rest[i].x - p.x) - c * p.vx) * h;
      p.vy += (k * (rest[i].y - p.y) - c * p.vy) * h;
      p.x += p.vx * h;
      p.y += p.vy * h;
    });
    bound(a, rest);
    const [tw, tz] = HAND_TURN;
    a.vha += (tw * tw * wrapAngle(clearAngle(a, handGoal(a)) - a.ha) - 2 * tz * tw * a.vha) * h;
    const turned = wrapAngle(a.ha + a.vha * h);
    a.ha = clearAngle(a, turned);
    if (a.ha !== turned) a.vha *= 0.3; // turned back off the face: the swing is spent
    if (!a.held && a.flickUntil < 0 && a.e < 1e-3 && Math.abs(a.ve) < 1e-3 && a.pts.every(p => Math.abs(p.vx) + Math.abs(p.vy) < 0.05)) {
      a.e = 0;
      a.ve = 0;
      a.pt = 0;
      a.sq = 0;
      a.vsq = 0;
      a.vha = 0;
      a.pts = null; // home and still: nothing to draw
      a.sh = null;
    }
  }

  return {
    /** The prop the face shows (PROP_BOX's name, or null): an arm whose shoulder it covers roots under it (armShoulder). */
    prop(name) {
      prop = name && PROP_BOX[name] ? name : null;
      return prop;
    },
    /** Where the arm on `side` roots for the prop shown (face units; the glide there is the sim's own). */
    root(side) { return rootGoal(arms[side ? 1 : 0]); },
    aim(side, angle, { target = null, reach = 1 } = {}) {
      const a = arms[side ? 1 : 0];
      const other = arms[side ? 0 : 1];
      const sprouting = !a.held && a.e < 0.15;
      a.angle = clampAim(angle);
      ensurePts(a);
      a.held = true;
      a.goal = clamp(Number.isFinite(Number(reach)) ? Number(reach) : 1, ARM_MIN_REACH, 1);
      a.span = a.goal;
      a.target = target && Number.isFinite(Number(target.x)) && Number.isFinite(Number(target.y)) ? { x: Number(target.x), y: Number(target.y) } : null;
      a.flickUntil = -1;
      if (other.held) { other.held = false; other.goal = 0; other.pokeAt = -1; } // the target changed side
      else if (sprouting && other.e < 0.05 && other.flickUntil < 0) {
        other.angle = ARM_FLICK.angle;
        other.target = null;
        ensurePts(other);
        other.goal = ARM_FLICK.e;
        other.span = 1;
        other.flickUntil = time + ARM_FLICK.hold;
      }
    },
    release() {
      for (const a of arms) { a.held = false; a.goal = 0; a.pokeAt = -1; if (a.flickUntil >= 0) a.flickUntil = time; }
    },
    poke() {
      const a = arms.find(x => x.held);
      if (a) a.pokeAt = time;
    },
    nudge(vx, vy) {
      const dx = Number.isFinite(Number(vx)) ? Number(vx) : 0;
      const dy = Number.isFinite(Number(vy)) ? Number(vy) : 0;
      for (const a of arms) {
        if (!a.pts) continue;
        a.pts.forEach((p, i) => {
          p.vx -= dx * ARM_NUDGE[i];
          p.vy -= dy * ARM_NUDGE[i];
          const sp = Math.hypot(p.vx, p.vy);
          if (sp > ARM_MAX_SPEED) { p.vx *= ARM_MAX_SPEED / sp; p.vy *= ARM_MAX_SPEED / sp; }
        });
      }
    },
    step(dt) {
      let left = clamp(Number(dt) || 0, 0, 0.064);
      while (left > 1e-6) {
        const h = Math.min(1 / 240, left);
        left -= h;
        time += h;
        for (const a of arms) if (a.pts) stepArm(a, h);
      }
    },
    /** The end of the motion at once: a held arm grown and still, its hand on the target, everything else home. */
    finish() {
      for (const a of arms) {
        a.pokeAt = -1;
        a.flickUntil = -1;
        a.ve = 0;
        a.e = a.held ? a.goal : 0;
        a.pt = a.held ? 1 : 0;
        a.sq = 0;
        a.vsq = 0;
        a.vha = 0;
        a.sh = a.held ? { ...rootGoal(a), vx: 0, vy: 0 } : null;
        a.pts = a.held ? restOf(a, false).map(p => ({ x: p.x, y: p.y, vx: 0, vy: 0 })) : null;
        if (a.pts) a.ha = clearAngle(a, handGoal(a));
      }
    },
    /** Something still moves (or is held out). */
    awake: () => arms.some(moving),
    /** Only the held wiggle is left: no growth, poke, flick, squash, turn or jolt in flight. */
    settled() {
      return arms.every((a) => {
        if (!a.pts) return true;
        if (!a.held || a.pokeAt >= 0 || a.flickUntil >= 0 || Math.abs(a.ve) > 0.03 || Math.abs(a.e - a.goal) > 0.004) return false;
        if (Math.abs(a.sq) > 0.004 || Math.abs(a.vsq) > 0.05 || Math.abs(a.pt - 1) > 0.01 || Math.abs(a.vha) > 1) return false; // the wiggle turns it slowly
        const g = rootGoal(a);
        if (!a.sh || Math.abs(a.sh.x - g.x) + Math.abs(a.sh.y - g.y) > 0.3) return false; // the root still slides under a prop
        const rest = restOf(a, true);
        return a.pts.every((p, i) => Math.abs(p.x - rest[i].x) + Math.abs(p.y - rest[i].y) < 1.6); // the springs trail the wiggle a little
      });
    },
    /** How far out the arms are (0 both home, 1 one grown): the eyes keep to MASCOT_ARM.gaze this much. */
    presence() {
      let e = 0;
      for (const a of arms) if (a.pts) e = Math.max(e, a.held ? 1 : a.e);
      return clamp01(e * 2.5);
    },
    /**
     * The face-unit box the held arm takes once it has grown (its rest at full
     * stretch, the hand turned to its target, the fingertip), or null: what a
     * host keeps its own drawing out of.
     */
    extent() {
      const a = arms.find(x => x.held);
      if (!a) return null;
      const s = rootGoal(a);
      const pts = [s, ...armRest(a.side, a.angle, a.goal, null, s)];
      const hand = pts[3];
      const dir = a.target ? Math.atan2(a.target.y - hand.y, a.target.x - hand.x) : Math.atan2(hand.y - pts[2].y, hand.x - pts[2].x);
      const tip = { x: hand.x + Math.cos(dir) * HAND_TIP, y: hand.y + Math.sin(dir) * HAND_TIP };
      const r = MASCOT_ARM.hand.palm * 1.1;
      const xs = [...pts.map(p => p.x), tip.x];
      const ys = [...pts.map(p => p.y), tip.y];
      return { left: Math.min(...xs) - r, top: Math.min(...ys) - r, right: Math.max(...xs) + r, bottom: Math.max(...ys) + r };
    },
    /** The side held out (0 left, 1 right), or -1. */
    get side() { const a = arms.find(x => x.held); return a ? a.side : -1; },
    /**
     * Per side: null (nothing to draw) or { e, span, points: [shoulder, a third, two thirds, hand], aim,
     * point, squash, hand, target }: `span` the reach it was sent to (the hand grows with e / span), `aim` the angle the arm was asked for (0 straight out, + down),
     * `point` 0-1 how far the hand points (1 the index out, 0 a relaxed hand), `squash` the poke's
     * squash, `hand` the hand's angle (radians, screen coordinates), `target` the point (face units)
     * its index aims at, or null.
     */
    frame() {
      return arms.map((a) => {
        if (!a.pts || a.e <= 0.004) return null;
        const sh = rootOf(a);
        return {
          e: a.e,
          span: a.span,
          points: [{ x: sh.x, y: sh.y }, ...a.pts.map(p => ({ x: p.x, y: p.y }))],
          aim: a.angle,
          point: a.pt,
          squash: a.sq,
          hand: a.ha,
          target: a.target ? { ...a.target } : null,
        };
      });
    },
  };
}

// ── Painter: frame → attributes, each written only when it changed ──

let uidSeq = 0;
const nextUid = () => `syna-m${(uidSeq += 1).toString(36)}`;

function lidTransform(e, i) {
  const cx = EYE_CX[i];
  return `translate(${n(e.dx)},${n(e.dy)}) translate(${cx},${EYE_CY}) rotate(${n(e.rot)}) scale(${n(e.sx)},${n(Math.max(0.04, e.sy))}) translate(${-cx},${-EYE_CY})`;
}

// A still frame's prop reads at a glance: every visible part at least this
// opaque, every stroke at least this many CSS px wide (the live loop keeps
// the drawn values; a still has no motion to carry a faint prop).
const STILL_PROP_OPACITY = 0.7;
const STILL_STROKE_PX = 1.5;
const OPACITY_ATTRS = ['fill-opacity', 'stroke-opacity'];

function createPainter(svg, uid) {
  const refs = mascotRefs(svg);
  const lids = Array.from(refs.lids).slice(0, 2);
  const written = new WeakMap();
  const built = new Map();
  const put = (el, attr, value) => {
    if (!el) return;
    let seen = written.get(el);
    if (!seen) { seen = {}; written.set(el, seen); }
    if (seen[attr] === value) return;
    seen[attr] = value;
    if (value == null) el.removeAttribute(attr);
    else el.setAttribute(attr, value);
  };
  /** CSS px per face unit: the SVG's box over its viewBox (xMidYMid meet: the tighter axis). */
  const unitPx = () => {
    const w = Number(svg.getAttribute?.('width'));
    const h = Number(svg.getAttribute?.('height'));
    const box = String(svg.getAttribute?.('viewBox') || '').split(/[\s,]+/).map(Number);
    if (!(w > 0 && box[2] > 0)) return 1;
    return h > 0 && box[3] > 0 ? Math.min(w / box[2], h / box[3]) : w / box[2];
  };
  const propEntry = (name) => {
    let entry = built.get(name);
    if (entry || !refs.props || !PROPS[name]) return entry || null;
    refs.props.insertAdjacentHTML('beforeend', `<g class="syna-prop" data-prop="${name}" display="none">${PROPS[name].markup(uid)}</g>`);
    const g = refs.props.lastElementChild;
    // The drawn attributes as the markup has them: a live frame goes back to these before its update.
    const base = [];
    for (const el of g.querySelectorAll('[fill-opacity], [stroke-opacity], [stroke-width]')) {
      for (const attr of [...OPACITY_ATTRS, 'stroke-width']) if (el.hasAttribute(attr)) base.push({ el, attr, value: el.getAttribute(attr) });
    }
    entry = { g, r: PROPS[name].refs(g), base };
    built.set(name, entry);
    return entry;
  };
  /** Raise a still's prop: visible parts to STILL_PROP_OPACITY, strokes to STILL_STROKE_PX. */
  const legible = (entry) => {
    const minStroke = STILL_STROKE_PX / unitPx();
    for (const el of entry.g.querySelectorAll('[fill-opacity], [stroke-opacity], [stroke-width]')) {
      for (const attr of OPACITY_ATTRS) {
        // A fill under a stroke is a background (a ticked box): raising it would drown what is drawn on it.
        if (attr === 'fill-opacity' && (el.getAttribute('stroke') || 'none') !== 'none') continue;
        const v = Number(el.getAttribute(attr));
        if (el.hasAttribute(attr) && v > 0.05 && v < STILL_PROP_OPACITY) put(el, attr, String(STILL_PROP_OPACITY));
      }
      const w = Number(el.getAttribute('stroke-width'));
      if (el.hasAttribute('stroke-width') && w > 0 && w < minStroke) put(el, 'stroke-width', n(minStroke));
    }
  };
  function paint(f) {
    if (refs.face) {
      put(refs.face, 'transform', `translate(${n(f.face.dx)},${n(f.face.dy)}) rotate(${n(f.face.rot)} 140 70)`);
      put(refs.face, 'opacity', f.face.op < 0.999 ? n(f.face.op) : null);
    }
    lids.forEach((lid, i) => put(lid, 'transform', lidTransform(f.eyes[i], i)));
    put(refs.mouth, 'd', mouthPath(f.mouth));
    put(refs.mouth, 'stroke-opacity', n(f.mouth.op));
    const cur = f.prop?.name || null;
    const prev = f.propFrom?.name || null;
    const mix = prev !== cur && f.propMix != null ? clamp01(f.propMix) : 1;
    if (cur) propEntry(cur);
    for (const [name, entry] of built) {
      let op = 0;
      let p = null;
      if (name === cur) { op = mix; p = f.prop; } else if (name === prev) { op = 1 - mix; p = f.propFrom; }
      if (op <= 0.001) { put(entry.g, 'display', 'none'); continue; }
      put(entry.g, 'display', null);
      put(entry.g, 'opacity', op < 0.999 ? n(op) : null);
      put(entry.g, 'transform', p.dx || p.dy ? `translate(${n(p.dx || 0)},${n(p.dy || 0)})` : null);
      if (!f.still) for (const b of entry.base) put(b.el, b.attr, b.value); // live: the drawn values
      PROPS[name].update(entry.r, p, put);
      if (f.still) legible(entry);
    }
  }
  return { paint };
}

/** Paint the prop of `kind` in its still state on an SVG from mascotPropSvg(); no face transform. */
export function paintMascotProp(svg, kind) {
  if (!svg || !PROP_BOX[kind]) return;
  const frame = stillFrame(kind);
  paintMascot(svg, markStill({ ...frame, face: { dx: 0, dy: 0, rot: 0, op: 1 }, prop: { ...frame.prop, dx: 0, dy: 0 } }));
}

const painters = new WeakMap();

/** Draw `frame` (poseFrame / stillFrame) on an SVG from mascotSvg(); no rig needed. */
export function paintMascot(svg, frame) {
  let painter = painters.get(svg);
  if (!painter) { painter = createPainter(svg, nextUid()); painters.set(svg, painter); }
  painter.paint(frame);
}

// ── Shared runtime: one observer and one motion listener for every rig ──
// Nothing here picks a rig: each one decides from its own state (active, on
// screen, motion allowed) whether it moves.

const rigs = new Set();
let stopMotionWatch = null;
let io = null;
const ioRigs = new WeakMap();

function observe(el, rig) {
  if (typeof IntersectionObserver !== 'function') return;
  try {
    io ||= new IntersectionObserver((entries) => {
      for (const entry of entries) ioRigs.get(entry.target)?.visibilityChanged(entry.isIntersecting);
    });
    ioRigs.set(el, rig);
    io.observe(el);
  } catch { /* no observer: the rig counts as on screen */ }
}

function unobserve(el) {
  ioRigs.delete(el);
  try { io?.unobserve(el); } catch { /* already gone */ }
}

function register(rig) {
  rigs.add(rig);
  stopMotionWatch ||= onReducedMotionChange(() => {
    for (const r of Array.from(rigs)) r.motionChanged();
  });
}

function unregister(rig) {
  rigs.delete(rig);
  if (!rigs.size && stopMotionWatch) { stopMotionWatch(); stopMotionWatch = null; }
}

const BLEND_MS = 160;
const AIM_K = 140; // px: the cursor distance at which the eyes travel half way
const ARM_GAP_PX = 6; // px: how far short of what it points at a fingertip stops, unless the host says
const GLANCES = [[-0.8, -0.35], [0.85, -0.25], [0.45, 0.6], [-0.5, 0.55], [0.1, -0.7]];
const TRACK_TAU = 200; // the v1 lerp of .08 per 60 Hz frame
const SETTLE_UNITS = 0.25; // gaze closer than this (viewBox units, a tenth of a pixel at 120 px) has arrived
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

/** Internal: live rigs registered right now (tests check that still faces are not rigs). */
export const __mascot = { rigs: () => rigs.size };

/**
 * Mount a live character. `createMascot(container, opts)` appends it (v1);
 * `createMascot(opts)` returns it unattached as `el`. See the module header.
 */
export function createMascot(container, options) {
  let host = container;
  let opts = options;
  if (!host || typeof host.insertAdjacentHTML !== 'function') {
    opts = host && typeof host === 'object' ? host : options;
    host = null;
  }
  const {
    width = 128, height = 64, rangeX, rangeY, className = 'synabun-mascot',
    pose: firstPose = 'idle', poseOptions: firstOptions, active: startActive, arms: armsOption,
  } = opts || {};
  const markup = mascotSvg({ width, height, className });
  let svg;
  if (host) {
    host.insertAdjacentHTML('beforeend', markup);
    svg = host.lastElementChild;
  } else {
    const holder = document.createElement('div');
    holder.innerHTML = markup;
    svg = holder.firstElementChild;
    svg.remove();
  }
  const painter = createPainter(svg, nextUid());
  painters.set(svg, painter); // paintMascot() on a live rig's SVG reuses its props
  const range = { x: Math.max(RANGE.x, Number(rangeX) || 0), y: Math.max(RANGE.y, Number(rangeY) || 0) };

  let destroyed = false;
  let active = startActive !== false;
  let visible = true;
  let seenConnected = svg.isConnected;
  let clock = 0; // rig time in ms: the ticker's dt while drawing, real time while still
  let frozenAt = tickerNow(); // while not drawing: when the clock was last brought up to date; -1 while drawing
  let pose = { name: 'idle', raw: {}, start: 0, then: null };
  let settled = false; // a one-shot's opts.then has fired
  let blend = null; // { from, start, dur }
  let lastFrame = null; // the last frame before blinks and reactions
  let look = { x: 0, y: 0 }; // eased gaze
  let track = { x: 0, y: 0 }; // idle: where the cursor (or look()) points
  let hostLook = { x: 0, y: 0 };
  let pointerAt = -Infinity;
  let aim = null; // a pointer position to aim at on the next frame
  let glance = null; // idle: { x, y, until }
  let blinkStart = -1;
  let nextBlinkAt = Infinity;
  let nextGlanceAt = Infinity;
  let nextFidgetAt = Infinity;
  let lastHopAt = -Infinity;
  let ticks = 1;
  let miniBorn = [];
  const reactions = [];
  const tempClasses = new Set();
  let unsubscribeFrames = null;
  let fps = 0;
  let stopPointer = null;
  let stopKey = null;
  let wakeTimer = 0;
  // Arms only on a character big enough to read them (the empty state's, 120 px): never a mini, a cameo or a still.
  const armsAllowed = armsOption != null ? !!armsOption : Number(width) >= 96;
  let arms = null; // { sim, parts, target, unitPx, box, frame, stopWatch } once point() was first called

  const def = () => POSES[pose.name];
  const animating = () => !destroyed && active && visible && !isReducedMotion();
  const poseTime = () => clock - pose.start;

  /** This pose moves on its own right now: a loop, a patient pose, a one-shot still playing. */
  function playing() {
    if (!animating()) return false;
    const { motion, settle } = def();
    if (motion === 'loop' || motion === 'blink') return true;
    return motion === 'once' && poseTime() < settle;
  }

  /** Where the eyes are headed for this pose. */
  function gazeTarget() {
    const d = def();
    if (d.tracks) return glance || track;
    if (d.look) return hostLook;
    return ZERO;
  }

  /**
   * A drawing rig's clock moves with the ticker (its dt is clamped after a
   * freeze, so nothing jumps). A still rig has nothing on screen to jump: its
   * clock follows real time, so a pose's timeline (the 6 s blink, a hold)
   * stays on schedule.
   */
  function syncClock() {
    if (frozenAt < 0) return;
    const t = tickerNow();
    clock += Math.max(0, t - frozenAt);
    frozenAt = t;
  }

  function setRate(next) {
    if (next === fps) return;
    if (next <= 0) {
      unsubscribeFrames?.();
      unsubscribeFrames = null;
      fps = 0;
      frozenAt = tickerNow();
      return;
    }
    if (unsubscribeFrames) unsubscribeFrames.setFps(next);
    else {
      syncClock();
      frozenAt = -1;
      unsubscribeFrames = subscribe(onFrame, { fps: next });
    }
    fps = next;
  }

  const ensureRate = (min) => { if (fps < min) setRate(min); };

  const gazes = () => !!(def().tracks || def().look);

  /** Still travelling: more than SETTLE_UNITS from the target on either axis. */
  const far = to => Math.abs(to.x - look.x) * range.x > SETTLE_UNITS || Math.abs(to.y - look.y) * range.y > SETTLE_UNITS;

  function easing() {
    return gazes() && far(gazeTarget());
  }

  function miniPopping() {
    return miniBorn.some(at => at >= 0 && clock - at < 220);
  }

  function nextRate() {
    if (!animating()) return 0;
    if (blend || blinkStart >= 0 || reactions.length || aim || easing() || miniPopping()) return 60;
    const armRate = arms?.sim.awake() ? (arms.sim.settled() ? 30 : 60) : 0;
    if (armRate === 60) return 60;
    const d = def();
    const t = poseTime();
    let rate = 0;
    if (d.motion === 'loop') rate = 30;
    else if (d.motion === 'blink') rate = d.idleFor(t) > 0 ? 0 : 30;
    else if (d.motion === 'once') rate = t < d.settle ? 60 : 0;
    return Math.max(rate, armRate);
  }

  function clearWake() {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = 0;
  }

  /** Still: sleep until the next thing this pose does on its own. */
  function armWake() {
    clearWake();
    if (!animating()) return;
    syncClock();
    const d = def();
    const at0 = tickerNow();
    let at = Infinity;
    if (d.blinks) at = Math.min(at, nextBlinkAt);
    if (d.tracks) at = Math.min(at, nextGlanceAt, nextFidgetAt, glance ? glance.until : Infinity);
    if (d.motion === 'blink') at = Math.min(at, at0 + d.idleFor(poseTime()));
    if (d.motion === 'once' && pose.then && !settled) at = Math.min(at, at0 + Math.max(0, d.settle + (d.hold || 0) - poseTime()));
    if (!Number.isFinite(at)) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = 0;
      if (!animating()) return;
      syncClock();
      handleDue();
      refresh();
    }, Math.max(16, at - at0));
  }

  function startBlink() {
    syncClock();
    blinkStart = clock;
    ensureRate(60);
  }

  /** Arm the idle life (blink, glance, fidget) that is unset or went stale while parked. */
  function scheduleIdle() {
    const t = tickerNow();
    const stale = at => !Number.isFinite(at) || at <= t;
    if (stale(nextBlinkAt)) nextBlinkAt = t + rand(3000, 7000);
    if (def().tracks) {
      if (stale(nextGlanceAt)) nextGlanceAt = t + rand(9000, 15000);
      if (stale(nextFidgetAt)) nextFidgetAt = t + rand(45000, 75000);
    }
  }

  /** Blinks, glances, fidgets and one-shot hand-offs that came due. */
  function handleDue() {
    const d = def();
    const t = tickerNow();
    if (d.blinks && t >= nextBlinkAt) {
      nextBlinkAt = t + rand(3000, 7000);
      startBlink();
    }
    if (d.tracks) {
      if (glance && t >= glance.until) glance = null;
      if (t >= nextGlanceAt) {
        // Only while the cursor is still.
        if (t - pointerAt < 2500) nextGlanceAt = t + 3000;
        else {
          const [x, y] = GLANCES[Math.floor(Math.random() * GLANCES.length)];
          glance = { x, y, until: t + rand(700, 1000) };
          nextGlanceAt = t + rand(9000, 15000);
        }
      }
      if (t >= nextFidgetAt) {
        const quietFor = t - Math.max(lastInputAt(), pointerAt);
        if (quietFor < 20000) nextFidgetAt = t + (20000 - quietFor) + rand(0, 5000);
        else {
          nextFidgetAt = t + rand(45000, 75000);
          startReaction(Math.random() < 0.5 ? 'hop' : 'wiggle');
        }
      }
    }
    if (d.motion === 'once' && pose.then && !settled && poseTime() >= d.settle + (d.hold || 0)) {
      settled = true;
      setPose(pose.then);
    }
  }

  function clearTempClasses() {
    for (const cls of tempClasses) svg.classList.remove(cls);
    tempClasses.clear();
  }

  function onAnimationEnd(e) {
    if (e.target === svg) clearTempClasses();
  }

  function startReaction(name) {
    syncClock();
    const at = tickerNow();
    if (name === 'hop') {
      if (at - lastHopAt < 600) return false;
      lastHopAt = at;
    }
    const i = reactions.findIndex(r => r.name === name);
    if (i >= 0) reactions.splice(i, 1);
    reactions.push({ name, start: clock, dur: REACTIONS[name] });
    const cls = `syna-react-${name}`;
    svg.classList.add(cls);
    tempClasses.add(cls);
    requestFrames(REACTIONS[name]);
    ensureRate(60);
    return true;
  }

  /** The pose frame this rig would draw now, before blends and overlays. */
  function frameNow() {
    return poseFrame(pose.name, poseTime(), { ...pose.raw, look, range, ticks, still: !playing() });
  }

  /** Ease from what is on screen to what comes next, unless they already match. */
  function blendIn() {
    const from = lastFrame || stillFrameNow();
    blend = sameFrame(from, frameNow()) ? null : { from, start: clock, dur: BLEND_MS };
  }

  function stillFrameNow() {
    const d = def();
    return poseFrame(pose.name, 0, { ...pose.raw, look: d.look ? hostLook : ZERO, range, ticks, still: true });
  }

  /** Not animating: the pose's still frame, nothing pending. */
  function paintStill() {
    blend = null;
    blinkStart = -1;
    glance = null;
    aim = null;
    reactions.length = 0;
    miniBorn = [];
    clearTempClasses();
    look = def().look ? { ...hostLook } : { x: 0, y: 0 };
    lastFrame = stillFrameNow();
    if (arms) { arms.sim.prop(lastFrame?.prop?.name || null); arms.sim.finish(); }
    paintFace(lastFrame);
    if (arms) paintArms();
  }

  /** Paint a face frame; while an arm is out its eyes keep to MASCOT_ARM.gaze (never toward an arm). */
  function paintFace(f) {
    if (arms) arms.sim.prop(f?.prop?.name || null); // an arm whose shoulder this prop covers roots under it
    painter.paint(arms ? armGaze(f, arms.sim.presence()) : f);
  }

  function compose() {
    let f = frameNow();
    if (f.prop.name === 'subagent') {
      f.prop.minis.forEach((m, i) => {
        const age = miniBorn[i] >= 0 ? clock - miniBorn[i] : Infinity;
        if (age < 220) { m.s *= 0.6 + 0.4 * springEase(age / 220); m.op = clamp01(age / 120); }
      });
    }
    if (blend) {
      const p = (clock - blend.start) / blend.dur;
      if (p >= 1) blend = null;
      else f = mixFrames(blend.from, f, easeStandard(clamp01(p)));
    }
    lastFrame = f;
    if (blinkStart >= 0) {
      const e = clock - blinkStart;
      if (e >= 280) blinkStart = -1;
      else {
        f = cloneFrame(f);
        const k = 1 - 0.94 * blinkAmount(e);
        for (const eyeF of f.eyes) eyeF.sy *= k;
      }
    }
    for (let i = reactions.length - 1; i >= 0; i -= 1) {
      const r = reactions[i];
      const p = (clock - r.start) / r.dur;
      if (p >= 1) {
        reactions.splice(i, 1);
        svg.classList.remove(`syna-react-${r.name}`);
        tempClasses.delete(`syna-react-${r.name}`);
      }
    }
    for (const r of reactions) f = reactionFrame(f, r.name, (clock - r.start) / r.dur);
    return f;
  }

  function easeLook(dt) {
    if (!gazes()) { look = { x: 0, y: 0 }; return; }
    const to = gazeTarget();
    const tau = def().look || TRACK_TAU;
    const k = 1 - Math.exp(-dt / tau);
    look = { x: look.x + (to.x - look.x) * k, y: look.y + (to.y - look.y) * k };
    if (!far(to)) look = { x: to.x, y: to.y };
  }

  function aimAt(p) {
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    const vx = p.x - (r.left + r.width / 2);
    const vy = p.y - (r.top + r.height / 2);
    const d = Math.hypot(vx, vy);
    if (d < 1) { track = { x: 0, y: 0 }; return; }
    const m = (d / (d + AIM_K)) * 1.25;
    track = { x: unit((vx / d) * m), y: unit((vy / d) * m) };
  }

  function onFrame(_now, dt) {
    if (destroyed) return;
    if (!svg.isConnected) {
      if (seenConnected) { destroy(); return; }
      setRate(0); // built before it was attached: wait for the observer
      return;
    }
    seenConnected = true;
    clock += dt;
    handleDue();
    if (aim) { aimAt(aim); aim = null; }
    easeLook(dt);
    if (arms) arms.sim.step(dt / 1000);
    paintFace(compose());
    if (arms) paintArms();
    const rate = nextRate();
    setRate(rate);
    if (!rate) armWake();
  }

  function listenInputs(anim) {
    const d = def();
    const wantPointer = anim && (d.tracks || pose.name === 'sleep');
    const wantKey = anim && (d.tracks || pose.name === 'sleep');
    if (wantPointer && !stopPointer) stopPointer = onPointer(onPointerMove);
    if (!wantPointer && stopPointer) { stopPointer(); stopPointer = null; }
    if (wantKey && !stopKey) stopKey = onKey(onKeyDown);
    if (!wantKey && stopKey) { stopKey(); stopKey = null; }
  }

  /** Reconcile subscriptions with the state: frames, inputs, the wake timer. */
  function refresh() {
    if (destroyed) return;
    syncClock();
    const anim = animating();
    listenInputs(anim);
    if (!anim) {
      setRate(0);
      clearWake();
      paintStill();
      return;
    }
    const rate = nextRate();
    setRate(rate);
    if (!rate) {
      paintFace(compose());
      armWake();
    } else clearWake();
  }

  /** Coming back to life (active, on screen, motion allowed): ease out of the still frame. */
  function revive() {
    syncClock();
    if (!animating()) return;
    blendIn();
    if (def().tracks) {
      const p = pointerPosition();
      if (p) aim = p;
    }
    scheduleIdle();
  }

  function onPointerMove(x, y) {
    if (destroyed) return;
    pointerAt = tickerNow();
    if (pose.name === 'sleep') { setPose('idle'); return; }
    if (!def().tracks || !animating()) return;
    glance = null;
    aim = { x, y };
    ensureRate(60);
  }

  function onKeyDown() {
    if (!destroyed && pose.name === 'sleep') setPose('idle');
  }

  // ── Arms (rig.point): measured once per target, stepped on this rig's own frames ──

  function ensureArms() {
    if (arms) return arms;
    const face = svg.querySelector('.syna-face');
    if (!face) return null;
    face.insertAdjacentHTML('afterbegin', '<g class="syna-arms">'
      + ['left', 'right'].map(side => `<g class="syna-arm" data-side="${side}" display="none"><path class="syna-arm-noodle" fill="currentColor" fill-rule="nonzero"/></g>`).join('')
      + '</g>');
    const parts = Array.from(face.firstElementChild.children).map(g => ({ g, noodle: g.firstElementChild, shown: false, d: '', reach: '' }));
    // box / rect: this SVG's and the target's client rects as last read (shift() moves the box without a read).
    arms = { sim: createArmSim(), parts, target: null, gap: ARM_GAP_PX, unitPx: 0, box: null, rect: null, frame: 0, stopWatch: null };
    arms.sim.prop((lastFrame || stillFrameNow())?.prop?.name || null);
    return arms;
  }

  /** Draw what the sim holds: one path per arm (noodle and hand), written only when it changed; `data-reach` is the arm's e. */
  function paintArms() {
    if (!arms) return;
    const frame = arms.sim.frame();
    const unitPx = arms.unitPx || MASCOT_ARM.unitPx;
    frame.forEach((f, side) => {
      const part = arms.parts[side];
      const d = f ? armDrawPath(f, side, { unitPx }) : '';
      if (!d) {
        if (part.shown) { part.g.setAttribute('display', 'none'); part.shown = false; }
        return;
      }
      if (!part.shown) { part.g.removeAttribute('display'); part.shown = true; }
      if (d !== part.d) { part.d = d; part.noodle.setAttribute('d', d); }
      const reach = f.e.toFixed(3);
      if (reach !== part.reach) { part.reach = reach; part.g.setAttribute('data-reach', reach); }
    });
    if (!arms.sim.awake() && !arms.target) stopArmWatch();
  }

  /** A target's client rect: an element (read now), a rect, or a point. */
  function targetBox(target) {
    if (!target) return null;
    if (typeof target.getBoundingClientRect === 'function') {
      if (target.isConnected === false) return null;
      const r = target.getBoundingClientRect();
      return r.width || r.height ? r : null;
    }
    if (Number.isFinite(target.left) && Number.isFinite(target.top)) {
      const w = Number(target.width) || Math.max(0, (Number(target.right) || target.left) - target.left);
      const h = Number(target.height) || Math.max(0, (Number(target.bottom) || target.top) - target.top);
      return { left: target.left, top: target.top, right: target.left + w, bottom: target.top + h, width: w, height: h };
    }
    if (Number.isFinite(target.x) && Number.isFinite(target.y)) return { left: target.x, top: target.y, right: target.x, bottom: target.y, width: 0, height: 0 };
    return null;
  }

  /**
   * Two layout reads (this SVG and the target), never per frame: then aim
   * (aimArms) from what was read.
   */
  function measureArms() {
    if (!arms?.target || destroyed) return;
    const box = svg.getBoundingClientRect();
    const r = targetBox(arms.target);
    if (!box.width || !r) return;
    arms.box = { left: box.left, top: box.top, width: box.width, height: box.height };
    arms.rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    aimArms();
  }

  /**
   * From the last rects, no layout read: where the target is in face units, the
   * arm on its side aims there (its index at the target's middle, its fingertip
   * stopping `gap` px short of it) and the eyes look the same way.
   */
  function aimArms() {
    const box = arms?.box;
    const r = arms?.rect;
    if (!box || !r) return;
    const k = box.width / 280; // CSS px per face unit: the viewBox is 280 wide, the SVG keeps its ratio
    arms.unitPx = k;
    const rect = { left: (r.left - box.left) / k, top: (r.top - box.top) / k, right: (r.right - box.left) / k, bottom: (r.bottom - box.top) / k };
    const side = armSide({ x: (rect.left + rect.right) / 2 });
    const aimAt = armTargeting(side, rect, arms.gap / k, arms.sim.root(side));
    if (!aimAt) return;
    arms.sim.aim(side, aimAt.angle, { target: aimAt.focus, reach: aimAt.reach });
    // The eyes go the same way, through the rig's own gaze.
    const vx = (r.left + r.right) / 2 - (box.left + box.width / 2);
    const vy = (r.top + r.bottom) / 2 - (box.top + box.height / 2);
    const dist = Math.hypot(vx, vy);
    if (dist >= 1) {
      const m = (dist / (dist + AIM_K)) * 1.25;
      lookAt((vx / dist) * m, (vy / dist) * m);
    }
  }

  /** While pointing, a resize or a scroll measures again on the next frame (coalesced). */
  function watchArms() {
    if (!arms || arms.stopWatch || typeof window === 'undefined') return;
    const again = () => {
      if (!arms || arms.frame) return;
      arms.frame = requestAnimationFrame(() => { if (!arms) return; arms.frame = 0; measureArms(); wakeArms(); });
    };
    window.addEventListener('resize', again, { passive: true });
    document.addEventListener('scroll', again, { passive: true, capture: true });
    arms.stopWatch = () => {
      window.removeEventListener('resize', again);
      document.removeEventListener('scroll', again, true);
    };
  }

  function stopArmWatch() {
    if (!arms?.stopWatch) return;
    arms.stopWatch();
    arms.stopWatch = null;
    if (arms.frame) { cancelAnimationFrame(arms.frame); arms.frame = 0; }
  }

  function wakeArms() {
    if (destroyed || !arms) return;
    if (!animating()) {
      const f = lastFrame || stillFrameNow();
      arms.sim.prop(f?.prop?.name || null);
      arms.sim.finish();
      paintArms();
      paintFace(f);
      return;
    }
    syncClock();
    ensureRate(arms.sim.settled() ? 30 : 60);
    requestFrames(BLEND_MS);
  }

  /**
   * Point at `target` (an element, a client rect or a client point) with the
   * arm on its side; null puts the arms away. `gap` (CSS px, default
   * ARM_GAP_PX) is how far short of the target the fingertip stops (a host that
   * rings the target keeps it outside the ring). Pointing again (the same target
   * or a new one) measures again and carries on from the springs' state.
   */
  function point(target, { poke: andPoke = false, gap } = {}) {
    if (destroyed || !armsAllowed) return api;
    if (target == null) {
      if (!arms) return api;
      arms.target = null;
      arms.sim.release();
      wakeArms();
      return api;
    }
    if (!ensureArms()) return api;
    if (gap != null || target !== arms.target) arms.gap = Number(gap) >= 0 ? Number(gap) : ARM_GAP_PX;
    arms.target = target;
    measureArms();
    watchArms();
    if (andPoke) arms.sim.poke();
    wakeArms();
    return api;
  }

  // ── Public API ──

  function setPose(name, options2) {
    if (destroyed) return api;
    const next = POSES[name] ? name : 'idle';
    const raw = options2 && typeof options2 === 'object' ? { ...options2 } : {};
    const same = next === pose.name;
    const keys = new Set([...Object.keys(raw), ...Object.keys(pose.raw)]);
    const changed = [...keys].filter(k => raw[k] !== pose.raw[k]);
    if (same && !changed.length) return api;
    syncClock();
    if (same && changed.every(k => k === 'count' || k === 'ticks')) {
      // Same pose, new numbers: the loop keeps its phase; a new mini pops in.
      const before = intIn(pose.raw.count, 1, 3, 1);
      const after = intIn(raw.count, 1, 3, 1);
      for (let i = before; i < after; i += 1) miniBorn[i] = clock;
      if (raw.ticks != null) ticks = intIn(raw.ticks, 0, 3, ticks);
      pose.raw = raw;
    } else {
      pose = { name: next, raw, start: clock, then: raw.then && POSES[raw.then] ? raw.then : null };
      svg.setAttribute('data-pose', next);
      settled = false;
      miniBorn = [];
      ticks = intIn(raw.ticks, 0, 3, 1);
      glance = null;
      blendIn();
      if (def().tracks) {
        const p = pointerPosition();
        if (p && tickerNow() - p.at < 2500) aim = p;
      }
      scheduleIdle();
    }
    if (animating()) requestFrames(BLEND_MS);
    refresh();
    return api;
  }

  function react(name) {
    if (destroyed || !Object.hasOwn(REACTIONS, name)) return api;
    // pop on the plan ticks the next box, unless the host counts the ticks itself (opts.ticks).
    if (name === 'pop' && pose.name === 'plan' && pose.raw.ticks == null) ticks = ticks >= 3 ? 1 : ticks + 1;
    if (!animating()) { paintStill(); return api; }
    startReaction(name);
    return api;
  }

  /** Point the eyes ([-1, 1] both axes); in idle a cursor that moved in the last 2.5 s wins. */
  function lookAt(x, y) {
    hostLook = { x: unit(x), y: unit(y) };
    if (destroyed) return;
    const d = def();
    if (d.tracks) {
      if (!animating() || tickerNow() - pointerAt < 2500) return;
      track = { ...hostLook };
      glance = null;
    } else if (!d.look) return;
    if (!animating()) { paintStill(); return; }
    syncClock();
    ensureRate(60);
  }

  function blink() {
    if (destroyed || !animating()) return;
    startBlink();
  }

  function setActive(on) {
    const next = !!on;
    if (destroyed || next === active) return api;
    active = next;
    if (active) revive();
    refresh();
    return api;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    setRate(0);
    clearWake();
    stopPointer?.();
    stopPointer = null;
    stopKey?.();
    stopKey = null;
    unobserve(svg);
    stopArmWatch();
    svg.removeEventListener('animationend', onAnimationEnd);
    clearTempClasses();
    reactions.length = 0;
    unregister(rig);
  }

  const rig = {
    visibilityChanged(inView) {
      if (destroyed) return;
      if (svg.isConnected) seenConnected = true;
      else if (seenConnected) { destroy(); return; }
      const was = visible;
      visible = inView;
      if (visible && !was) revive();
      refresh(); // also wakes a rig that was built before it was attached
    },
    motionChanged() {
      if (destroyed) return;
      if (animating()) revive();
      refresh();
    },
  };

  const api = {
    el: svg,
    destroy,
    look: lookAt,
    blink,
    setPose,
    react,
    setActive,
    point,
    /** Two quick pokes toward what the arm points at (the beat landed). */
    poke() {
      if (destroyed || !arms?.target) return api;
      arms.sim.poke();
      wakeArms();
      return api;
    },
    /**
     * The body was jolted: its velocity changed by (vx, vy) CSS px/s (a host
     * moving the character's box: + on take-off, − on landing). The arms keep
     * part of their old speed, so they trail and then wobble back.
     */
    nudge(vx, vy) {
      if (destroyed || !arms?.unitPx || !animating()) return api;
      arms.sim.nudge((Number(vx) || 0) / arms.unitPx, (Number(vy) || 0) / arms.unitPx);
      wakeArms();
      return api;
    },
    /**
     * The host moved the character's box by (dx, dy) CSS px since the last
     * measure (its own transform: no layout read here): the hand keeps
     * pointing at the same place on the page.
     */
    shift(dx, dy) {
      if (destroyed || !arms?.target || !arms.box) return api;
      const x = Number(dx) || 0;
      const y = Number(dy) || 0;
      if (!x && !y) return api;
      arms.box.left += x;
      arms.box.top += y;
      aimArms();
      wakeArms();
      return api;
    },
    /** The client box the pointing arm takes once grown (from the last measure: no layout read), or null. */
    armExtent() {
      if (destroyed || !arms?.target || !arms.box) return null;
      const e = arms.sim.extent();
      if (!e) return null;
      const k = arms.box.width / 280;
      return { left: arms.box.left + e.left * k, top: arms.box.top + e.top * k, right: arms.box.left + e.right * k, bottom: arms.box.top + e.bottom * k };
    },
    /** Read the rects again (the host's move has landed, its scale settled) and aim from them. */
    remeasure() {
      if (destroyed || !arms?.target) return api;
      measureArms();
      wakeArms();
      return api;
    },
    /** What the arms point at (null when they are away). */
    get pointing() { return arms?.target || null; },
    /** The current pose name. */
    get pose() { return pose.name; },
    /** The frame rate this rig asks of the ticker right now (0 = still). */
    get fps() { return fps; },
  };

  pose = { name: POSES[firstPose] ? firstPose : 'idle', raw: firstOptions && typeof firstOptions === 'object' ? { ...firstOptions } : {}, start: 0, then: null };
  pose.then = pose.raw.then && POSES[pose.raw.then] ? pose.raw.then : null;
  svg.setAttribute('data-pose', pose.name);
  ticks = intIn(pose.raw.ticks, 0, 3, 1);
  register(rig);
  svg.addEventListener('animationend', onAnimationEnd);
  lastFrame = stillFrameNow();
  painter.paint(lastFrame);
  observe(svg, rig);
  if (animating()) {
    scheduleIdle();
    if (def().tracks) {
      const p = pointerPosition();
      if (p) aim = p;
    }
  }
  refresh();
  return api;
}

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
// pointermove listener and one IntersectionObserver serve every rig, and only
// one rig at a time plays a pose loop (the one posed most recently); the
// others hold their pose's still frame. Under prefers-reduced-motion every
// pose is its still frame and changes are instant. A rig tears itself down
// once its SVG leaves the document.
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
 *   a new count or ticks keeps its loop running.
 * - `react(name)` — `MASCOT_REACTIONS`: hop (spring, at most one per 600 ms),
 *   wince, nod, pop (plan: pops the newest tick; ticks the next box too
 *   unless setPose passed `ticks`), startle, pulse, click
 *   (computer: a ripple). While one plays the SVG carries `syna-react-<name>`,
 *   removed when it ends and on `animationend`.
 * - `look(x, y)` — gaze in [-1, 1] on both axes. Idle: a cursor that moved in
 *   the last 2.5 s wins. watch / computer / runs / wait / blocked follow it.
 * - `blink()` — one blink.
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
export const MASCOT_POSES = Object.freeze([...MASCOT_KINDS, ...MASCOT_STATES]);
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
 * motion: 'loop' (30 fps while it leads), 'blink' (still between slow blinks),
 * 'once' (plays `settle` ms, then still; `hold` before opts.then), 'still'.
 * blinks: random blinks every 3-7 s. tracks: follows the cursor.
 * look: follows look(), easing with this time constant (ms).
 */
const POSES = {
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
  mcp: { // a two-prong plug on its cord
    markup: () => '<path d="M41,106 C41,120 30,122 22,134" fill="none" stroke="currentColor" stroke-opacity=".4" stroke-width="3" stroke-linecap="round"/>'
      + '<g class="syna-plug" fill="currentColor" fill-opacity=".65"><rect x="30" y="86" width="22" height="20" rx="7"/><rect x="34" y="74" width="4.5" height="14" rx="2.25"/><rect x="43.5" y="74" width="4.5" height="14" rx="2.25"/></g>',
    refs: g => ({ plug: g.querySelector('.syna-plug') }),
    update(r, p, put) {
      put(r.plug, 'transform', p.nudge ? `translate(${n(2 * p.nudge)},${n(-1.5 * p.nudge)})` : null);
    },
  },
};

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

// ── Shared runtime: one observer, one motion listener, one lead ──

const rigs = new Set();
let leadRig = null;
let promoteSeq = 0;
let stopMotionWatch = null;
let io = null;
const ioRigs = new WeakMap();

/** Only one rig plays a pose loop: the most recently posed one that wants to. */
function elect() {
  let best = null;
  for (const rig of rigs) if (rig.wantsLead() && (!best || rig.promotedAt() > best.promotedAt())) best = rig;
  if (best === leadRig) return;
  const prev = leadRig;
  leadRig = best;
  prev?.leadChanged();
  best?.leadChanged();
}

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
    elect();
  });
}

function unregister(rig) {
  rigs.delete(rig);
  if (leadRig === rig) { leadRig = null; elect(); }
  if (!rigs.size && stopMotionWatch) { stopMotionWatch(); stopMotionWatch = null; }
}

const BLEND_MS = 160;
const AIM_K = 140; // px: the cursor distance at which the eyes travel half way
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
    pose: firstPose = 'idle', poseOptions: firstOptions, active: startActive,
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
  let promotedAt = (promoteSeq += 1);
  let clock = 0; // rig time in ms: the ticker's dt while drawing, real time while still
  let frozenAt = tickerNow(); // while not drawing: when the clock was last brought up to date; -1 while drawing
  let pose = { name: 'idle', raw: {}, start: 0, then: null };
  let settled = false; // a one-shot's opts.then has fired
  let blend = null; // { from, start, dur }
  let lastFrame = null; // the last frame before blinks and reactions
  let drawn = false; // has drawn a live frame (a never-drawn rig has nothing to blend from)
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

  const def = () => POSES[pose.name];
  const animating = () => !destroyed && active && visible && !isReducedMotion();
  const isLead = () => leadRig === rig;
  const poseTime = () => clock - pose.start;

  function wantsLead() {
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
    if (!isLead()) return 0;
    const d = def();
    const t = poseTime();
    if (d.motion === 'loop') return 30;
    if (d.motion === 'blink') return d.idleFor(t) > 0 ? 0 : 30;
    if (d.motion === 'once') return t < d.settle ? 60 : 0;
    return 0;
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
    if (d.blinks && (d.motion === 'still' || isLead())) at = Math.min(at, nextBlinkAt);
    if (d.tracks) at = Math.min(at, nextGlanceAt, nextFidgetAt, glance ? glance.until : Infinity);
    if (d.motion === 'blink' && isLead()) at = Math.min(at, at0 + d.idleFor(poseTime()));
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
    if (d.blinks && (d.motion === 'still' || isLead()) && t >= nextBlinkAt) {
      nextBlinkAt = t + rand(3000, 7000);
      startBlink();
    }
    if (d.tracks) {
      if (glance && t >= glance.until) glance = null;
      if (t >= nextGlanceAt) {
        // Only while the cursor is still and no other rig is busy.
        if (t - pointerAt < 2500 || leadRig) nextGlanceAt = t + 3000;
        else {
          const [x, y] = GLANCES[Math.floor(Math.random() * GLANCES.length)];
          glance = { x, y, until: t + rand(700, 1000) };
          nextGlanceAt = t + rand(9000, 15000);
        }
      }
      if (t >= nextFidgetAt) {
        const quietFor = t - Math.max(lastInputAt(), pointerAt);
        if (quietFor < 20000) nextFidgetAt = t + (20000 - quietFor) + rand(0, 5000);
        else if (leadRig) nextFidgetAt = t + 10000;
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
    const loopOn = isLead() && def().motion !== 'still';
    return poseFrame(pose.name, poseTime(), { ...pose.raw, look, range, ticks, still: !loopOn });
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
    painter.paint(lastFrame);
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
    const wasLead = isLead();
    painter.paint(compose());
    drawn = true;
    if (wasLead && def().motion === 'once' && poseTime() >= def().settle) elect();
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
      painter.paint(compose());
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
    promotedAt = (promoteSeq += 1);
    if (animating()) requestFrames(BLEND_MS);
    elect();
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
    if (active) { promotedAt = (promoteSeq += 1); revive(); }
    elect();
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
    svg.removeEventListener('animationend', onAnimationEnd);
    clearTempClasses();
    reactions.length = 0;
    unregister(rig);
  }

  const rig = {
    promotedAt: () => promotedAt,
    wantsLead,
    leadChanged() {
      if (destroyed) return;
      // Gaining or losing the loop swaps the still frame for the live one: blend
      // when they differ (a patient pose between blinks, a settled one-shot: no).
      if (drawn && animating()) {
        syncClock();
        blendIn();
      }
      refresh();
    },
    visibilityChanged(inView) {
      if (destroyed) return;
      if (svg.isConnected) seenConnected = true;
      else if (seenConnected) { destroy(); return; }
      const was = visible;
      visible = inView;
      if (visible && !was) revive();
      elect();
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
  elect();
  refresh();
  return api;
}

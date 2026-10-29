// The mascot as the tour's narrator: the empty state's real rig, in its real
// box, moved by transform only. Travel is physical: the box springs toward its
// place (a hop arc, a small crouch on take-off, a stretch and a lean in flight,
// a landing with a hint of give), so a new place in mid-flight carries on from
// where it is, at the speed it has. Every frame the body's change of velocity
// goes to the rig's arms (rig.nudge): they trail on take-off and wobble on
// arrival; its change of place goes to rig.shift, so a hand keeps pointing at
// the same control while the body flies, and the rig measures again once the
// body is still. Pointing is the rig's own (rig.point: arms + gaze). The
// mascot's keep-out (what it can draw: mascotBounds, plus a margin) is handed
// to `onMove` every frame it moves, for the ink layers' hole. Frames come from
// the shared ticker (the rig's own loop), only while the body moves; rects
// are read once per move, never per frame. Under reduced motion the box is
// placed, never flown.
import { subscribe } from '../synabun-ticker.js';
import { mascotBounds } from '../synabun-mascot.js';
import { springStep } from './tour-ink.js';

const MOVE = [12, 0.74]; // ω (rad/s), ζ: ≈ 3 % overshoot, the --asst-ease-spring landing
const ARC = [13, 0.62]; // the hop's rise and fall
const CROUCH = [26, 0.45]; // the take-off squash, rubbery
const SCALE = [14, 0.72];
const ARRIVED = { px: 4, speed: 140 }; // close and slow enough for the beat to go on (the spring finishes on its own)
const KEEP_OUT_MARGIN = 6; // px of clear board round what the mascot draws

export function createActor(target, { reduced = () => false, onMove = null } = {}) {
  const rig = target.rig;
  const svg = target.el;
  const box = svg?.parentElement || null; // .asst-empty-mascot: the svg is centred in it, so scale and lean pivot on the face
  const s = { x: 0, y: 0, vx: 0, vy: 0, arc: 0, varc: 0, q: 0, vq: 0, k: 1, vk: 0 };
  const goal = { x: 0, y: 0, k: 1 };
  let stop = null;
  let waiters = [];
  let lastV = { x: 0, y: 0 };
  let lastAt = { x: 0, y: 0 }; // where the body was on the last frame (for rig.shift)
  let place = null; // the last place asked for (a client point or null = home), for a replay after a resize
  let base = null; // { cx, cy, w, h }: the face's centre and size with no transform (one read per move)
  let lastPose = { name: 'idle', opts: undefined };

  const present = () => !!(box && svg?.isConnected && box.offsetWidth > 0);

  /**
   * The untransformed face: its client centre (one read) and its own size (the SVG's attributes). When the
   * layout under it moved (the board made room, the panel changed), the body keeps its place on screen:
   * the offset and the goal take the shift, so nothing jumps.
   */
  function readBase() {
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    const w = Number(svg.getAttribute('width')) || r.width / (s.k || 1);
    const h = Number(svg.getAttribute('height')) || r.height / (s.k || 1);
    // Where the box would be with no transform: its client centre less the offset we set (scale and lean pivot on it).
    const at = { cx: r.left + r.width / 2 - s.x, cy: r.top + r.height / 2 - (s.y + s.arc) };
    const prev = base;
    base = { cx: at.cx, cy: at.cy, w, h };
    if (prev && box?.style.transform && (Math.abs(prev.cx - at.cx) > 0.5 || Math.abs(prev.cy - at.cy) > 0.5)) {
      // The layout moved under a transform we set: hold the body where it is on screen, and its goal too.
      const dx = prev.cx - at.cx;
      const dy = prev.cy - at.cy;
      s.x += dx;
      s.y += dy;
      goal.x += dx;
      goal.y += dy;
      lastAt = { x: lastAt.x + dx, y: lastAt.y + dy };
      write();
    }
    return base;
  }

  /** The face-unit box the pose draws in, as a client rect for the face at (x, y) offset and scale k, plus `margin`. */
  function boundsAt(x, y, k, margin = KEEP_OUT_MARGIN) {
    if (!base) return null;
    const b = mascotBounds(lastPose.name, lastPose.opts);
    const u = (base.w / 280) * k; // CSS px per face unit
    const left = base.cx + x - (base.w * k) / 2;
    const top = base.cy + y - (base.h * k) / 2;
    const rect = { left: left + b.left * u - margin, top: top + b.top * u - margin, right: left + b.right * u + margin, bottom: top + b.bottom * u + margin };
    rect.width = rect.right - rect.left;
    rect.height = rect.bottom - rect.top;
    return rect;
  }

  const tellMove = () => { if (onMove && base) try { onMove(boundsAt(s.x, s.y + s.arc, s.k)); } catch { /* the host's */ } };

  function write() {
    if (!box) return;
    const speed = Math.hypot(s.vx, s.vy + s.varc);
    const stretch = Math.min(0.04, speed / 9000);
    const lean = Math.max(-7, Math.min(7, s.vx * 0.011));
    const sx = s.k * (1 + s.q) * (1 - stretch);
    const sy = s.k * (1 - s.q) * (1 + stretch);
    const still = Math.abs(s.x) < 0.05 && Math.abs(s.y + s.arc) < 0.05 && Math.abs(sx - 1) < 1e-3 && Math.abs(sy - 1) < 1e-3 && Math.abs(lean) < 0.05;
    box.style.transform = still ? '' : `translate(${s.x.toFixed(2)}px, ${(s.y + s.arc).toFixed(2)}px) rotate(${lean.toFixed(2)}deg) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
    tellMove();
  }

  /** Where the face's centre sits with no transform (one read per move). */
  function layoutCentre() {
    const r = svg.getBoundingClientRect();
    return { x: r.left + r.width / 2 - s.x, y: r.top + r.height / 2 - (s.y + s.arc) };
  }

  const near = () => Math.hypot(goal.x - s.x, goal.y - s.y) < ARRIVED.px && Math.hypot(s.vx, s.vy) < ARRIVED.speed && Math.abs(s.arc) < ARRIVED.px;
  const still = () => Math.hypot(goal.x - s.x, goal.y - s.y) < 0.2 && Math.hypot(s.vx, s.vy) < 2 && Math.abs(s.arc) < 0.2 && Math.abs(s.varc) < 2
    && Math.abs(s.q) < 0.001 && Math.abs(s.vq) < 0.01 && Math.abs(s.k - goal.k) < 0.001 && Math.abs(s.vk) < 0.01;

  function release(all = false) {
    const keep = [];
    for (const w of waiters) { if (all || w.when()) w.resolve(); else keep.push(w); }
    waiters = keep;
  }

  function onFrame(_now, dtMs) {
    const dt = dtMs / 1000;
    if (!svg?.isConnected) { halt(); return; } // no layout read per frame: present() is asked once per move
    let r = springStep(s.x, s.vx, goal.x, MOVE[0], MOVE[1], dt); s.x = r.x; s.vx = r.v;
    r = springStep(s.y, s.vy, goal.y, MOVE[0], MOVE[1], dt); s.y = r.x; s.vy = r.v;
    r = springStep(s.arc, s.varc, 0, ARC[0], ARC[1], dt); s.arc = r.x; s.varc = r.v;
    r = springStep(s.q, s.vq, 0, CROUCH[0], CROUCH[1], dt); s.q = r.x; s.vq = r.v;
    r = springStep(s.k, s.vk, goal.k, SCALE[0], SCALE[1], dt); s.k = r.x; s.vk = r.v;
    write();
    // The body's change of velocity this frame: the arms keep their old speed and trail.
    const v = { x: s.vx, y: s.vy + s.varc };
    const dvx = v.x - lastV.x;
    const dvy = v.y - lastV.y;
    lastV = v;
    if (Math.abs(dvx) + Math.abs(dvy) > 1) try { rig.nudge?.(dvx, dvy); } catch { /* an older rig */ }
    // The body moved: a hand that points keeps pointing at the same control (no layout read).
    const at = { x: s.x, y: s.y + s.arc };
    if (rig.pointing) try { rig.shift?.(at.x - lastAt.x, at.y - lastAt.y); } catch { /* an older rig */ }
    lastAt = at;
    release();
    if (still()) {
      Object.assign(s, { x: goal.x, y: goal.y, vx: 0, vy: 0, arc: 0, varc: 0, q: 0, vq: 0, k: goal.k, vk: 0 });
      write();
      halt();
      if (rig.pointing) try { rig.remeasure?.(); } catch { /* an older rig */ } // landed, scale settled: read the rects once more
    }
  }

  function halt() {
    stop?.();
    stop = null;
    lastV = { x: 0, y: 0 };
    release(true);
  }

  /**
   * Fly to `point` (client px; null = home) at `scale`. Resolves once it has
   * arrived closely enough for the next op (the landing finishes on its own),
   * at once under reduced motion or when there is no character on screen.
   */
  function travel(point, { scale = 1 } = {}) {
    place = { point: point ? { ...point } : null, scale };
    if (!present()) return Promise.resolve();
    const c = readBase() ? { x: base.cx, y: base.cy } : layoutCentre();
    const to = { x: point ? point.x - c.x : 0, y: point ? point.y - c.y : 0, k: scale };
    const dist = Math.hypot(to.x - s.x, to.y - s.y);
    Object.assign(goal, to);
    if (reduced()) {
      halt();
      Object.assign(s, { x: to.x, y: to.y, vx: 0, vy: 0, arc: 0, varc: 0, q: 0, vq: 0, k: to.k, vk: 0 });
      write();
      lastAt = { x: s.x, y: s.y };
      if (rig.pointing) try { rig.remeasure?.(); } catch { /* an older rig */ }
      return Promise.resolve();
    }
    if (dist > 6) {
      // Take-off: a small crouch and a hop, both scaled to the distance (a short move barely hops).
      s.vq += Math.min(2.6, 0.9 + dist / 160);
      s.varc -= Math.min(260, 40 + dist * 1.2);
    }
    if (!stop) { lastV = { x: s.vx, y: s.vy + s.varc }; lastAt = { x: s.x, y: s.y + s.arc }; stop = subscribe(onFrame, { fps: 60 }); }
    return new Promise((resolve) => { waiters.push({ resolve, when: near }); });
  }

  /** The panel was resized: fly to the same place again (its client point is the caller's to recompute). */
  function replay(point) {
    if (!place) return Promise.resolve();
    return travel(point === undefined ? place.point : point, { scale: place.scale });
  }

  /**
   * What the mascot draws (mascotBounds for its pose: the eyes over their
   * travel, the smile, its prop), where it lands, as a client rect plus
   * `margin` px: the board keeps its ink out of it.
   */
  function keepOut(margin = KEEP_OUT_MARGIN) {
    if (!svg) return null;
    if (!base) readBase();
    return boundsAt(goal.x, goal.y, goal.k, margin);
  }

  /** keepOut() for the face landed at client point `point` (its centre) at `scale`: for choosing a place. */
  function keepOutAt(point, scale = 1, margin = KEEP_OUT_MARGIN) {
    if (!svg) return null;
    if (!base) readBase();
    if (!base) return null;
    return boundsAt(point ? point.x - base.cx : 0, point ? point.y - base.cy : 0, scale, margin);
  }

  /** The face's client rect where it will land (its goal), for ink placed beside it. */
  function rect() {
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    const k = goal.k / (s.k || 1);
    const cx = r.left + r.width / 2 + (goal.x - s.x);
    const cy = r.top + r.height / 2 + (goal.y - (s.y + s.arc));
    const w = r.width * k;
    const h = r.height * k;
    return { left: cx - w / 2, top: cy - h / 2, right: cx + w / 2, bottom: cy + h / 2, width: w, height: h };
  }

  /**
   * A point on the landed face's visible edge (the eyes and the smile, not the SVG's box:
   * the eyes span 29-71 % of its width, 17-86 % of its height): 'top' | 'bottom' | 'left' | 'right' | 'center'.
   */
  function edge(side = 'center') {
    const r = rect();
    if (!r) return null;
    const c = { x: r.left + r.width / 2, y: r.top + r.height * 0.5 };
    if (side === 'top') return { x: c.x, y: r.top + r.height * 0.14 };
    if (side === 'bottom') return { x: c.x, y: r.top + r.height * 0.9 };
    if (side === 'left') return { x: r.left + r.width * 0.26, y: c.y };
    if (side === 'right') return { x: r.left + r.width * 0.74, y: c.y };
    return c;
  }

  return {
    rig,
    box,
    present,
    travel,
    replay,
    rect,
    edge,
    keepOut,
    keepOutAt,
    /** Read the untransformed face again (the panel was resized or scrolled). */
    measure() { readBase(); tellMove(); },
    pose(name, opts) { lastPose = { name, opts }; try { rig.setPose(name, opts); } catch { /* gone */ } tellMove(); },
    react(name) { if (!reduced()) try { rig.react(name); } catch { /* gone */ } },
    /** Point with the arms and the eyes (null: put them away); opts: { poke, gap } (rig.point). */
    point(targetEl, opts) { try { rig.point?.(targetEl, opts); } catch { /* an older rig */ } },
    poke() { if (!reduced()) try { rig.poke?.(); } catch { /* an older rig */ } },
    /** Look toward a client point without pointing. */
    look(point) {
      const r = rect();
      if (!r || !point) return;
      const vx = point.x - (r.left + r.width / 2);
      const vy = point.y - (r.top + r.height / 2);
      const d = Math.hypot(vx, vy);
      if (d < 1) { rig.look(0, 0); return; }
      const m = (d / (d + 140)) * 1.25;
      rig.look(Math.max(-1, Math.min(1, (vx / d) * m)), Math.max(-1, Math.min(1, (vy / d) * m)));
    },
    get lastPose() { return lastPose; },
    /** Back to rest at once: no transform, nothing pending. */
    reset() {
      halt();
      Object.assign(s, { x: 0, y: 0, vx: 0, vy: 0, arc: 0, varc: 0, q: 0, vq: 0, k: 1, vk: 0 });
      Object.assign(goal, { x: 0, y: 0, k: 1 });
      if (box) box.style.transform = '';
      place = null;
    },
    get moving() { return !!stop; },
  };
}

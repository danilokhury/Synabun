// The Workspace tour's board: hand-drawn ink on an SVG layer. One layer sits
// over the Assistant panel's root (the transcript is the whiteboard), a second,
// fixed one covers the page for the highlight ring, which rings controls in the
// panel, its header and the title bar alike. Shapes come from tour-ink.js
// (smooth closed and open curves, a slow seeded wander, no hard corner) and are
// revealed pen-first with stroke-dashoffset through WAAPI on the Assistant's
// eased curves; handwriting (Caveat) is wiped in with a clip-path, or rises in
// where the engine cannot animate a clip-path on SVG text (checked once).
// Erasing un-draws the newest stroke first. The highlight is ONE ring that
// springs from control to control: its shape (centre, size, pads, corners) is
// sprung on the shared ticker (the mascot's loop) and the ring (softRingPath:
// a few anchors, exact sides and corners) is made from it each frame, so it
// morphs without a jitter; it is drawn on with a
// WAAPI stroke reveal and fades in place when no control is meant. Both layers
// keep a hole where the mascot is (setKeepOut): ink never paints over it. Under
// reduced motion everything is placed finished. Only SVG path data, transform,
// opacity and the keep-out's rect ever change.
import { subscribe } from '../synabun-ticker.js';
import { arrowGeometry, closedSmoothPath, ellipsePoints, pointsToSmoothPath, softBoxPath, softRingPath, springStep, underlinePoints } from './tour-ink.js';

const NS = 'http://www.w3.org/2000/svg';
export const EASE = {
  draw: 'cubic-bezier(.2,0,.38,.9)', // --asst-ease-standard: a pen that starts and settles
  enter: 'cubic-bezier(0,0,.38,.9)', // --asst-ease-enter
  exit: 'cubic-bezier(.2,0,1,.9)', // --asst-ease-exit
  emphasized: 'cubic-bezier(.4,.14,.3,1)', // --asst-ease-emphasized
  spring: 'linear(0, 0.35 9%, 0.78 21%, 1.03 40%, 0.99 60%, 1)', // --asst-ease-spring
};
export const INK = { stroke: 380, label: 340, ring: 460, arrow: 360, erase: 220, stagger: 30 };

let clipSupport = null;
/** Can this engine animate a clip-path on SVG text? (Chromium yes; WebKit has not.) Checked once. */
function clipAnimates(svg) {
  if (clipSupport != null) return clipSupport;
  clipSupport = false;
  try {
    const probe = document.createElementNS(NS, 'text');
    probe.textContent = 'x';
    svg.appendChild(probe);
    const anim = probe.animate([{ clipPath: 'inset(0px 100% 0px 0px)' }, { clipPath: 'inset(0px 0% 0px 0px)' }], { duration: 1000, fill: 'both' });
    anim.pause();
    anim.currentTime = 500;
    const value = getComputedStyle(probe).clipPath || '';
    clipSupport = /inset\(/.test(value) && /50%/.test(value);
    anim.cancel();
    probe.remove();
  } catch { clipSupport = false; }
  return clipSupport;
}

let maskSeq = 0;
const FAR = 100000; // the mask's extent: the whole layer, whatever it holds

export function createStage(host, { fixed = false, reduced = () => false, className = '' } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', `${fixed ? 'tour-page' : 'tour-board'}${className ? ` ${className}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  // Every stroke goes in one group; while the mascot is on the board the group is masked with a hole
  // where the mascot is (setKeepOut), so nothing on this layer ever paints over it.
  const maskId = `tour-keepout-${(maskSeq += 1)}`;
  svg.innerHTML = `<defs><mask id="${maskId}" maskUnits="userSpaceOnUse" x="${-FAR}" y="${-FAR}" width="${2 * FAR}" height="${2 * FAR}">`
    + `<rect x="${-FAR}" y="${-FAR}" width="${2 * FAR}" height="${2 * FAR}" fill="#fff"/><rect class="tour-keepout" fill="#000" x="0" y="0" width="0" height="0"/></mask></defs>`
    + '<g class="tour-inkset"></g>';
  const ink = svg.lastChild;
  const hole = svg.querySelector('.tour-keepout');
  host.appendChild(svg);
  const live = new Set(); // { el, kind, anim }
  let seq = 0;
  // Client → layer coordinates: the board's origin is read once per shape (the panel may still be sliding in
  // when the tour opens), never per frame; the keep-out, which moves every frame of a flight, uses the last read.
  let at = null;
  const measure = () => { at = fixed ? { left: 0, top: 0 } : host.getBoundingClientRect(); return at; };
  const origin = () => measure();
  const local = (p, o = origin()) => ({ x: p.x - o.left, y: p.y - o.top });
  const localPts = (pts, o = origin()) => pts.map(([x, y]) => [x - o.left, y - o.top]);
  let keepOut = null;

  /**
   * The mascot's box (a client rect, or null when it is not on the board): a
   * hole in this layer, so no ink paints over it. Cheap enough for every frame
   * of a flight: four attributes, no layout read.
   */
  function setKeepOut(rect) {
    const o = at || measure();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
      if (keepOut) { ink.removeAttribute('mask'); keepOut = null; }
      return;
    }
    const x = rect.left - o.left;
    const y = rect.top - o.top;
    const r = Math.min(16, rect.width / 2, rect.height / 2);
    const next = `${x.toFixed(1)} ${y.toFixed(1)} ${rect.width.toFixed(1)} ${rect.height.toFixed(1)}`;
    if (keepOut === next) return;
    hole.setAttribute('x', x.toFixed(1));
    hole.setAttribute('y', y.toFixed(1));
    hole.setAttribute('width', rect.width.toFixed(1));
    hole.setAttribute('height', rect.height.toFixed(1));
    hole.setAttribute('rx', r.toFixed(1));
    if (!keepOut) ink.setAttribute('mask', `url(#${maskId})`);
    keepOut = next;
  }

  function pathEl(d, cls) {
    const el = document.createElementNS(NS, 'path');
    el.setAttribute('class', `tour-ink ${cls}`);
    el.setAttribute('d', d);
    el.setAttribute('pathLength', '1');
    ink.appendChild(el);
    return el;
  }

  /** Reveal a path pen-first (pathLength 1: the dash is the whole stroke). Resolves when drawn. */
  function reveal(el, duration = INK.stroke, delay = 0) {
    const handle = { el, kind: 'path', anim: null };
    live.add(handle);
    el.style.strokeDasharray = '1 1';
    if (reduced() || duration <= 0) { el.style.strokeDashoffset = '0'; return Promise.resolve(handle); }
    el.style.strokeDashoffset = '1';
    const anim = el.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration, delay, easing: EASE.draw, fill: 'forwards' });
    handle.anim = anim;
    return anim.finished.then(() => { el.style.strokeDashoffset = '0'; anim.cancel(); handle.anim = null; return handle; }).catch(() => handle);
  }

  /** A smooth stroke through client points. */
  function stroke(points, { cls = 'ink', duration = INK.stroke, delay = 0, closed = false } = {}) {
    const pts = localPts(points.map(p => (Array.isArray(p) ? p : [p.x, p.y])));
    return reveal(pathEl(closed ? closedSmoothPath(pts) : pointsToSmoothPath(pts), cls), duration, delay);
  }

  /** A client rect in this layer's coordinates. */
  const localRect = (r, o = origin()) => ({ left: r.left - o.left, top: r.top - o.top, width: r.width, height: r.height });

  /** Path data already in this layer's coordinates, revealed pen-first. */
  function path(d, { cls = 'ink', duration = INK.stroke, delay = 0 } = {}) {
    return reveal(pathEl(d, cls), duration, delay);
  }

  /** A rounded hand-drawn box around a client rect (tour-ink.js softBoxPath: exact sides and corners). */
  function box(rect, { pad = 0, radius = 10, seed = `b${seq++}`, cls = 'ink', duration = INK.stroke, delay = 0 } = {}) {
    return path(softBoxPath(localRect(rect), { pad, radius, seed }).d, { cls, duration, delay });
  }

  /** A soft ring around a client rect (one-off ink; the travelling highlight is createHighlight). */
  function ring(rect, { pad = 6, seed = `r${seq++}`, cls = 'gold', duration = INK.ring, delay = 0 } = {}) {
    return path(softRingPath(localRect(rect), { pad, seed }).d, { cls, duration, delay });
  }

  /** A bowed arrow between client points; the head (one stroke: wing, tip, wing) is drawn after the shaft. */
  async function arrow(from, to, { curve = 0.16, seed = `a${seq++}`, cls = 'gold', duration = INK.arrow, delay = 0, head = 7 } = {}) {
    const g = arrowGeometry(from, to, { curve, seed, head });
    await stroke(g.shaft, { cls, duration, delay });
    const [a, tip, b] = localPts(g.head);
    const r2 = v => Math.round(v * 100) / 100;
    return reveal(pathEl(`M ${r2(a[0])} ${r2(a[1])} L ${r2(tip[0])} ${r2(tip[1])} L ${r2(b[0])} ${r2(b[1])}`, `${cls} tour-head`), 150);
  }

  /**
   * Handwriting (Caveat) at a client point, written left to right. With
   * `place(size)` the writing is measured first (size: { w, top, bottom }, px
   * from its baseline) and goes where place() says ({ x, y, anchor }, client
   * px), before a stroke of it is shown.
   */
  function label(text, at, { cls = '', anchor = 'start', duration = INK.label, delay = 0, place = null } = {}) {
    const el = document.createElementNS(NS, 'text');
    el.setAttribute('class', `tour-hand ${cls}`.trim());
    const put = (p, a) => {
      const q = local(p);
      el.setAttribute('x', String(Math.round(q.x * 10) / 10));
      el.setAttribute('y', String(Math.round(q.y * 10) / 10));
      el.setAttribute('text-anchor', a);
    };
    put(at, anchor);
    el.textContent = text;
    ink.appendChild(el);
    if (typeof place === 'function') {
      try {
        el.setAttribute('text-anchor', 'start');
        const bb = el.getBBox();
        const y0 = Number(el.getAttribute('y')) || 0;
        const spot = place({ w: bb.width, top: bb.y - y0, bottom: bb.y + bb.height - y0 });
        if (spot) put(spot, spot.anchor || anchor);
        else el.setAttribute('text-anchor', anchor);
      } catch { el.setAttribute('text-anchor', anchor); }
    }
    const handle = { el, kind: 'text', anim: null };
    live.add(handle);
    if (reduced() || duration <= 0) return Promise.resolve(handle);
    let width = 60;
    try { width = Math.max(1, el.getBBox().width); } catch { /* not laid out */ }
    const ms = Math.max(duration, Math.min(900, width * 4)); // about 4 ms a px: a pen, not a wipe
    const anim = clipAnimates(svg)
      ? el.animate([{ clipPath: 'inset(-30% 100% -30% -6%)' }, { clipPath: 'inset(-30% -6% -30% -6%)' }], { duration: ms, delay, easing: EASE.draw, fill: 'both' })
      : el.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: Math.min(ms, 420), delay, easing: EASE.enter, fill: 'both' });
    handle.anim = anim;
    return anim.finished.then(() => { anim.cancel(); handle.anim = null; return handle; }).catch(() => handle);
  }

  /** A short wavy underline under a client rect. */
  function underline(rect, { seed = `u${seq++}`, cls = 'gold', duration = 280, delay = 0, offset = 4 } = {}) {
    return stroke(underlinePoints(rect, { seed, offset }), { cls, duration, delay });
  }

  /** An open ellipse (a drum's top, a clock face, a globe). */
  function ellipse(cx, cy, rx, ry, { seed = `e${seq++}`, cls = 'ink', duration = 340, delay = 0, turns = 1.04, start } = {}) {
    return stroke(ellipsePoints(cx, cy, rx, ry, { seed, turns, start }), { cls, duration, delay });
  }

  /**
   * Everything on the layer leaves, newest first: strokes un-draw toward their
   * start, writing fades and sinks. A wipe, never a cut.
   */
  async function erase({ duration = INK.erase, stagger = INK.stagger } = {}) {
    const items = [...live].reverse();
    live.clear();
    if (!items.length) return;
    if (reduced()) { for (const h of items) { h.anim?.cancel(); h.el.remove(); } return; }
    await Promise.all(items.map((h, i) => {
      // Continue from where a reveal in flight has got to (its current dash), never from finished.
      let from = 0;
      if (h.kind === 'path' && h.anim) {
        try { from = Number(getComputedStyle(h.el).strokeDashoffset.replace('px', '')) || 0; } catch { from = 0; }
      }
      h.anim?.cancel();
      const delay = Math.min(i, 8) * stagger;
      let anim;
      if (h.kind === 'path') {
        h.el.style.strokeDashoffset = String(from);
        anim = h.el.animate([{ strokeDashoffset: from }, { strokeDashoffset: -1 }], { duration, delay, easing: EASE.exit, fill: 'forwards' });
      } else {
        anim = h.el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(2px)' }], { duration: duration * 0.9, delay, easing: EASE.exit, fill: 'forwards' });
      }
      return anim.finished.catch(() => {}).then(() => h.el.remove());
    }));
  }

  function clear() { for (const h of live) { h.anim?.cancel(); h.el.remove(); } live.clear(); }
  function destroy() { clear(); svg.remove(); }

  /** The client boxes of what is on the layer now (strokes and writing), for layout: [{ left, top, right, bottom, kind }]. */
  function boxes() {
    const out = [];
    for (const h of live) {
      try {
        const r = h.el.getBoundingClientRect();
        if (r.width || r.height) out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, kind: h.kind });
      } catch { /* not laid out */ }
    }
    return out;
  }

  return {
    el: svg, ink, stroke, path, box, ring, arrow, label, underline, ellipse, erase, clear, destroy, local, localRect, measure, setKeepOut, boxes,
    get count() { return live.size; },
    get keepOut() { return keepOut; },
  };
}

/** Two short dashes and a dot to the side of a point: a tiny sparkle (celebration). */
export function sparkle(stage, at, { cls = 'gold' } = {}) {
  const arms = [[-1, -1], [1, -1], [0.1, 1.25]];
  return Promise.all(arms.map(([ax, ay], i) => stage.stroke(
    [{ x: at.x + ax * 5, y: at.y + ay * 5 }, { x: at.x + ax * 11, y: at.y + ay * 11 }],
    { cls, duration: 160, delay: i * 50 },
  )));
}

/**
 * The one highlight ring. to(rect, shape) rings a control: the first time it
 * is drawn on there (a WAAPI stroke reveal, pen-first), after that it springs
 * from the control it rings now: centre, size, pads and corner radius all
 * glide on one spring, and the ring (softRingPath) is made from that shape
 * every frame, so it morphs without a jump, a jitter or a shimmer; to(null) lets it
 * fade where it is. A resize or scroll is the host's to call: refresh(rect)
 * moves it there. Frames come from the shared ticker, only while it moves.
 * shape: { pad, padY, corner, radius } (px: the gap round the control, the gap
 * above and below it, the control's own corner radius, the ring's largest).
 */
export function createHighlight(stage, { reduced = () => false, seed = 'tour-highlight' } = {}) {
  const el = document.createElementNS(NS, 'path');
  el.setAttribute('class', 'tour-ink gold tour-highlight');
  el.setAttribute('pathLength', '1');
  el.style.strokeDasharray = '1 1';
  el.style.strokeDashoffset = '1';
  el.style.opacity = '0';
  (stage.ink || stage.el).appendChild(el);
  const MORPH = [15, 0.8]; // ω, ζ: a glide that lands with a hint of give
  const FADE = [16, 1];
  const KEYS = ['cx', 'cy', 'w', 'h', 'pad', 'padY', 'corner', 'radius', 'tail'];
  const s = { op: 0, vop: 0 };
  for (const k of KEYS) { s[k] = 0; s[`v${k}`] = 0; }
  let goal = null; // the shape it springs to
  let shown = false; // a target is ringed (op → 1)
  let reveal = null; // the draw-on in flight
  let stop = null;
  let resolveSettled = null;
  let settledPromise = Promise.resolve();
  let lastD = '';

  // `tail`: how far the pen's close bows out past the start (softRingPath's, 3.2 px): a control that sits at the panel's
  // edge (the hand-off's composer) asks for less, so the ring stays inside the panel.
  const shapeOf = (rect, { pad = 7, padY = 5, corner = 6, radius = 999, tail = 3.2 } = {}) => ({
    cx: rect.left + rect.width / 2,
    cy: rect.top + rect.height / 2,
    w: rect.width,
    h: rect.height,
    pad: Number(pad) || 0,
    padY: Number(padY) || 0,
    corner: Math.max(0, Number(corner) || 0),
    radius: Number.isFinite(Number(radius)) ? Number(radius) : 999,
    tail: Number.isFinite(Number(tail)) ? Math.max(0, Number(tail)) : 3.2,
  });

  const ringOf = (g, local = true) => {
    const rect = { left: g.cx - g.w / 2, top: g.cy - g.h / 2, width: Math.max(0, g.w), height: Math.max(0, g.h) };
    return softRingPath(local && stage.localRect ? stage.localRect(rect) : rect, { pad: g.pad, padY: g.padY, corner: g.corner, maxRadius: g.radius, tail: g.tail, seed });
  };

  function paint() {
    const d = ringOf(s).d;
    if (d !== lastD) { el.setAttribute('d', d); lastD = d; }
    el.style.opacity = String(Math.max(0, Math.min(1, s.op)).toFixed(3));
  }

  const shapeSettled = () => !goal || KEYS.every(k => Math.abs(s[k] - goal[k]) < 0.3 && Math.abs(s[`v${k}`]) < 2);
  const fadeSettled = () => Math.abs(s.op - (shown ? 1 : 0)) < 0.01 && Math.abs(s.vop) < 0.05;

  function onFrame(_now, dtMs) {
    const dt = dtMs / 1000;
    if (goal) {
      for (const k of KEYS) {
        const r = springStep(s[k], s[`v${k}`], goal[k], MORPH[0], MORPH[1], dt);
        s[k] = r.x;
        s[`v${k}`] = r.v;
      }
    }
    const o = springStep(s.op, s.vop, shown ? 1 : 0, FADE[0], FADE[1], dt);
    s.op = o.x;
    s.vop = o.v;
    if (shapeSettled() && fadeSettled()) {
      if (goal) for (const k of KEYS) { s[k] = goal[k]; s[`v${k}`] = 0; }
      s.op = shown ? 1 : 0;
      s.vop = 0;
      paint();
      if (!shown) goal = null;
      halt();
      return;
    }
    paint();
  }

  function run() {
    if (stop) return;
    stop = subscribe(onFrame, { fps: 60 });
  }

  function halt() {
    stop?.();
    stop = null;
    if (!reveal) { resolveSettled?.(); resolveSettled = null; }
  }

  /** Draw the ring on, pen-first: a WAAPI stroke reveal (the hurry speeds it up with the board's). */
  function drawOn() {
    reveal?.cancel();
    el.style.strokeDashoffset = '1';
    const anim = el.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: INK.ring, easing: EASE.draw, fill: 'forwards' });
    reveal = anim;
    const done = () => {
      if (reveal !== anim) return;
      el.style.strokeDashoffset = '0';
      anim.cancel();
      reveal = null;
      if (!stop) { resolveSettled?.(); resolveSettled = null; }
    };
    anim.finished.then(done, done);
  }

  /** Ring `rect` (a client rect), or fade (null). Resolves when the ring has arrived and is drawn (or at once when calm). */
  function to(rect, shape = {}) {
    if (!rect) {
      shown = false;
      if (reduced()) { reveal?.cancel(); reveal = null; s.op = 0; s.vop = 0; paint(); halt(); return Promise.resolve(); }
      return start();
    }
    const next = shapeOf(rect, shape);
    const fresh = s.op < 0.05 && !shown;
    goal = next;
    shown = true;
    if (reduced()) {
      reveal?.cancel();
      reveal = null;
      Object.assign(s, next, { op: 1, vop: 0 });
      for (const k of KEYS) s[`v${k}`] = 0;
      el.style.strokeDashoffset = '0';
      paint();
      halt();
      return Promise.resolve();
    }
    if (fresh) {
      // Nothing on screen: it is drawn on where it rings, pen-first, rather than flying in from nowhere.
      Object.assign(s, next);
      for (const k of KEYS) s[`v${k}`] = 0;
      s.op = 1;
      s.vop = 0;
      paint(); // the path exists before the reveal starts
      drawOn();
    } else paint();
    return start();
  }

  function start() {
    settledPromise = new Promise((resolve) => { resolveSettled?.(); resolveSettled = resolve; });
    run();
    return settledPromise;
  }

  /** The control moved (a resize, a scroll): glide there without a new draw. */
  function refresh(rect, shape) {
    if (!rect || !shown || !goal) return;
    goal = shapeOf(rect, shape || { pad: goal.pad, padY: goal.padY, corner: goal.corner, radius: goal.radius, tail: goal.tail });
    if (reduced()) { Object.assign(s, goal); paint(); return; }
    run();
  }

  return {
    el,
    to,
    refresh,
    /** Where it rings now, or null. */
    get target() { return shown && goal ? { ...goal } : null; },
    /** The client box the ring's stroke covers when it has arrived (its shape at the goal), or null. */
    get box() {
      if (!shown || !goal) return null;
      const h = ringOf(goal, false).hull;
      return { left: h.left - 1, top: h.top - 1, right: h.right + 1, bottom: h.bottom + 1 };
    },
    destroy() { reveal?.cancel(); reveal = null; halt(); el.remove(); },
  };
}

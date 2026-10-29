// The Workspace tour's ink, as pure geometry: no DOM, so node:test checks it
// (tests/tour-ink.test.mjs). Every shape is a few points run through one
// smooth Catmull-Rom curve (cubic Béziers), with a slow seeded wander (two or
// three waves round a shape, never a per-point jitter) so the same beat draws
// the same hand every time and a moving ring never shimmers. Nothing here has
// a hard corner: boxes and rings are rounded outlines sampled corner-aware,
// rings close a little past their start with a soft overlap, arrows bow once.
// tour-stage.js turns these into SVG paths and reveals them.

/** Seeded random in [0, 1): the same seed string gives the same wobble. */
export function seededRand(seed) {
  let h = 0;
  const text = String(seed);
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  h = Math.abs(h) || 1;
  return () => {
    h = (h * 16807) % 2147483647;
    return (h - 1) / 2147483646;
  };
}

const r2 = (v) => {
  const r = Math.round(v * 100) / 100;
  return String(r === 0 ? 0 : r);
};

/**
 * One Catmull-Rom segment p1 → p2 (neighbours p0, p3) as a cubic Bézier's two
 * control points, centripetal (α ½): uneven spacing (a long side, then a
 * corner's short steps) never overshoots, loops or kinks; evenly spaced points
 * give the uniform spline (1/6 tangents, so points on a circle stay a circle).
 */
function bezierControls(p0, p1, p2, p3) {
  const d = (a, b) => Math.sqrt(Math.max(1e-9, Math.hypot(b[0] - a[0], b[1] - a[1])));
  const d1 = d(p0, p1);
  const d2 = d(p1, p2);
  const d3 = d(p2, p3);
  const c1 = [0, 1].map(i => (d1 * d1 * p2[i] - d2 * d2 * p0[i] + (2 * d1 * d1 + 3 * d1 * d2 + d2 * d2) * p1[i]) / (3 * d1 * (d1 + d2)));
  const c2 = [0, 1].map(i => (d3 * d3 * p1[i] - d2 * d2 * p3[i] + (2 * d3 * d3 + 3 * d3 * d2 + d2 * d2) * p2[i]) / (3 * d3 * (d3 + d2)));
  return [c1, c2];
}

/** A phantom point before `a` (next `b`, then `c`): the curve's own bend carried on, never further out than its first step. */
function phantom(a, b, c) {
  if (!c) return [2 * a[0] - b[0], 2 * a[1] - b[1]];
  const q = [3 * a[0] - 3 * b[0] + c[0], 3 * a[1] - 3 * b[1] + c[1]]; // the quadratic through a, b, c, one step back
  const step = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const far = Math.hypot(q[0] - a[0], q[1] - a[1]);
  if (!(far > 1e-6)) return [2 * a[0] - b[0], 2 * a[1] - b[1]];
  const k = Math.min(1, (1.5 * step) / far);
  return [a[0] + (q[0] - a[0]) * k, a[1] + (q[1] - a[1]) * k];
}

/**
 * A smooth open path through `pts` ([x, y] pairs): a centripetal Catmull-Rom
 * spline as cubic Béziers, its ends carrying the curve's own bend (no flat
 * start, no wiggle at the tip of a bowed arrow).
 */
export function pointsToSmoothPath(pts) {
  if (!pts?.length) return '';
  if (pts.length === 1) return `M ${r2(pts[0][0])} ${r2(pts[0][1])}`;
  if (pts.length === 2) return `M ${r2(pts[0][0])} ${r2(pts[0][1])} L ${r2(pts[1][0])} ${r2(pts[1][1])}`;
  const n = pts.length;
  const before = phantom(pts[0], pts[1], pts[2]);
  const after = phantom(pts[n - 1], pts[n - 2], pts[n - 3]);
  let d = `M ${r2(pts[0][0])} ${r2(pts[0][1])}`;
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = i === 0 ? before : pts[i - 1];
    const p3 = i + 2 < n ? pts[i + 2] : after;
    const [c1, c2] = bezierControls(p0, pts[i], pts[i + 1], p3);
    d += ` C ${r2(c1[0])} ${r2(c1[1])}, ${r2(c2[0])} ${r2(c2[1])}, ${r2(pts[i + 1][0])} ${r2(pts[i + 1][1])}`;
  }
  return d;
}

/** A smooth closed path through `pts` (the curve wraps, so the seam has no corner). */
export function closedSmoothPath(pts) {
  if (!pts?.length || pts.length < 3) return pointsToSmoothPath(pts);
  const at = (i) => pts[(i + pts.length) % pts.length];
  let d = `M ${r2(pts[0][0])} ${r2(pts[0][1])}`;
  for (let i = 0; i < pts.length; i += 1) {
    const [c1, c2] = bezierControls(at(i - 1), at(i), at(i + 1), at(i + 2));
    const p2 = at(i + 1);
    d += ` C ${r2(c1[0])} ${r2(c1[1])}, ${r2(c2[0])} ${r2(c2[1])}, ${r2(p2[0])} ${r2(p2[1])}`;
  }
  return `${d} Z`;
}

/**
 * A point on the outline of a rounded rectangle (centre cx, cy; half sizes hw,
 * hh; corner radius r), `u` of the way round (0-1, clockwise from the top
 * centre). Even spacing by arc length, so a ring morphing between two rects
 * keeps its points in step.
 */
export function roundedRectPoint(cx, cy, hw, hh, r, u) {
  const rr = Math.max(0, Math.min(r, hw, hh));
  const sx = Math.max(0, hw - rr);
  const sy = Math.max(0, hh - rr);
  const arc = (Math.PI / 2) * rr;
  const segs = [sx, arc, 2 * sy, arc, 2 * sx, arc, 2 * sy, arc, sx];
  const total = segs.reduce((a, b) => a + b, 0) || 1;
  let left = (((u % 1) + 1) % 1) * total;
  const corner = (ox, oy, a0, p) => {
    const a = a0 + (Math.PI / 2) * p;
    return [ox + Math.cos(a) * rr, oy + Math.sin(a) * rr];
  };
  const steps = [
    (p) => [cx + sx * p, cy - hh],
    (p) => corner(cx + sx, cy - sy, -Math.PI / 2, p),
    (p) => [cx + hw, cy - sy + 2 * sy * p],
    (p) => corner(cx + sx, cy + sy, 0, p),
    (p) => [cx + sx - 2 * sx * p, cy + hh],
    (p) => corner(cx - sx, cy + sy, Math.PI / 2, p),
    (p) => [cx - hw, cy + sy - 2 * sy * p],
    (p) => corner(cx - sx, cy - sy, Math.PI, p),
    (p) => [cx - sx + sx * p, cy - hh],
  ];
  for (let i = 0; i < segs.length; i += 1) {
    if (left <= segs[i] || i === segs.length - 1) return steps[i](segs[i] ? Math.min(1, left / segs[i]) : 0);
    left -= segs[i];
  }
  return [cx, cy - hh];
}

/**
 * A slow, smooth wander for hand-drawn outlines: two or three gentle waves
 * round the whole shape (`u` 0-1), seeded, never a per-point jitter, so a
 * stroke stays a clean curve and a moving shape never shimmers. ±`amp` px.
 */
export function lowWander(seed, amp = 1) {
  const rand = seededRand(`${seed}~w`);
  const p1 = rand() * Math.PI * 2;
  const p2 = rand() * Math.PI * 2;
  const k = 0.55 + 0.25 * rand();
  return u => amp * (k * Math.sin(Math.PI * 2 * 2 * u + p1) + (1 - k) * Math.sin(Math.PI * 2 * 3 * u + p2));
}

/** The base shape a highlight ring draws around `rect` (softRingPath): its centre, half sizes and corner radius. */
export function ringShape(rect, { pad = 6, padY = pad, corner = 6, minRadius = 9, maxRadius = Infinity } = {}) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const a = Math.max(0, rect.width / 2);
  const b = Math.max(0, rect.height / 2);
  const cr = Math.max(0, Math.min(Number(corner) || 0, a, b)); // the control's own corner radius
  let hw = Math.max(4, a + pad);
  let hh = Math.max(4, b + padY);
  const radius = () => Math.min(hh, hw, Math.max(minRadius, Math.min(hh * 0.9, maxRadius)));
  // Grow until the ring's corner arcs clear the control's rounded corners by most of the pad.
  const want = Math.min(pad, padY) * 0.6;
  for (let i = 0; i < 4; i += 1) {
    const r = radius();
    // From the ring's corner centre to the control's (both inset by their radius): the control's corner reaches this far out.
    const gap = r - (Math.hypot(Math.max(0, (a - cr) - (hw - r)), Math.max(0, (b - cr) - (hh - r))) + cr);
    const short = want - gap;
    if (!(short > 0.05)) break;
    hw += short;
    hh += short;
  }
  return { cx, cy, hw, hh, r: radius() };
}

/**
 * A rounded loop as a pen draws it, built exactly: the straight sides and the
 * cubic corner arcs of the rounded rectangle `shape` ({ cx, cy, hw, hh, r }),
 * clockwise, starting `start` px along it (0 is the top side's left end) and
 * running once round and `over` px past the start. Anchors sit at every side's
 * ends and middle and at every corner's middle, so the set is small and the
 * same for every control. Each anchor is pushed out along the outline's normal
 * by `offset(s, past)` (s px from the start; past 0-1 into the overlap), its
 * handles with it: the curve stays tangent-continuous, a wander bends a side
 * into a gentle curve, never a kink. Returns { d, anchors, hull } (hull: the
 * box of every anchor and handle, which the curve never leaves).
 */
function loopPath(shape, { start = 0, over = 14, offset = () => 0 } = {}) {
  const { cx, cy, hw, hh } = shape;
  const r = Math.max(0, Math.min(shape.r, hw, hh));
  const sx = Math.max(0, hw - r);
  const sy = Math.max(0, hh - r);
  const arc = (Math.PI / 2) * r;
  // The outline as pieces, clockwise from the top side's left end: [length, kind, …].
  const pieces = [
    { len: 2 * sx, line: [cx - sx, cy - hh, 1, 0] },
    { len: arc, arc: [cx + sx, cy - sy, -Math.PI / 2] },
    { len: 2 * sy, line: [cx + hw, cy - sy, 0, 1] },
    { len: arc, arc: [cx + sx, cy + sy, 0] },
    { len: 2 * sx, line: [cx + sx, cy + hh, -1, 0] },
    { len: arc, arc: [cx - sx, cy + sy, Math.PI / 2] },
    { len: 2 * sy, line: [cx - hw, cy + sy, 0, -1] },
    { len: arc, arc: [cx - sx, cy - sy, Math.PI] },
  ];
  const total = pieces.reduce((a, p) => a + p.len, 0) || 1;
  /** The piece at loop position `s` (any number: it wraps) and how far into it. */
  const pieceAt = (s) => {
    let left = ((s % total) + total) % total;
    for (const p of pieces) { if (left <= p.len && p.len > 0) return { p, at: left }; left -= p.len; }
    return { p: pieces.find(q => q.len > 0) || pieces[0], at: 0 };
  };
  /** Position and unit tangent at `s` along piece `p`, `at` px into it. */
  const frameOf = (p, at) => {
    if (p.line) { const [x, y, tx, ty] = p.line; return { x: x + tx * at, y: y + ty * at, tx, ty }; }
    const [ox, oy, a0] = p.arc;
    const a = a0 + (r > 0 ? at / r : 0);
    return { x: ox + Math.cos(a) * r, y: oy + Math.sin(a) * r, tx: -Math.sin(a), ty: Math.cos(a) };
  };
  // Where the anchors go: every piece's start, every corner's middle and the middle of a side long enough to
  // carry a wave (a short one would only get a ripple), from `start` to `start + total + over`.
  const end = start + total + over;
  const stops = [start];
  for (let lap = Math.floor(start / total) - 1; lap <= Math.ceil(end / total); lap += 1) {
    let s = lap * total;
    for (const p of pieces) {
      for (const f of (p.arc || p.len > 24 ? [0, 0.5] : [0])) { const q = s + p.len * f; if (q > start + 1e-6 && q < end - 1e-6) stops.push(q); }
      s += p.len;
    }
  }
  stops.push(end);
  stops.sort((a, b) => a - b);
  const anchors = [];
  for (let i = 0; i < stops.length; i += 1) {
    if (i && stops[i] - stops[i - 1] < 1e-6) continue;
    const s = stops[i];
    // At a piece boundary the next piece's frame (they share the point and, on a rounded outline, the tangent).
    const { p, at } = i === stops.length - 1 ? pieceAt(s - 1e-7) : pieceAt(s + 1e-7);
    const fr = frameOf(p, Math.max(0, i === stops.length - 1 ? at + 1e-7 : at - 1e-7));
    const past = s - start > total ? (s - start - total) / Math.max(1e-6, over) : 0;
    const o = offset(s - start, past);
    anchors.push({ x: fr.x + fr.ty * o, y: fr.y - fr.tx * o, tx: fr.tx, ty: fr.ty, s: s - start });
  }
  let d = `M ${r2(anchors[0].x)} ${r2(anchors[0].y)}`;
  const xs = [anchors[0].x];
  const ys = [anchors[0].y];
  for (let i = 1; i < anchors.length; i += 1) {
    const a = anchors[i - 1];
    const b = anchors[i];
    const len = b.s - a.s;
    const mid = pieceAt(start + (a.s + b.s) / 2).p;
    // A straight run: handles a third of the way along; an arc: the cubic circle's handle for its angle.
    const h = mid.arc && r > 0 ? (4 / 3) * Math.tan(len / r / 4) * r : len / 3;
    const c1 = [a.x + a.tx * h, a.y + a.ty * h];
    const c2 = [b.x - b.tx * h, b.y - b.ty * h];
    d += ` C ${r2(c1[0])} ${r2(c1[1])}, ${r2(c2[0])} ${r2(c2[1])}, ${r2(b.x)} ${r2(b.y)}`;
    xs.push(c1[0], c2[0], b.x);
    ys.push(c1[1], c2[1], b.y);
  }
  return { d, anchors, hull: { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) }, total };
}

/**
 * The smooth hand-drawn ring around a control: the rounded outline ringShape
 * gives, drawn exactly (loopPath: straight sides, round corners, no polygon,
 * no bulge), a slow wander of about a px (lowWander: no per-point wobble),
 * and a pen's close: it lands a hair inside at the middle of the lower-left
 * corner (below the control, away from any text over it), goes once round
 * clockwise and runs on up the left side past its start, drifting `tail` px
 * outward, so the two ends overlap softly and never meet head on. Returns
 * { d, anchors, hull }: the path data, its anchors and the box it stays in.
 */
export function softRingPath(rect, { pad = 6, padY = pad, corner = 6, seed = 'ring', wobble = 0.9, tail = 3.2, minRadius = 9, maxRadius = Infinity } = {}) {
  const shape = ringShape(rect, { pad, padY, corner, minRadius, maxRadius });
  const wander = lowWander(seed, wobble);
  const r = Math.min(shape.r, shape.hw, shape.hh);
  const sx = Math.max(0, shape.hw - r);
  const sy = Math.max(0, shape.hh - r);
  const arc = (Math.PI / 2) * r;
  const total = 4 * (sx + sy) + 4 * arc;
  const start = 4 * sx + 2 * sy + 2.5 * arc; // the middle of the lower-left corner
  const over = Math.max(10, Math.min(28, total * 0.07));
  const ramp = u => { const v = Math.max(0, Math.min(1, u)); return v * v * (3 - 2 * v); };
  return loopPath(shape, {
    start,
    over,
    offset: (s, past) => wander(s / total)
      - 0.5 * (1 - ramp(s / (0.08 * total))) // lands a hair inside
      + tail * ramp((s - 0.9 * total) / (0.1 * total + over)) * (0.4 + 0.6 * past), // and comes round outside it
  });
}

/**
 * A rounded hand-drawn box around a rect: drawn exactly like the ring
 * (loopPath), a slow wander of under a px, starting on the top side a little
 * in from the top-left corner and closing just past the start. `radius` is
 * at least 8: no hard corner on the board. Returns { d, anchors, hull }.
 */
export function softBoxPath(rect, { pad = 0, radius = 10, seed = 'box', jitter = 0.7 } = {}) {
  const w = rect.width + pad * 2;
  const h = rect.height + pad * 2;
  const r = Math.max(Math.min(8, w / 2, h / 2), Math.min(radius, w / 2, h / 2));
  const shape = { cx: rect.left - pad + w / 2, cy: rect.top - pad + h / 2, hw: w / 2, hh: h / 2, r };
  const wander = lowWander(seed, jitter);
  const total = 2 * (w + h) - (8 - 2 * Math.PI) * r;
  const start = Math.min(10, Math.max(0, w - 2 * r) * 0.2);
  const over = Math.max(5, Math.min(10, total * 0.03));
  return loopPath(shape, { start, over, offset: (s, past) => wander(s / total) + 0.9 * past });
}

/**
 * A bowed arrow from `from` to `to` (client points): its shaft as five points
 * on one smooth bow (`curve` × its length to the side, its peak a little past
 * the middle, like a flick of the pen; the ends exact), and its head: two short
 * wings at the end along the shaft's last direction (`wings`), also as one
 * stroke through both (`head`: wing, tip, wing).
 */
export function arrowGeometry(from, to, { curve = 0.16, seed = 'arrow', head = 7 } = {}) {
  const rand = seededRand(seed);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const bend = curve * len;
  const lean = 0.12 + 0.08 * rand(); // the bow peaks a little past the middle
  const shaft = [];
  for (let i = 0; i <= 4; i += 1) {
    const t = i / 4;
    const bow = Math.sin(t * Math.PI) * bend * (1 + lean * (t - 0.5) * 2);
    shaft.push([from.x + dx * t + nx * bow, from.y + dy * t + ny * bow]);
  }
  // The shaft's last direction, from the smooth curve's end tangent (Catmull-Rom: the last two points).
  const [x1, y1] = shaft[3];
  const [x2, y2] = shaft[4];
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const wing = side => [[x2 - Math.cos(ang + side * 0.55) * head, y2 - Math.sin(ang + side * 0.55) * head], [x2, y2]];
  const wings = [wing(1), wing(-1)];
  return { shaft, wings, head: [wings[0][0], [x2, y2], wings[1][0]] };
}

/** A gentle underline under a rect: one smooth stroke with one slow wave and a slight lift at its end. */
export function underlinePoints(rect, { offset = 4, seed = 'u' } = {}) {
  const rand = seededRand(seed);
  const y = rect.top + rect.height + offset;
  const phase = rand() * Math.PI;
  const amp = 0.9 + 0.5 * rand();
  const pts = [];
  for (let i = 0; i <= 4; i += 1) {
    const t = i / 4;
    pts.push([rect.left + rect.width * t, y + Math.sin(t * Math.PI + phase) * amp - t * t * 2.2]);
  }
  return pts;
}

/**
 * An ellipse's points (open, `turns` of a full turn from `start` radians): a
 * drum's top, a clock face. A true ellipse with a slow wander of the radius
 * (`jitter` px, two or three waves round, never per point), 16 points a turn.
 */
export function ellipsePoints(cx, cy, rx, ry, { start = -Math.PI / 2, turns = 1.04, count, seed = 'e', jitter = 0.6 } = {}) {
  const wander = lowWander(seed, jitter);
  const n = Math.max(6, Math.round(Number(count) || 16 * Math.abs(turns)));
  const pts = [];
  for (let i = 0; i <= n; i += 1) {
    const f = i / n;
    const a = start + f * Math.PI * 2 * turns;
    const w = i === 0 ? 0 : wander(f * Math.abs(turns));
    pts.push([cx + Math.cos(a) * (rx + w), cy + Math.sin(a) * (ry + w)]);
  }
  return pts;
}

/** A spring step toward `goal` (semi-implicit Euler, sub-stepped): returns the new { x, v }. */
export function springStep(x, v, goal, omega, zeta, dt) {
  let pos = x;
  let vel = v;
  let left = Math.max(0, Math.min(0.064, dt));
  while (left > 1e-6) {
    const h = Math.min(1 / 240, left);
    left -= h;
    vel += (omega * omega * (goal - pos) - 2 * zeta * omega * vel) * h;
    pos += vel * h;
  }
  return { x: pos, v: vel };
}

/** --asst-ease-standard, cubic-bezier(.2, 0, .38, .9), for values the tour eases in script. */
export function easeStandard(p) {
  const x = Math.max(0, Math.min(1, p));
  // Newton on the x(t) cubic, then y(t).
  const ax = 1 - 3 * 0.38 + 3 * 0.2;
  const bx = 3 * 0.38 - 6 * 0.2;
  const cx = 3 * 0.2;
  const ay = 1 - 3 * 0.9;
  const by = 3 * 0.9;
  let t = x;
  for (let i = 0; i < 8; i += 1) {
    const fx = ((ax * t + bx) * t + cx) * t - x;
    const d = (3 * ax * t + 2 * bx) * t + cx;
    if (Math.abs(fx) < 1e-6 || Math.abs(d) < 1e-6) break;
    t = Math.max(0, Math.min(1, t - fx / d));
  }
  return ((ay * t + by) * t) * t;
}

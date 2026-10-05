// ═══════════════════════════════════════════
// TUTORIAL DRAWING ENGINE
// ═══════════════════════════════════════════
//
// Hand-drawn SVG primitives for the workspace tour, in the style of the
// whiteboard. Zero knowledge of tutorial steps — pure drawing utilities.
//
// Core techniques:
// - Catmull-Rom spline interpolation for smooth, organic curves
// - Seeded PRNG for deterministic wobble (same seed = same wobble every time)
// - SVG stroke-dashoffset transitions for the stroke-by-stroke "draw-in"
//
// Every primitive takes { duration, delay } in ms and returns { destroy }.
// A duration of 0 (or prefers-reduced-motion) renders the finished stroke.

const SVG_NS = 'http://www.w3.org/2000/svg';
const EASE = 'cubic-bezier(0.2, 0, 0, 1)';

/** Seeded random for consistent wobble per seed string. */
export function seededRand(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return () => {
    h = (h * 16807 + 0) % 2147483647;
    return (h & 0x7fffffff) / 2147483647;
  };
}

/** Convert points to a smooth SVG path using Catmull-Rom → cubic bezier (open path). */
export function pointsToSmoothPath(pts) {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0][0]} ${pts[0][1]}`;
  if (pts.length === 2) return `M ${pts[0][0]} ${pts[0][1]} L ${pts[1][0]} ${pts[1][1]}`;

  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[Math.min(pts.length - 1, i + 1)];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    // 1/6 is the uniform Catmull-Rom tangent: evenly spaced points on a circle stay a circle.
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

// ═══════════════════════════════════════════
// SVG HELPERS
// ═══════════════════════════════════════════

const instant = (duration) => duration <= 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function createSvgPath(container, d, color, strokeWidth = 2) {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', String(strokeWidth));
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  container.appendChild(path);
  return path;
}

function animateStrokeDash(path, duration, delay) {
  if (instant(duration)) return;
  const length = path.getTotalLength();
  path.style.strokeDasharray = String(length);
  path.style.strokeDashoffset = String(length);
  // Committing the start value makes the transition run from it.
  path.getBoundingClientRect();
  path.style.transition = `stroke-dashoffset ${duration}ms ${EASE} ${delay}ms`;
  path.style.strokeDashoffset = '0';
}

// ═══════════════════════════════════════════
// OUTLINE (around a target or the note)
// ═══════════════════════════════════════════

/** An ellipse inscribed in the rect, with a tail that overshoots the start. */
function ringPath(rect, j) {
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const rx = rect.width / 2, ry = rect.height / 2;
  const pts = [], n = 16, total = Math.PI * 2 + 0.5;
  for (let i = 0; i <= n; i++) {
    const a = -2.2 + (i / n) * total;
    // The tail drifts outwards, the way a pen leaves a circle.
    const drift = i === n ? 3 : i === n - 1 ? 1.5 : 0;
    pts.push([cx + Math.cos(a) * (rx + j() + drift), cy + Math.sin(a) * (ry + j() + drift)]);
  }
  return pointsToSmoothPath(pts);
}

/** A rounded rectangle, clockwise from the top edge: bowed sides, soft corners, closing past the start. */
function boxPath(rect, radius, j) {
  const { left: x1, top: y1, right: x2, bottom: y2 } = rect;
  const r = Math.max(2, Math.min(radius, rect.width / 2, rect.height / 2));
  const sx = x1 + r + Math.min(18, (rect.width - 2 * r) / 2);
  let d = `M ${sx} ${y1 + j()}`, px = sx, py = y1;
  const side = (bx, by) => {
    const steps = Math.max(1, Math.round(Math.hypot(bx - px, by - py) / 110));
    const ax = px, ay = py;
    for (let i = 1; i <= steps; i++) {
      const ex = ax + (bx - ax) * i / steps + (i < steps ? j() : 0);
      const ey = ay + (by - ay) * i / steps + (i < steps ? j() : 0);
      d += ` Q ${(px + ex) / 2 + j()} ${(py + ey) / 2 + j()} ${ex} ${ey}`;
      px = ex; py = ey;
    }
  };
  const corner = (cx, cy, ex, ey) => { d += ` Q ${cx + j()} ${cy + j()} ${ex} ${ey}`; px = ex; py = ey; };
  side(x2 - r, y1); corner(x2, y1, x2, y1 + r);
  side(x2, y2 - r); corner(x2, y2, x2 - r, y2);
  side(x1 + r, y2); corner(x1, y2, x1, y2 - r);
  side(x1, y1 + r); corner(x1, y1, x1 + r, y1 - 1);
  // Close past the start, a little above the first stroke.
  const tail = Math.min(sx + 22, x2 - r);
  return `${d} Q ${(px + tail) / 2} ${y1 - 1.5 + j()} ${tail} ${y1 - 2.5}`;
}

/**
 * Draw a hand-drawn outline on a rect: a ring for compact targets, a rounded box otherwise.
 * @param {SVGElement} svg
 * @param {{left,top,right,bottom,width,height}} rect - where the stroke runs (padding included)
 * @param {Object} config - { shape: 'ring'|'box', color, strokeWidth, radius, wobble, wobbleSeed, duration, delay }
 * @returns {{ destroy: Function }}
 */
export function createOutline(svg, rect, config) {
  const {
    shape = 'box',
    color = 'rgba(255,255,255,0.3)',
    strokeWidth = 2,
    radius = 12,
    wobble = 1.6,
    wobbleSeed = 'outline',
    duration = 250,
    delay = 0,
  } = config;

  const rand = seededRand(wobbleSeed);
  const j = () => (rand() - 0.5) * wobble;
  const path = createSvgPath(svg, shape === 'ring' ? ringPath(rect, j) : boxPath(rect, radius, j), color, strokeWidth);
  animateStrokeDash(path, duration, delay);

  return {
    elements: [path],
    destroy() { path.remove(); },
  };
}

// ═══════════════════════════════════════════
// ANIMATED ARROW
// ═══════════════════════════════════════════

/**
 * Draw a hand-drawn animated arrow from point A to point B.
 * @param {SVGElement} svg - Container SVG element
 * @param {Object} config - { from:{x,y}, to:{x,y}, color, wobbleSeed, duration, delay, arrowheadSize }
 * @returns {{ destroy: Function }}
 */
export function createAnimatedArrow(svg, config) {
  const {
    from, to,
    color = 'rgba(255,255,255,0.35)',
    wobbleSeed = 'arrow',
    duration = 250,
    delay = 0,
    arrowheadSize = 12,
    strokeWidth = 2,
  } = config;

  const rand = seededRand(wobbleSeed);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const perpAngle = Math.atan2(dy, dx) + Math.PI / 2;

  // Control point: gentle perpendicular offset, capped so long arrows stay tight
  const arcAmount = Math.min(dist * (0.12 + rand() * 0.1), 40) * (rand() < 0.5 ? -1 : 1);
  const cpX = (from.x + to.x) / 2 + Math.cos(perpAngle) * arcAmount;
  const cpY = (from.y + to.y) / 2 + Math.sin(perpAngle) * arcAmount;

  // Quadratic bezier — clean, predictable arc
  const bodyPath = createSvgPath(svg, `M ${from.x} ${from.y} Q ${cpX} ${cpY} ${to.x} ${to.y}`, color, strokeWidth);
  animateStrokeDash(bodyPath, duration, delay);

  // Arrowhead: two strokes at the tip, along the direction the arrow arrives in
  const endAngle = Math.atan2(to.y - cpY, to.x - cpX);
  const s = Math.min(arrowheadSize, Math.max(6, dist / 3));
  const spread = 0.5;
  const head = createSvgPath(svg,
    `M ${to.x - Math.cos(endAngle - spread) * s} ${to.y - Math.sin(endAngle - spread) * s}`
    + ` L ${to.x} ${to.y}`
    + ` L ${to.x - Math.cos(endAngle + spread) * s} ${to.y - Math.sin(endAngle + spread) * s}`, color, strokeWidth);
  animateStrokeDash(head, Math.min(duration, 120), delay + duration);

  return {
    elements: [bodyPath, head],
    destroy() { bodyPath.remove(); head.remove(); },
  };
}

// ═══════════════════════════════════════════
// HAND-DRAWN UNDERLINE
// ═══════════════════════════════════════════

/**
 * Draw a wavy hand-drawn underline beneath a rect.
 * @param {SVGElement} svg
 * @param {{left,bottom,width}} rect
 * @param {Object} config - { color, wobbleSeed, duration, delay, offset }
 * @returns {{ destroy: Function }}
 */
export function createHandDrawnUnderline(svg, rect, config) {
  const {
    color = 'rgba(255,255,255,0.3)',
    wobbleSeed = 'underline',
    duration = 200,
    delay = 0,
    offset = 4,
  } = config;

  const rand = seededRand(wobbleSeed);
  const j = () => (rand() - 0.5) * 3;

  const y = rect.bottom + offset;
  const pts = [];
  const segments = 5;
  for (let i = 0; i <= segments; i++) {
    pts.push([rect.left + rect.width * (i / segments) + j(), y + j()]);
  }

  const path = createSvgPath(svg, pointsToSmoothPath(pts), color, 2);
  animateStrokeDash(path, duration, delay);

  return {
    elements: [path],
    destroy() { path.remove(); },
  };
}

// ═══════════════════════════════════════════
// DOODLE LIBRARY
// ═══════════════════════════════════════════

const DOODLE_LIBRARY = {
  sparkle: {
    paths: [
      // 4-pointed star
      'M 20 4 Q 21 18 36 20 Q 21 22 20 36 Q 19 22 4 20 Q 19 18 20 4',
      // Small dots around
      'M 10 8 L 10.5 8.5',
      'M 30 32 L 30.5 32.5',
    ],
  },
  checkmark: {
    paths: [
      'M 6 18 Q 10 22 14 26 Q 20 14 30 8',
    ],
  },
  alert: {
    paths: [
      // Triangle outline
      'M 20 5 L 36 33 L 4 33 Z',
      // Exclamation line and dot
      'M 20 14 L 20 23',
      'M 20 28 L 20.3 28.3',
    ],
  },
};

/**
 * Render a pre-defined SVG doodle (40×40 box) with stroke-dashoffset draw-in.
 * @param {SVGElement} svg
 * @param {string} doodleId - Key into DOODLE_LIBRARY
 * @param {Object} config - { x, y, scale, color, duration, delay }
 * @returns {{ destroy: Function }}
 */
export function createDoodle(svg, doodleId, config) {
  const doodle = DOODLE_LIBRARY[doodleId];
  if (!doodle) return { elements: [], destroy() {} };

  const {
    x = 0, y = 0,
    scale = 1,
    color = 'rgba(255,255,255,0.3)',
    duration = 200,
    delay = 0,
  } = config;

  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('transform', `translate(${x}, ${y}) scale(${scale})`);
  svg.appendChild(g);

  const elements = [g];
  doodle.paths.forEach((pathD, i) => {
    const path = createSvgPath(g, pathD, color, 2 / scale);
    animateStrokeDash(path, duration, delay + i * 80);
    elements.push(path);
  });

  return {
    elements,
    destroy() { g.remove(); },
  };
}

// ═══════════════════════════════════════════
// TUTORIAL DRAWING ENGINE
// ═══════════════════════════════════════════
//
// Hand-drawn SVG animation primitives for the onboarding tutorial.
// Replicates the fluid drawing style from the SynaBun website whiteboard section.
// Zero knowledge of tutorial steps — pure drawing utilities.
//
// Core techniques:
// - Catmull-Rom spline interpolation for smooth, organic curves
// - Seeded PRNG for deterministic wobble (same seed = same wobble every time)
// - SVG stroke-dashoffset animation for "draw-in" effect
// - CSS transitions for timing/easing

const SVG_NS = 'http://www.w3.org/2000/svg';


// ═══════════════════════════════════════════
// PORTED FUNCTIONS (from ui-whiteboard.js:964-1143)
// ═══════════════════════════════════════════

/** Seeded random for consistent wobble per element ID. */
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

    const t = 0.4;
    const cp1x = p1[0] + (p2[0] - p0[0]) * t;
    const cp1y = p1[1] + (p2[1] - p0[1]) * t;
    const cp2x = p2[0] - (p3[0] - p1[0]) * t;
    const cp2y = p2[1] - (p3[1] - p1[1]) * t;

    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

/** Convert points to a smooth CLOSED SVG path — wraps neighbors around for proper closure. */
export function closedSmoothPath(pts) {
  if (pts.length < 3) return pointsToSmoothPath(pts) + ' Z';
  const n = pts.length;
  let d = `M ${pts[0][0]} ${pts[0][1]}`;

  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];

    const t = 0.3;
    const cp1x = p1[0] + (p2[0] - p0[0]) * t;
    const cp1y = p1[1] + (p2[1] - p0[1]) * t;
    const cp2x = p2[0] - (p3[0] - p1[0]) * t;
    const cp2y = p2[1] - (p3[1] - p1[1]) * t;

    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2[0]} ${p2[1]}`;
  }
  return d + ' Z';
}

/** Smooth points using Laplacian (moving average) — preserves stroke shape, removes jitter. */
export function smoothPoints(pts, passes = 5) {
  if (pts.length <= 2) return pts;
  let result = pts;
  for (let p = 0; p < passes; p++) {
    const next = [result[0]];
    for (let i = 1; i < result.length - 1; i++) {
      const prev = result[i - 1], cur = result[i], nxt = result[i + 1];
      next.push([
        cur[0] * 0.4 + (prev[0] + nxt[0]) * 0.3,
        cur[1] * 0.4 + (prev[1] + nxt[1]) * 0.3,
      ]);
    }
    next.push(result[result.length - 1]);
    result = next;
  }
  if (result.length > 200) {
    const step = Math.ceil(result.length / 200);
    const thinned = [result[0]];
    for (let i = step; i < result.length - 1; i += step) thinned.push(result[i]);
    thinned.push(result[result.length - 1]);
    return thinned;
  }
  return result;
}

/** Generate a hand-drawn SVG path for a shape type. */
export function generateHandDrawnShape(shape, w, h, id) {
  const rand = seededRand(id || 'default');
  const j = (amt = 4) => (rand() - 0.5) * amt;
  const m = 5;

  if (shape === 'circle') {
    const cx = w / 2, cy = h / 2;
    const rx = (w / 2) - m, ry = (h / 2) - m;
    const pts = [];
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push([
        cx + Math.cos(a) * (rx + j(3)),
        cy + Math.sin(a) * (ry + j(3)),
      ]);
    }
    return closedSmoothPath(pts);
  }

  if (shape === 'pill') {
    const r = Math.min(w, h) / 2 - m;
    const pts = [];
    pts.push([m + r + j(), m + j(2)]);
    pts.push([w / 2 + j(), m + j(2)]);
    pts.push([w - m - r + j(), m + j(2)]);
    for (let i = 0; i <= 5; i++) {
      const a = -Math.PI / 2 + (i / 5) * Math.PI;
      pts.push([w - m - r + Math.cos(a) * (r + j(2)), h / 2 + Math.sin(a) * (r + j(2))]);
    }
    pts.push([w - m - r + j(), h - m + j(2)]);
    pts.push([w / 2 + j(), h - m + j(2)]);
    pts.push([m + r + j(), h - m + j(2)]);
    for (let i = 0; i <= 5; i++) {
      const a = Math.PI / 2 + (i / 5) * Math.PI;
      pts.push([m + r + Math.cos(a) * (r + j(2)), h / 2 + Math.sin(a) * (r + j(2))]);
    }
    return closedSmoothPath(pts);
  }

  // Default: rect
  const r = Math.min(12, Math.min(w, h) / 4);
  const x1 = m, y1 = m, x2 = w - m, y2 = h - m;
  return `M ${x1 + r} ${y1}`
    + ` L ${x2 - r} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y1 + r}`
    + ` L ${x2} ${y2 - r} A ${r} ${r} 0 0 1 ${x2 - r} ${y2}`
    + ` L ${x1 + r} ${y2} A ${r} ${r} 0 0 1 ${x1} ${y2 - r}`
    + ` L ${x1} ${y1 + r} A ${r} ${r} 0 0 1 ${x1 + r} ${y1}`
    + ` Z`;
}

/** Generate a drawn-circle path with overshoot tail. */
export function generateDrawnCirclePath(w, h, id) {
  const rand = seededRand(id || 'drawn');
  const j = (amt = 3) => (rand() - 0.5) * amt;
  const cx = w / 2, cy = h / 2;
  const rx = (w / 2) - 6, ry = (h / 2) - 6;

  const pts = [];
  const n = 16;
  const overshoot = 0.6;
  const totalAngle = Math.PI * 2 + overshoot;

  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = -0.2 + t * totalAngle;
    const wobble = i < n ? j(4) : j(1);
    pts.push([
      cx + Math.cos(a) * (rx + wobble),
      cy + Math.sin(a) * (ry + wobble),
    ]);
  }
  return pointsToSmoothPath(pts);
}


// ═══════════════════════════════════════════
// SVG HELPERS
// ═══════════════════════════════════════════

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
  const length = path.getTotalLength();
  path.style.strokeDasharray = String(length);
  path.style.strokeDashoffset = String(length);
  path.style.transition = `stroke-dashoffset ${duration}ms ease ${delay}ms`;
  requestAnimationFrame(() => {
    path.style.strokeDashoffset = '0';
  });
  return length;
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
    duration = 800,
    delay = 0,
    arrowheadSize = 18,
    strokeWidth = 2,
  } = config;

  const rand = seededRand(wobbleSeed);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx);
  const perpAngle = angle + Math.PI / 2;

  // Control point: gentle perpendicular offset, capped so long arrows stay tight
  const arcAmount = Math.min(dist * (0.15 + rand() * 0.1), 50);
  const cpX = (from.x + to.x) / 2 + Math.cos(perpAngle) * arcAmount;
  const cpY = (from.y + to.y) / 2 + Math.sin(perpAngle) * arcAmount;

  // Quadratic bezier — clean, predictable arc
  const pathD = `M ${from.x} ${from.y} Q ${cpX} ${cpY} ${to.x} ${to.y}`;

  const bodyPath = createSvgPath(svg, pathD, color, strokeWidth);
  bodyPath.setAttribute('stroke-linecap', 'round');
  animateStrokeDash(bodyPath, duration, delay);

  // Arrowhead: filled triangle at the tip
  // endAngle = direction the arrow is traveling at its endpoint
  const endAngle = Math.atan2(to.y - cpY, to.x - cpX);
  const s = arrowheadSize;
  const spread = 0.6;
  // Two back points of the triangle
  const lx = to.x - Math.cos(endAngle - spread) * s;
  const ly = to.y - Math.sin(endAngle - spread) * s;
  const rx = to.x - Math.cos(endAngle + spread) * s;
  const ry = to.y - Math.sin(endAngle + spread) * s;

  const head = document.createElementNS(SVG_NS, 'polyline');
  head.setAttribute('points', `${lx},${ly} ${to.x},${to.y} ${rx},${ry}`);
  head.setAttribute('fill', 'none');
  head.setAttribute('stroke', color);
  head.setAttribute('stroke-width', String(strokeWidth));
  head.setAttribute('stroke-linecap', 'round');
  head.setAttribute('stroke-linejoin', 'round');
  head.style.opacity = '0';
  head.style.transition = `opacity 0.25s ease ${delay + duration - 100}ms`;
  svg.appendChild(head);
  requestAnimationFrame(() => { head.style.opacity = '1'; });

  return {
    elements: [bodyPath, head],
    destroy() { bodyPath.remove(); head.remove(); },
  };
}


// ═══════════════════════════════════════════
// WOBBLY CIRCLE (around a target element)
// ═══════════════════════════════════════════

/**
 * Draw a hand-drawn wobbly circle around a DOMRect.
 * @param {SVGElement} svg
 * @param {DOMRect} rect - Bounding rect of the target
 * @param {Object} config - { color, padding, wobbleSeed, duration, delay }
 * @returns {{ destroy: Function }}
 */
export function createWobblyCircle(svg, rect, config) {
  const {
    color = 'rgba(255,255,255,0.3)',
    padding = 12,
    wobbleSeed = 'circle',
    duration = 700,
    delay = 0,
  } = config;

  const w = rect.width + padding * 2;
  const h = rect.height + padding * 2;
  const cx = rect.left - padding + w / 2;
  const cy = rect.top - padding + h / 2;

  const rand = seededRand(wobbleSeed);
  const j = (amt = 4) => (rand() - 0.5) * amt;

  const rx = w / 2;
  const ry = h / 2;
  const pts = [];
  const n = 16;
  const overshoot = 0.6;
  const totalAngle = Math.PI * 2 + overshoot;

  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = -0.2 + t * totalAngle;
    const wobble = i < n ? j(4) : j(1);
    pts.push([
      cx + Math.cos(a) * (rx + wobble),
      cy + Math.sin(a) * (ry + wobble),
    ]);
  }

  const pathD = pointsToSmoothPath(pts);
  const path = createSvgPath(svg, pathD, color, 2);
  animateStrokeDash(path, duration, delay);

  return {
    elements: [path],
    destroy() { path.remove(); },
  };
}


// ═══════════════════════════════════════════
// HAND-DRAWN UNDERLINE
// ═══════════════════════════════════════════

/**
 * Draw a wavy hand-drawn underline beneath a DOMRect.
 * @param {SVGElement} svg
 * @param {DOMRect} rect
 * @param {Object} config - { color, wobbleSeed, duration, delay, offset }
 * @returns {{ destroy: Function }}
 */
export function createHandDrawnUnderline(svg, rect, config) {
  const {
    color = 'rgba(255,255,255,0.3)',
    wobbleSeed = 'underline',
    duration = 500,
    delay = 0,
    offset = 4,
  } = config;

  const rand = seededRand(wobbleSeed);
  const j = () => (rand() - 0.5) * 3;

  const y = rect.bottom + offset;
  const pts = [];
  const segments = 5;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    pts.push([
      rect.left + rect.width * t + j(),
      y + j(),
    ]);
  }

  const pathD = pointsToSmoothPath(pts);
  const path = createSvgPath(svg, pathD, color, 1.5);
  animateStrokeDash(path, duration, delay);

  return {
    elements: [path],
    destroy() { path.remove(); },
  };
}


// ═══════════════════════════════════════════
// TYPEWRITER TEXT (DOM-based)
// ═══════════════════════════════════════════

/**
 * Character-by-character text reveal with blinking cursor.
 * @param {HTMLElement} container
 * @param {string} text
 * @param {Object} config - { delay, charDelay, font ('mono'|'sans'), color, onComplete }
 * @returns {{ el: HTMLElement, destroy: Function }}
 */
export function typewriterText(container, text, config) {
  const {
    delay: startDelay = 0,
    charDelay = 35,
    font = 'sans',
    color = 'rgba(255,255,255,0.6)',
    onComplete,
  } = config;

  const el = document.createElement('span');
  el.className = 'tutorial-typed';
  el.style.fontFamily = font === 'mono'
    ? "'JetBrains Mono', monospace"
    : "'Inter', -apple-system, sans-serif";
  el.style.color = color;
  el.style.fontSize = '13px';
  container.appendChild(el);

  let i = 0;
  let interval = null;
  let timer = null;

  timer = setTimeout(() => {
    el.classList.add('typing');
    interval = setInterval(() => {
      if (i < text.length) {
        el.textContent += text[i++];
      } else {
        clearInterval(interval);
        interval = null;
        el.classList.remove('typing');
        onComplete?.();
      }
    }, charDelay);
  }, startDelay);

  return {
    el,
    destroy() {
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
      el.remove();
    },
  };
}


// ═══════════════════════════════════════════
// HANDWRITTEN LABEL (SVG text with Caveat)
// ═══════════════════════════════════════════

/**
 * An SVG <text> element using Caveat font that fades in with slight scale.
 * @param {SVGElement} svg
 * @param {string} text
 * @param {Object} config - { x, y, color, fontSize, delay, duration }
 * @returns {{ destroy: Function }}
 */
export function handwrittenLabel(svg, text, config) {
  const {
    x = 0, y = 0,
    color = 'rgba(255,255,255,0.4)',
    fontSize = 18,
    delay: startDelay = 0,
    duration = 400,
    maxWidth = 0,
    lineHeight = 1.3,
  } = config;

  const textEl = document.createElementNS(SVG_NS, 'text');
  textEl.setAttribute('x', String(x));
  textEl.setAttribute('y', String(y));
  textEl.setAttribute('fill', color);
  textEl.setAttribute('font-family', "'Caveat', cursive");
  textEl.setAttribute('font-size', String(fontSize));
  if (config.textAnchor) textEl.setAttribute('text-anchor', config.textAnchor);

  // Multiline: wrap text into <tspan> rows when maxWidth is set
  if (maxWidth > 0) {
    const words = text.split(' ');
    const lines = [];
    let cur = '';
    // Approximate char width for Caveat at this size (roughly 0.55em)
    const charW = fontSize * 0.55;
    const maxChars = Math.floor(maxWidth / charW);
    for (const word of words) {
      const test = cur ? cur + ' ' + word : word;
      if (test.length > maxChars && cur) {
        lines.push(cur);
        cur = word;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);

    const dy = fontSize * lineHeight;
    lines.forEach((line, i) => {
      const tspan = document.createElementNS(SVG_NS, 'tspan');
      tspan.setAttribute('x', String(x));
      tspan.setAttribute('dy', i === 0 ? '0' : String(dy));
      tspan.textContent = line;
      textEl.appendChild(tspan);
    });
  } else {
    textEl.textContent = text;
  }

  // Start invisible + slightly scaled (use transform-box so origin is the text's own bbox)
  textEl.style.opacity = '0';
  textEl.style.transformBox = 'fill-box';
  textEl.style.transformOrigin = 'center center';
  textEl.style.transform = 'scale(0.85)';
  textEl.style.transition = `opacity ${duration}ms ease ${startDelay}ms, transform ${duration}ms cubic-bezier(0.22, 1, 0.36, 1) ${startDelay}ms`;

  svg.appendChild(textEl);

  requestAnimationFrame(() => {
    textEl.style.opacity = '1';
    textEl.style.transform = 'scale(1)';
  });

  return {
    elements: [textEl],
    destroy() { textEl.remove(); },
  };
}


// ═══════════════════════════════════════════
// DOODLE LIBRARY
// ═══════════════════════════════════════════

const DOODLE_LIBRARY = {
  sparkle: {
    viewBox: [0, 0, 40, 40],
    paths: [
      // 4-pointed star
      'M 20 4 Q 21 18 36 20 Q 21 22 20 36 Q 19 22 4 20 Q 19 18 20 4',
      // Small dots around
      'M 10 8 L 10.5 8.5',
      'M 30 8 L 30.5 8.5',
      'M 10 32 L 10.5 32.5',
      'M 30 32 L 30.5 32.5',
    ],
  },
  checkmark: {
    viewBox: [0, 0, 36, 36],
    paths: [
      'M 6 18 Q 10 22 14 26 Q 20 14 30 8',
    ],
  },
  star: {
    viewBox: [0, 0, 40, 40],
    paths: [
      'M 20 4 L 24 15 L 36 16 L 27 24 L 30 36 L 20 29 L 10 36 L 13 24 L 4 16 L 16 15 Z',
    ],
  },
  'arrow-squiggle': {
    viewBox: [0, 0, 60, 30],
    paths: [
      'M 4 20 Q 15 6 25 18 Q 35 30 45 16 L 56 12',
      'M 50 6 L 56 12 L 50 18',
    ],
  },
  heart: {
    viewBox: [0, 0, 36, 34],
    paths: [
      'M 18 30 Q 4 20 4 12 Q 4 4 11 4 Q 16 4 18 10 Q 20 4 25 4 Q 32 4 32 12 Q 32 20 18 30',
    ],
  },
  wave: {
    viewBox: [0, 0, 60, 20],
    paths: [
      'M 4 10 Q 12 2 20 10 Q 28 18 36 10 Q 44 2 52 10',
    ],
  },
};

/**
 * Render a pre-defined SVG doodle with stroke-dashoffset draw-in animation.
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
    duration = 600,
    delay: startDelay = 0,
  } = config;

  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('transform', `translate(${x}, ${y}) scale(${scale})`);
  svg.appendChild(g);

  const elements = [g];
  doodle.paths.forEach((pathD, i) => {
    const path = createSvgPath(g, pathD, color, 1.5);
    const perPathDelay = startDelay + i * 120;
    animateStrokeDash(path, duration, perPathDelay);
    elements.push(path);
  });

  return {
    elements,
    destroy() { g.remove(); },
  };
}

/** Get all available doodle IDs. */
export function getDoodleIds() {
  return Object.keys(DOODLE_LIBRARY);
}


// ═══════════════════════════════════════════
// SPOTLIGHT MASK
// ═══════════════════════════════════════════

/**
 * Create an SVG mask with a hand-drawn cutout around a target rect.
 * Returns the mask group + backdrop rect for controlling visibility.
 * @param {SVGElement} svg
 * @param {DOMRect|null} targetRect - null for fullscreen (no cutout)
 * @param {Object} config - { padding, wobbleSeed }
 * @returns {{ update: Function, destroy: Function }}
 */
export function createSpotlight(svg, targetRect, config) {
  const {
    padding = 16,
    wobbleSeed = 'spotlight',
  } = config;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Defs + mask
  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs');
    svg.prepend(defs);
  }

  const maskId = 'tutorial-spotlight-mask';
  const mask = document.createElementNS(SVG_NS, 'mask');
  mask.id = maskId;

  // White full rect (shows everything as dimmed)
  const maskBg = document.createElementNS(SVG_NS, 'rect');
  maskBg.setAttribute('x', '0');
  maskBg.setAttribute('y', '0');
  maskBg.setAttribute('width', String(vw));
  maskBg.setAttribute('height', String(vh));
  maskBg.setAttribute('fill', 'white');
  mask.appendChild(maskBg);

  // Black cutout (reveals the target area)
  let cutout = null;
  if (targetRect) {
    cutout = document.createElementNS(SVG_NS, 'rect');
    cutout.setAttribute('x', String(targetRect.left - padding));
    cutout.setAttribute('y', String(targetRect.top - padding));
    cutout.setAttribute('width', String(targetRect.width + padding * 2));
    cutout.setAttribute('height', String(targetRect.height + padding * 2));
    cutout.setAttribute('rx', '12');
    cutout.setAttribute('ry', '12');
    cutout.setAttribute('fill', 'black');
    mask.appendChild(cutout);
  }

  defs.appendChild(mask);

  // Dimmed backdrop rect
  const backdrop = document.createElementNS(SVG_NS, 'rect');
  backdrop.setAttribute('x', '0');
  backdrop.setAttribute('y', '0');
  backdrop.setAttribute('width', String(vw));
  backdrop.setAttribute('height', String(vh));
  backdrop.setAttribute('fill', 'rgba(0,0,0,0.6)');
  backdrop.setAttribute('mask', `url(#${maskId})`);
  backdrop.style.opacity = '0';
  backdrop.style.transition = 'opacity 0.4s cubic-bezier(0.4, 0, 0.2, 1)';

  // Insert backdrop as first child so drawings render on top
  if (svg.firstChild && svg.firstChild !== defs) {
    svg.insertBefore(backdrop, svg.firstChild.nextSibling);
  } else {
    svg.appendChild(backdrop);
  }

  // Fade in
  requestAnimationFrame(() => {
    backdrop.style.opacity = '1';
  });

  return {
    update(newRect) {
      if (cutout && newRect) {
        cutout.setAttribute('x', String(newRect.left - padding));
        cutout.setAttribute('y', String(newRect.top - padding));
        cutout.setAttribute('width', String(newRect.width + padding * 2));
        cutout.setAttribute('height', String(newRect.height + padding * 2));
      }
      // Update viewport size
      maskBg.setAttribute('width', String(window.innerWidth));
      maskBg.setAttribute('height', String(window.innerHeight));
      backdrop.setAttribute('width', String(window.innerWidth));
      backdrop.setAttribute('height', String(window.innerHeight));
    },
    fadeOut(cb) {
      backdrop.style.opacity = '0';
      setTimeout(() => cb?.(), 400);
    },
    destroy() {
      backdrop.remove();
      mask.remove();
    },
  };
}


// ═══════════════════════════════════════════
// TARGET RESOLUTION
// ═══════════════════════════════════════════

/** Resolve a CSS selector to a DOMRect. Returns null if not found or invisible. */
export function resolveTargetRect(selector) {
  if (!selector) return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return rect;
}

/** Resolve a named anchor position on a DOMRect. */
export function resolveAnchorPoint(rect, anchor) {
  const map = {
    'top-left':      { x: rect.left, y: rect.top },
    'top-center':    { x: rect.left + rect.width / 2, y: rect.top },
    'top-right':     { x: rect.right, y: rect.top },
    'center-left':   { x: rect.left, y: rect.top + rect.height / 2 },
    'center':        { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    'center-right':  { x: rect.right, y: rect.top + rect.height / 2 },
    'bottom-left':   { x: rect.left, y: rect.bottom },
    'bottom-center': { x: rect.left + rect.width / 2, y: rect.bottom },
    'bottom-right':  { x: rect.right, y: rect.bottom },
  };
  return map[anchor] || map['center'];
}

/** Convert viewport-relative coordinates (0-1) to absolute pixels. */
export function resolveRelativePoint(point) {
  return {
    x: point.x * window.innerWidth,
    y: point.y * window.innerHeight,
  };
}


// ═══════════════════════════════════════════
// ANIMATION SEQUENCER
// ═══════════════════════════════════════════

/**
 * Lightweight promise-based animation sequencer.
 * Queues animation functions with delays and plays them in order.
 * Each function should return a { destroy } handle (or void).
 */
export class AnimationSequencer {
  constructor() {
    this._queue = [];
    this._cleanup = [];
    this._cancelled = false;
  }

  /** Add an animation function with a delay before it runs (ms). */
  add(fn, delay = 0) {
    this._queue.push({ fn, delay });
    return this;
  }

  /** Play all queued animations in order. */
  async play() {
    for (const { fn, delay } of this._queue) {
      if (this._cancelled) return;
      if (delay > 0) await this._wait(delay);
      if (this._cancelled) return;
      const result = fn();
      if (result && typeof result.destroy === 'function') {
        this._cleanup.push(result.destroy);
      }
    }
  }

  /** Cancel all pending and clean up completed animations. */
  cancel() {
    this._cancelled = true;
    this._cleanup.forEach(fn => fn());
    this._cleanup = [];
  }

  _wait(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, ms);
      this._cleanup.push(() => clearTimeout(timer));
    });
  }
}

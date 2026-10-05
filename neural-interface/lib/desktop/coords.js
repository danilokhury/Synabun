// ═══════════════════════════════════════════
// SynaBun — Desktop coordinates (screenshot pixels ↔ global display points)
// ═══════════════════════════════════════════
//
// Every helper coordinate is a Quartz global display point (origin top-left of
// the main display, y down; secondary displays may sit at negative origins).
// Models see a screenshot fitted into a box (1280×800 by default), so their
// pixel coordinates are mapped back through the capture bounds of THAT frame:
//   f = min(fitW/W, fitH/H, scale); image = round(W·f) × round(H·f)
//   X = ox + (x + 0.5)·W/Wimg      Y = oy + (y + 0.5)·H/Himg
// Never assume points × 2: scaled display modes break that.

export function fitSize({ w, h }, fit = { w: 1280, h: 800 }, scale = 2) {
  const f = Math.min(fit.w / w, fit.h / h, scale > 0 ? scale : 1);
  return { w: Math.max(1, Math.round(w * f)), h: Math.max(1, Math.round(h * f)), f };
}

/** Screenshot pixel → global point, or null when outside the image. */
export function imageToPoint(frame, x, y) {
  const img = frame?.image;
  const b = frame?.bounds;
  if (!img || !b || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return null;
  return {
    x: Math.round((b.x + (x + 0.5) * (b.w / img.w)) * 100) / 100,
    y: Math.round((b.y + (y + 0.5) * (b.h / img.h)) * 100) / 100,
  };
}

/** Global point → screenshot pixel (clamped), for cursor positions and markers. */
export function pointToImage(frame, X, Y) {
  const img = frame?.image;
  const b = frame?.bounds;
  if (!img || !b) return null;
  const x = Math.floor((X - b.x) * (img.w / b.w));
  const y = Math.floor((Y - b.y) * (img.h / b.h));
  return { x: Math.min(img.w - 1, Math.max(0, x)), y: Math.min(img.h - 1, Math.max(0, y)), inside: X >= b.x && Y >= b.y && X < b.x + b.w && Y < b.y + b.h };
}

/** [x1,y1,x2,y2] in screenshot pixels → a point-space rect (normalized, clamped to the frame). */
export function regionToRect(frame, region) {
  if (!Array.isArray(region) || region.length !== 4) return null;
  const img = frame?.image;
  if (!img) return null;
  const clampX = (v) => Math.min(img.w - 1, Math.max(0, Number(v)));
  const clampY = (v) => Math.min(img.h - 1, Math.max(0, Number(v)));
  const [x1, y1, x2, y2] = [clampX(region[0]), clampY(region[1]), clampX(region[2]), clampY(region[3])];
  const a = imageToPoint(frame, Math.min(x1, x2), Math.min(y1, y2));
  const b = imageToPoint(frame, Math.max(x1, x2), Math.max(y1, y2));
  if (!a || !b) return null;
  return { x: a.x, y: a.y, w: Math.max(1, b.x - a.x), h: Math.max(1, b.y - a.y) };
}

/**
 * Agent targets inside the failsafe square (top-left of the main display)
 * are nudged out of it, so only the user's own hand can trigger the stop.
 */
export function nudgeFromCorner(point, { cornerSizePt = 4, mainOrigin = { x: 0, y: 0 } } = {}) {
  if (!point) return point;
  const limit = cornerSizePt + 1;
  if (point.x - mainOrigin.x < limit && point.y - mainOrigin.y < limit) {
    return { x: Math.max(point.x, mainOrigin.x + limit), y: Math.max(point.y, mainOrigin.y + limit) };
  }
  return point;
}

/** Anthropic scroll_direction + amount → helper dx/dy in lines (dy>0 = down). */
export function scrollDelta(direction, amount = 3) {
  const n = Math.max(1, Math.min(30, Math.round(Number(amount) || 3)));
  switch (String(direction || 'down').toLowerCase()) {
    case 'up': return { dx: 0, dy: -n };
    case 'left': return { dx: -n, dy: 0 };
    case 'right': return { dx: n, dy: 0 };
    default: return { dx: 0, dy: n };
  }
}

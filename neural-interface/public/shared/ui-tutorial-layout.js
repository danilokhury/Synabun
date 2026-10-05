// Pure viewport geometry; no storage, DOM or product state.
const MARGIN = 16;   // the note keeps this far from the viewport edges
const GAP = 56;      // room for the arrow between the note and its target
const CLEAR = 32;    // how far the note stays from chrome it steps aside for (the arrow still fits)

export function visibleRect(rect, width, height) {
  return !!rect && rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0
    && rect.right <= width && rect.bottom <= height;
}

export function overlaps(a, b, gap = 0) {
  return a.left < b.right + gap && a.right > b.left - gap
    && a.top < b.bottom + gap && a.bottom > b.top - gap;
}

export function overlapArea(a, b) {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

// How much of the straight line from a to b runs inside rect (Liang–Barsky clipping).
export function lengthInside(a, b, rect) {
  const dx = b.x - a.x, dy = b.y - a.y;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, a.x - rect.left], [dx, rect.right - a.x], [-dy, a.y - rect.top], [dy, rect.bottom - a.y]]) {
    if (p === 0) { if (q < 0) return 0; continue; }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
  }
  return t1 > t0 ? (t1 - t0) * Math.hypot(dx, dy) : 0;
}

export function unionRect(rects) {
  const list = rects.filter(Boolean);
  if (!list.length) return null;
  const left = Math.min(...list.map(r => r.left)), top = Math.min(...list.map(r => r.top));
  const right = Math.max(...list.map(r => r.right)), bottom = Math.max(...list.map(r => r.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

// A compact, squarish target gets a ring; anything long or tall gets a box that hugs it.
export function outlineShape(rect) {
  const long = Math.max(rect.width, rect.height), short = Math.min(rect.width, rect.height);
  return long <= 72 && long / Math.max(short, 1) <= 1.6 ? 'ring' : 'box';
}

// The rect the outline is drawn on: the target plus its padding, kept inside the viewport.
// A ring has to clear the corners of the rect it circles (√2 of each half side).
export function outlineRect(rect, width, height, shape = outlineShape(rect)) {
  const padX = shape === 'ring' ? rect.width * 0.21 + 3 : 5;
  const padY = shape === 'ring' ? rect.height * 0.21 + 3 : 5;
  const left = Math.max(3, rect.left - padX), top = Math.max(3, rect.top - padY);
  const right = Math.min(width - 3, rect.right + padX), bottom = Math.min(height - 3, rect.bottom + padY);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * Where the note goes. `avoid` rects are never covered (the open dropdown that
 * holds the target); `keep` rects are chrome the note leaves visible when there
 * is free space (title bar, toolbars, session pills). Candidates sit on each
 * side of the target, and of an `avoid` rect that contains it, at three alignments.
 * `near` is where the note is now: between two close calls, the shorter move wins.
 */
export function placeNote(target, width, height, noteWidth, noteHeight, { avoid = [], keep = [], near = null } = {}) {
  const w = Math.min(noteWidth, width - MARGIN * 2);
  const h = Math.min(noteHeight, height - MARGIN * 2);
  const clamp = (v, min, max) => Math.max(min, Math.min(v, max));
  const box = (x, y, bw = w, bh = h) => {
    const left = clamp(x, MARGIN, Math.max(MARGIN, width - bw - MARGIN));
    const top = clamp(y, MARGIN, Math.max(MARGIN, height - bh - MARGIN));
    return { left, top, right: left + bw, bottom: top + bh, width: bw, height: bh };
  };
  if (!target) return box((width - w) / 2, (height - h) / 2);

  const boxes = [];
  const anchors = [target, ...avoid.filter(r => overlaps(r, target))];
  for (const a of anchors) {
    for (const align of [0.5, 0, 1]) {
      const y = target.top + (target.height - h) * align, x = target.left + (target.width - w) * align;
      boxes.push(box(a.right + GAP, y), box(a.left - w - GAP, y), box(x, a.bottom + GAP), box(x, a.top - h - GAP));
    }
  }
  // A candidate that covers chrome is also tried just clear of it, on each side: with room
  // for the arrow, and tight for a narrow gap. Twice, for a spot wedged between two pieces.
  const clearOf = (list) => list.flatMap(b => keep.filter(r => overlaps(b, r)).flatMap(r => [CLEAR, 12].flatMap(c => [
    box(b.left, r.bottom + c), box(b.left, r.top - h - c), box(r.left - w - c, b.top), box(r.right + c, b.top)])));
  const cleared = clearOf(boxes);
  const unique = new Map([...boxes, ...cleared, ...clearOf(cleared)].map(b => [`${Math.round(b.left)},${Math.round(b.top)}`, b]));
  const tc = { x: target.left + target.width / 2, y: target.top + target.height / 2 };
  // The arrow should not run across the menu the target sits in, over its other entries,
  // and would rather not cross other chrome on its way.
  const arrow = (b) => {
    const { from, to } = arrowPoints(b, target);
    const across = (rects) => rects.reduce((sum, r) => sum + lengthInside(from, to, r), 0);
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    // Short is good, but an arrow needs room to read as one.
    return length + Math.max(0, 28 - length) * 6 + across(avoid) * 4 + across(keep) * 2;
  };
  // Lowest wins: covering nothing, then a short arrow that crosses nothing, then nearness.
  const score = (b) => (overlaps(b, target, 20) ? 1e9 : 0)
    + avoid.filter(r => overlaps(b, r, 12)).length * 1e8
    + keep.reduce((sum, r) => sum + overlapArea(b, r), 0) * 10
    + arrow(b)
    + Math.hypot(b.left + b.width / 2 - tc.x, b.top + b.height / 2 - tc.y) * 0.1
    + (near ? Math.hypot(b.left - near.left, b.top - near.top) * 0.1 : 0);
  let best = [...unique.values()].map(b => ({ ...b, score: score(b) })).sort((a, b) => a.score - b.score)[0];
  // Too narrow to sit beside the target: keep it exposed and let the note
  // scroll in whichever space above or below is taller.
  if (best.score >= 1e9) {
    const below = height - target.bottom - 16 - MARGIN, above = target.top - 16 - MARGIN;
    const room = Math.max(below, above);
    if (room >= 96) {
      const bh = Math.min(h, room);
      best = box((width - w) / 2, below >= above ? target.bottom + 16 : target.top - 16 - bh, w, bh);
    }
  }
  return best;
}

// From the note's facing edge to the target's, stopping outside its outline.
export function arrowPoints(note, target, pad = 10) {
  const clamp = (v, min, max) => Math.max(min, Math.min(v, Math.max(min, max)));
  const tc = { x: target.left + target.width / 2, y: target.top + target.height / 2 };
  const inset = 28;
  if (note.left >= target.right || note.right <= target.left) {
    const right = note.left >= target.right;
    const y = clamp(tc.y, note.top + inset, note.bottom - inset);
    return { from: { x: right ? note.left - 6 : note.right + 6, y },
      to: { x: right ? target.right + pad : target.left - pad, y: clamp(y, target.top, target.bottom) } };
  }
  const below = note.top >= target.bottom;
  const x = clamp(tc.x, note.left + inset, note.right - inset);
  return { from: { x, y: below ? note.top - 6 : note.bottom + 6 },
    to: { x: clamp(x, target.left, target.right), y: below ? target.bottom + pad : target.top - pad } };
}

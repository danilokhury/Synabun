// Pure viewport geometry the Workspace tour asks of a control's rect; no storage, DOM or product state.

/** The rect is on screen, whole: a control the tour may ring and point at. */
export function visibleRect(rect, width, height) {
  return !!rect && rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0
    && rect.right <= width && rect.bottom <= height;
}

export function overlaps(a, b, gap = 0) {
  return a.left < b.right + gap && a.right > b.left - gap
    && a.top < b.bottom + gap && a.bottom > b.top - gap;
}

/** One rect around several (a run of controls: the effort and permission pills). */
export function unionRect(rects) {
  const list = rects.filter(Boolean);
  if (!list.length) return null;
  const left = Math.min(...list.map(r => r.left)), top = Math.min(...list.map(r => r.top));
  const right = Math.max(...list.map(r => r.right)), bottom = Math.max(...list.map(r => r.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}
